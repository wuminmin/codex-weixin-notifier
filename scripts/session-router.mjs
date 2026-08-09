#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { localSessionViews } from "./codex-task-monitor.mjs";

const RUNNERS = new Set(["codex", "claude", "opencode"]);
const LABELS = { codex: "Codex", claude: "Claude Code", opencode: "opencode" };
const ACTIVE_STATUSES = new Set(["starting", "running", "waiting"]);
const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_PICKER_TTL_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function stateDir(config) {
  return expandHome(config?.stateDir || process.env.CODEX_WEIXIN_STATE_DIR || path.join(os.homedir(), ".codex", "weixin-notifier"));
}

function statePath(config) {
  return path.join(stateDir(config), "session-bridges.json");
}

function currentPath(config) {
  return path.join(stateDir(config), "session-current.json");
}

function pickerPath(config) {
  return path.join(stateDir(config), "session-picker.json");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function now() {
  return new Date().toISOString();
}

function userKey(fromUser) {
  return String(fromUser || "local");
}

function compact(value, max = 180) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeTime(value) {
  const elapsed = Math.max(0, Date.now() - timestampMs(value));
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function runnerForView(view) {
  if (view.source === "claude") return "claude";
  if (view.source === "opencode") return "opencode";
  return "codex";
}

function sessionKey(runner, sessionId) {
  return `${runner}:${sessionId}`;
}

function bridgeId() {
  return `bridge-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeState(state) {
  const value = state && typeof state === "object" ? state : {};
  value.bridges = value.bridges && typeof value.bridges === "object" ? value.bridges : {};
  return value;
}

function loadState(config) {
  return normalizeState(readJson(statePath(config), { version: 1, bridges: {} }));
}

function saveState(config, state) {
  state.updatedAt = now();
  writeJson(statePath(config), normalizeState(state));
  return state;
}

function loadCurrent(config) {
  const value = readJson(currentPath(config), { users: {} });
  value.users = value.users && typeof value.users === "object" ? value.users : {};
  return value;
}

function saveCurrent(config, current) {
  writeJson(currentPath(config), { version: 1, users: current.users || {}, updatedAt: now() });
}

function loadPicker(config) {
  const value = readJson(pickerPath(config), { users: {} });
  value.users = value.users && typeof value.users === "object" ? value.users : {};
  return value;
}

function savePicker(config, picker) {
  writeJson(pickerPath(config), { version: 1, users: picker.users || {}, updatedAt: now() });
}

function currentBridge(config, fromUser) {
  const key = loadCurrent(config).users[userKey(fromUser)]?.bridgeKey;
  if (!key) return null;
  return loadState(config).bridges[key] || null;
}

function setCurrent(config, fromUser, bridge) {
  const current = loadCurrent(config);
  current.users[userKey(fromUser)] = bridge
    ? {
      bridgeKey: bridge.key,
      runner: bridge.runner,
      sessionId: bridge.sessionId || "",
      updatedAt: now(),
    }
    : { bridgeKey: "", runner: "", sessionId: "", updatedAt: now() };
  saveCurrent(config, current);
}

function commandPath(config, runner) {
  if (runner === "codex") return String(config?.codexCommand || process.env.CODEX_WEIXIN_CODEX_COMMAND || "codex");
  if (runner === "claude") return String(config?.claudeCommand || process.env.CODEX_WEIXIN_CLAUDE_COMMAND || "claude");
  return String(config?.opencodeCommand || process.env.CODEX_WEIXIN_OPENCODE_COMMAND || "opencode");
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/gu, "'\\''")}'`;
}

function commandExists(command) {
  if (String(command).includes("/")) {
    try {
      fs.accessSync(expandHome(command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { stdio: "ignore" }).status === 0;
}

function configuredCodexArgs(config, cwd, sessionId = "") {
  const args = [];
  if (!Array.isArray(config?.codexGlobalArgs)) args.push("--no-alt-screen");
  else args.push(...config.codexGlobalArgs);
  if (!args.includes("--no-alt-screen")) args.unshift("--no-alt-screen");
  if (!args.includes("-C") && !args.some((item) => String(item).startsWith("--cd="))) args.push("-C", cwd);
  if (!args.some((item) => String(item).startsWith("--sandbox") || item === "-s")) {
    if (config?.codexBypassSandbox === true) args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("--sandbox", config?.codexSandbox || "workspace-write", "--ask-for-approval", "never");
  }
  if (sessionId) args.push("resume", sessionId);
  return args;
}

function commandForBridge(bridge, config) {
  const command = commandPath(config, bridge.runner);
  if (bridge.runner === "codex") return { command, args: configuredCodexArgs(config, bridge.cwd, bridge.sessionId) };
  if (bridge.runner === "claude") return { command, args: bridge.sessionId ? ["--resume", bridge.sessionId] : [] };
  return { command, args: bridge.sessionId ? ["-s", bridge.sessionId] : [] };
}

function tmuxName(config, bridge) {
  const prefix = String(config?.tmuxPrefix || "codex-wx").replace(/[^A-Za-z0-9_-]+/gu, "-");
  const hash = crypto.createHash("sha1").update(`${config?.namespace || "default"}:${bridge.key}`).digest("hex").slice(0, 12);
  return `${prefix}-session-${hash}`.slice(0, 80);
}

function tmuxHasSession(name) {
  return Boolean(name) && spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
}

function tmuxPane(name, config) {
  const lines = Math.max(20, Number(config?.sessionCaptureLines || 160));
  const result = spawnSync("tmux", ["capture-pane", "-p", "-t", name, "-S", `-${lines}`], {
    encoding: "utf8",
    maxBuffer: 512 * 1024,
  });
  return result.status === 0 ? String(result.stdout || "") : "";
}

function tmuxSend(name, text) {
  const literal = spawnSync("tmux", ["send-keys", "-t", name, "-l", String(text)], { encoding: "utf8" });
  if (literal.status !== 0) throw new Error(literal.stderr || "tmux send-keys failed");
  const enter = spawnSync("tmux", ["send-keys", "-t", name, "C-m"], { encoding: "utf8" });
  if (enter.status !== 0) throw new Error(enter.stderr || "tmux enter failed");
}

function tmuxChoice(name, choice) {
  for (let index = 1; index < choice; index += 1) {
    const result = spawnSync("tmux", ["send-keys", "-t", name, "Down"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "tmux choice navigation failed");
  }
  const result = spawnSync("tmux", ["send-keys", "-t", name, "C-m"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "tmux choice submit failed");
}

function cleanPane(text) {
  return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, "")
    .split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean).join("\n").trim();
}

function parseChoice(text) {
  const lines = cleanPane(text).split(/\r?\n/u);
  const start = lines.findIndex((line) => /Question\s+\d+\/\d+|(?:select|choose|which)\b|需要选择|请选择/iu.test(line));
  if (start < 0) return null;
  const options = [];
  for (const line of lines.slice(start, start + 24)) {
    const match = line.match(/^\s*(?:[>›•*]\s*)?(\d+)[.)：:]\s+(.+?)\s*$/u);
    if (match) options.push({ number: Number(match[1]), text: compact(match[2], 240) });
  }
  if (options.length < 2) return null;
  const question = lines.slice(start, Math.min(lines.length, start + 12)).join("\n").trim();
  return { question, options, signature: `${question}\n${options.map((item) => `${item.number}:${item.text}`).join("|")}` };
}

function isBusy(text) {
  return /Working\s*\(|esc to interrupt|ctrl\+c to interrupt|正在处理|思考中|调用工具/iu.test(text);
}

function isDone(text, previous) {
  const cleaned = cleanPane(text);
  if (!cleaned || cleaned === previous || isBusy(cleaned)) return false;
  if (/\bWorked\b|任务完成|已完成/iu.test(cleaned)) return true;
  const tail = cleaned.split(/\r?\n/u).slice(-8).join("\n");
  return /^(?:›|❯|>)\s*$/mu.test(tail) || /(?:›|❯|>)\s*$/u.test(tail);
}

function sessionCwd(config, runner) {
  const configured = runner === "codex"
    ? (config?.codexCwd || process.env.CODEX_WEIXIN_CODEX_CWD)
    : (config?.toolCwd || config?.codexCwd || process.env.CODEX_TOOL_CWD || process.env.CODEX_WEIXIN_CODEX_CWD);
  const cwd = expandHome(configured || os.homedir());
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

function normalizeView(view) {
  const runner = runnerForView(view);
  const sessionId = String(view.sessionId || "").trim();
  if (!sessionId) return null;
  return {
    key: sessionKey(runner, sessionId),
    runner,
    sessionId,
    source: view.source,
    cwd: view.cwd || os.homedir(),
    status: view.status || "completed",
    stage: view.stage || "本轮已完成",
    prompt: view.prompt || "",
    summary: view.summary || "",
    createdAt: view.createdAt || "",
    updatedAt: view.updatedAt || view.completedAt || view.createdAt || "",
  };
}

export function sessionViews() {
  const merged = new Map();
  for (const raw of localSessionViews()) {
    const view = normalizeView(raw);
    if (!view) continue;
    const previous = merged.get(view.key);
    if (!previous || timestampMs(view.updatedAt) >= timestampMs(previous.updatedAt)) merged.set(view.key, view);
  }
  return [...merged.values()].sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
}

function bridgeForView(config, view) {
  const state = loadState(config);
  return state.bridges[view.key] || null;
}

function createBridge(config, input) {
  const timestamp = now();
  const id = input.bridgeId || bridgeId();
  const key = input.key || `bridge:${id}`;
  const bridge = {
    key,
    bridgeId: id,
    runner: input.runner,
    sessionId: input.sessionId || "",
    source: input.source || "mobile",
    cwd: expandHome(input.cwd || sessionCwd(config, input.runner)),
    dataDir: path.join(stateDir(config), "sessions", id),
    status: "starting",
    prompt: "",
    summary: input.summary || "",
    tmuxSession: "",
    activeReplyContext: null,
    interactiveWatch: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const state = loadState(config);
  state.bridges[key] = bridge;
  saveState(config, state);
  return bridge;
}

function updateBridge(config, key, updater) {
  const state = loadState(config);
  if (!state.bridges[key]) return null;
  const updated = updater({ ...state.bridges[key], updatedAt: now() });
  updated.updatedAt = now();
  state.bridges[key] = updated;
  saveState(config, state);
  return updated;
}

function ensureBridge(config, bridge) {
  if (bridge.tmuxSession && tmuxHasSession(bridge.tmuxSession)) return bridge;
  const command = commandPath(config, bridge.runner);
  if (!commandExists(command)) throw new Error(`${LABELS[bridge.runner]} 未安装：${command}`);
  if (!commandExists("tmux")) throw new Error("tmux 未安装，无法启动手机会话");
  const sessionName = tmuxName(config, bridge);
  if (!tmuxHasSession(sessionName)) {
    const invocation = commandForBridge(bridge, config);
    const result = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", bridge.cwd, invocation.command, ...invocation.args], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `tmux exit ${result.status}`);
  }
  return updateBridge(config, bridge.key, (current) => ({
    ...current,
    tmuxSession: sessionName,
    status: "ready",
  })) || { ...bridge, tmuxSession: sessionName, status: "ready" };
}

function pickerItems(config, fromUser) {
  const picker = loadPicker(config);
  const item = picker.users[userKey(fromUser)];
  if (!item || timestampMs(item.expiresAt) <= Date.now()) return null;
  return item.items || [];
}

function setPicker(config, fromUser, views) {
  const picker = loadPicker(config);
  picker.users[userKey(fromUser)] = {
    expiresAt: new Date(Date.now() + DEFAULT_PICKER_TTL_MS).toISOString(),
    items: views.map((view, index) => ({ index: index + 1, key: view.key, runner: view.runner, sessionId: view.sessionId })),
    updatedAt: now(),
  };
  savePicker(config, picker);
}

function statusLabel(status) {
  return {
    running: "执行中",
    waiting: "等待选择",
    starting: "启动中",
    ready: "空闲",
    completed: "已完成",
    failed: "失败",
  }[status] || status || "未知";
}

export function formatSessionHistory(config, fromUser = "") {
  const views = sessionViews().slice(0, DEFAULT_HISTORY_LIMIT);
  setPicker(config, fromUser, views);
  if (views.length === 0) return "历史会话：没有找到最近 30 天内的会话。发送 新会话 开始工作。";
  const current = currentBridge(config, fromUser);
  const lines = [`历史会话 · ${views.length} 个`, "发送：接管 2 · 继续某个会话"];
  for (const [index, view] of views.entries()) {
    const active = current && current.runner === view.runner && current.sessionId === view.sessionId ? " · 当前" : "";
    lines.push(
      `${index + 1}. ${LABELS[view.runner]} · ${statusLabel(view.status)}${active}`,
      `   目录：${view.cwd || "未知"}`,
      `   内容：${compact(view.prompt || view.summary || "（暂无摘要）", 120)}`,
      `   更新：${relativeTime(view.updatedAt)}`,
    );
  }
  return lines.join("\n");
}

function formatCurrent(config, fromUser) {
  const bridge = currentBridge(config, fromUser);
  if (!bridge) return "当前没有手机会话。发送 历史 查看历史，或发送 新会话 开始新的会话。";
  return [
    `当前会话：${LABELS[bridge.runner]}`,
    `状态：${statusLabel(bridge.status)}`,
    `目录：${bridge.cwd}`,
    bridge.sessionId ? `session：${bridge.sessionId}` : `bridge：${bridge.bridgeId}`,
    bridge.tmuxSession ? `tmux：${bridge.tmuxSession}` : null,
  ].filter(Boolean).join("\n");
}

function parseRunner(value) {
  const runner = String(value || "codex").toLowerCase();
  return RUNNERS.has(runner) ? runner : "";
}

export function parseSessionCommand(text) {
  const trimmed = String(text || "").trim();
  if (/^(?:历史|会话|history|sessions?)$/iu.test(trimmed)) return { type: "list" };
  if (/^(?:当前会话|session\s+current|current\s+session)$/iu.test(trimmed)) return { type: "current" };
  if (/^(?:退出接管|取消接管|session\s+off|unhook)$/iu.test(trimmed)) return { type: "off" };
  const takeover = trimmed.match(/^(?:接管|takeover|resume)\s+(\d+)$/iu);
  if (takeover) return { type: "takeover", index: Number(takeover[1]) };
  const fresh = trimmed.match(/^(?:新会话|新建会话|new\s+session)(?:\s+(codex|claude|opencode))?$/iu);
  if (fresh) return { type: "new", runner: parseRunner(fresh[1] || "codex") };
  return null;
}

function sessionReply(bridge, status, output = "") {
  return [
    `${LABELS[bridge.runner]} 会话 · ${status}`,
    bridge.sessionId ? `session：${bridge.sessionId}` : `bridge：${bridge.bridgeId}`,
    output ? `\n${compact(output, 8000)}` : null,
  ].filter(Boolean).join("\n");
}

function serializableContext(deps, config, replyConfig) {
  return deps.serializableReplyContext ? deps.serializableReplyContext(replyConfig || config) : null;
}

function replyConfigFor(bridge, config, deps) {
  return deps.configWithReplyContext && bridge.activeReplyContext
    ? deps.configWithReplyContext(config, bridge.activeReplyContext)
    : config;
}

function saveBridge(config, bridge) {
  const state = loadState(config);
  state.bridges[bridge.key] = bridge;
  saveState(config, state);
}

function refreshBridgeSessionId(config, bridge) {
  if (bridge.sessionId) return bridge;
  const candidates = sessionViews()
    .filter((view) => view.runner === bridge.runner && view.cwd === bridge.cwd && timestampMs(view.createdAt || view.updatedAt) >= timestampMs(bridge.createdAt))
    .sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
  const candidate = candidates[0];
  if (!candidate) return bridge;
  return updateBridge(config, bridge.key, (current) => ({ ...current, sessionId: candidate.sessionId })) || { ...bridge, sessionId: candidate.sessionId };
}

const WATCHERS = new Map();

function startWatcher(config, bridge, deps, options = {}) {
  const previous = WATCHERS.get(bridge.key);
  if (previous) previous.cancelled = true;
  const watcher = { cancelled: false, previousPane: options.previousPane || "", startedAt: options.startedAt || Date.now(), waitingChoice: null };
  WATCHERS.set(bridge.key, watcher);
  updateBridge(config, bridge.key, (current) => ({
    ...current,
    status: "running",
    activeReplyContext: options.replyContext || current.activeReplyContext,
    interactiveWatch: {
      startedAt: new Date(watcher.startedAt).toISOString(),
      previousPane: watcher.previousPane,
      waitingChoice: watcher.waitingChoice,
      updatedAt: now(),
    },
  }));
  const pollMs = Math.max(250, Number(config?.sessionWatchPollMs || DEFAULT_POLL_MS));
  const deadline = Date.now() + Math.max(1000, Number(config?.sessionResponseTimeoutMs || DEFAULT_RESPONSE_TIMEOUT_MS));
  (async () => {
    let previousPane = watcher.previousPane;
    while (!watcher.cancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (watcher.cancelled) return;
      let latest = loadState(config).bridges[bridge.key] || bridge;
      latest = refreshBridgeSessionId(config, latest);
      if (!latest.tmuxSession || !tmuxHasSession(latest.tmuxSession)) {
        updateBridge(config, bridge.key, (current) => ({ ...current, status: "failed", interactiveWatch: null, tmuxSession: "" }));
        await deps.sendText(sessionReply(latest, "tmux 会话已结束"), replyConfigFor(latest, config, deps), options.args || {});
        WATCHERS.delete(bridge.key);
        return;
      }
      const pane = tmuxPane(latest.tmuxSession, config);
      const cleaned = cleanPane(pane);
      const choice = parseChoice(pane);
      if (choice && (!watcher.waitingChoice || watcher.waitingChoice.signature !== choice.signature)) {
        watcher.waitingChoice = choice;
        updateBridge(config, bridge.key, (current) => ({
          ...current,
          status: "waiting",
          interactiveWatch: { startedAt: new Date(watcher.startedAt).toISOString(), waitingChoice: choice, previousPane: cleaned, updatedAt: now() },
        }));
        await deps.sendText(sessionReply(latest, "等待选择", `${choice.question}\n${choice.options.map((item) => `${item.number}. ${item.text}`).join("\n")}`), replyConfigFor(latest, config, deps), options.args || {});
        previousPane = cleaned;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      if (!watcher.waitingChoice && isDone(pane, previousPane)) {
        updateBridge(config, bridge.key, (current) => ({ ...current, status: "ready", interactiveWatch: null, summary: compact(cleaned, 320) }));
        const done = loadState(config).bridges[bridge.key] || latest;
        await deps.sendTextWithMedia(sessionReply(done, "完成", cleaned), replyConfigFor(done, config, deps), options.args || {});
        WATCHERS.delete(bridge.key);
        return;
      }
      previousPane = cleaned;
    }
    if (!watcher.cancelled) {
      updateBridge(config, bridge.key, (current) => ({ ...current, status: "running", interactiveWatch: { ...(current.interactiveWatch || {}), updatedAt: now() } }));
      const latest = loadState(config).bridges[bridge.key] || bridge;
      await deps.sendText(sessionReply(latest, "仍在运行，watcher 已到兜底超时"), replyConfigFor(latest, config, deps), options.args || {});
      WATCHERS.delete(bridge.key);
    }
  })().catch((error) => {
    deps.log?.(error);
    updateBridge(config, bridge.key, (current) => ({ ...current, status: "failed", interactiveWatch: null, error: error.message }));
    WATCHERS.delete(bridge.key);
  });
}

async function sendToBridge(bridge, text, attachments, config, fromUser, options, deps) {
  let current = bridge;
  if (ACTIVE_STATUSES.has(current.status) && current.interactiveWatch) {
    const waiting = current.interactiveWatch.waitingChoice;
    if (waiting && /^\d+$/u.test(String(text || "").trim())) {
      const choice = Number(String(text).trim());
      if (choice < 1 || choice > waiting.options.length) return sessionReply(current, "选择无效", `请输入 1-${waiting.options.length}`);
      tmuxChoice(current.tmuxSession, choice);
      current = updateBridge(config, current.key, (item) => ({ ...item, status: "running", interactiveWatch: { ...item.interactiveWatch, waitingChoice: null, updatedAt: now() } })) || current;
      startWatcher(config, current, deps, { previousPane: waiting.previousPane || "", replyContext: current.activeReplyContext, args: options.args || {}, startedAt: timestampMs(current.interactiveWatch?.startedAt) || Date.now() });
      return sessionReply(current, `已选择 ${choice}，继续处理中`);
    }
    return sessionReply(current, current.status === "waiting" ? "等待选择" : "仍在处理中", "请等待当前回合结束。");
  }

  current = refreshBridgeSessionId(config, current);
  current = ensureBridge(config, current);
  const savedAttachments = deps.saveSessionAttachments
    ? await deps.saveSessionAttachments(current, attachments, config)
    : attachments;
  const prompt = [String(text || "").trim(), ...savedAttachments.map((item) => `附件：${item.filePath || item}`)].filter(Boolean).join("\n");
  if (!prompt) return sessionReply(current, "空消息已忽略");
  const before = cleanPane(tmuxPane(current.tmuxSession, config));
  tmuxSend(current.tmuxSession, prompt);
  current = updateBridge(config, current.key, (item) => ({
    ...item,
    status: "running",
    prompt: compact(text, 240),
    activeReplyContext: serializableContext(deps, config, options.replyConfig || config),
  })) || current;
  startWatcher(config, current, deps, {
    previousPane: before,
    replyContext: current.activeReplyContext,
    args: options.args || {},
  });
  return sessionReply(current, "已发送");
}

export function hasCurrentSession(config, fromUser) {
  return Boolean(currentBridge(config, fromUser));
}

export async function forwardToCurrentSession(text, fromUser, config, options = {}, attachments = [], deps = {}) {
  const bridge = currentBridge(config, fromUser);
  if (!bridge) return null;
  if (config.dryRun) return sessionReply(bridge, "将发送", [text, ...attachments.map((item) => item.filePath || item)].filter(Boolean).join("\n"));
  return sendToBridge(bridge, text, attachments, config, fromUser, options, deps);
}

export async function handleSessionCommand(command, fromUser, config, options = {}, deps = {}) {
  if (!command) return null;
  if (command.type === "list") return formatSessionHistory(config, fromUser);
  if (command.type === "current") return formatCurrent(config, fromUser);
  if (command.type === "off") {
    setCurrent(config, fromUser, null);
    return "已退出当前手机会话。历史会话和运行中的桥接不会删除。";
  }
  if (command.type === "takeover") {
    const items = pickerItems(config, fromUser);
    const item = items?.find((entry) => entry.index === command.index);
    if (!item) return "会话编号已过期或不存在。请先发送 历史，再发送 接管 N。";
    const state = loadState(config);
    let bridge = state.bridges[item.key];
    if (!bridge) {
      const view = sessionViews().find((entry) => entry.key === item.key);
      if (!view) return "历史会话已不存在，请重新发送 历史。";
      bridge = createBridge(config, view);
    }
    try {
      if (!config.dryRun) bridge = ensureBridge(config, bridge);
      setCurrent(config, fromUser, bridge);
      return sessionReply(bridge, "已接管", `目录：${bridge.cwd}`);
    } catch (error) {
      updateBridge(config, bridge.key, (current) => ({ ...current, status: "failed", error: error.message }));
      return sessionReply(bridge, "接管失败", error.message);
    }
  }
  if (command.type === "new") {
    const bridge = createBridge(config, { runner: command.runner, cwd: sessionCwd(config, command.runner), source: "mobile" });
    try {
      if (!config.dryRun) {
        const started = ensureBridge(config, bridge);
        setCurrent(config, fromUser, started);
        return sessionReply(started, "已启动", `发送下一条消息开始工作\n目录：${started.cwd}`);
      }
      setCurrent(config, fromUser, bridge);
      return sessionReply(bridge, "将启动", `目录：${bridge.cwd}`);
    } catch (error) {
      updateBridge(config, bridge.key, (current) => ({ ...current, status: "failed", error: error.message }));
      return sessionReply(bridge, "启动失败", error.message);
    }
  }
  return null;
}

export function resumeSessionWatchers(config, args = {}, deps = {}) {
  if (config?.dryRun) return [];
  const state = loadState(config);
  const resumed = [];
  for (const bridge of Object.values(state.bridges)) {
    if (!bridge.interactiveWatch || !ACTIVE_STATUSES.has(bridge.status)) continue;
    if (!bridge.tmuxSession || !tmuxHasSession(bridge.tmuxSession)) {
      updateBridge(config, bridge.key, (current) => ({ ...current, status: "failed", interactiveWatch: null, error: "手机会话 tmux 已不存在" }));
      continue;
    }
    startWatcher(config, bridge, deps, {
      previousPane: bridge.interactiveWatch.previousPane || "",
      replyContext: bridge.activeReplyContext,
      args,
      startedAt: timestampMs(bridge.interactiveWatch.startedAt) || Date.now(),
    });
    resumed.push({ runner: bridge.runner, bridgeId: bridge.bridgeId, sessionName: bridge.tmuxSession });
  }
  return resumed;
}

export const sessionRouterForTests = {
  formatSessionHistory,
  parseSessionCommand,
  sessionKey,
  sessionViews,
};
