#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const WATCHERS = new Map();
const ACTIVE_STATUSES = new Set(["starting", "running", "waiting"]);
const DEFAULT_WATCH_POLL_MS = 1000;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CAPTURE_LINES = 160;
const LABELS = { claude: "Claude Code", opencode: "opencode" };

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
  return path.join(stateDir(config), "tool-tasks.json");
}

function currentPath(config) {
  return path.join(stateDir(config), "tool-current.json");
}

function logPath(config) {
  return path.join(stateDir(config), "logs", "tool-router.log");
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
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function log(config, message) {
  try {
    fs.mkdirSync(path.dirname(logPath(config)), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logPath(config), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must not take down the message router.
  }
}

function now() {
  return new Date().toISOString();
}

function compact(value, max = 240) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function sanitize(value) {
  return String(value || "default").replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 24) || "default";
}

function runnerLabel(runner) {
  return LABELS[runner] || runner;
}

function taskKey(runner, id) {
  return `${runner}:${id}`;
}

function normalizeState(state) {
  const result = state && typeof state === "object" ? state : {};
  result.tasks = result.tasks && typeof result.tasks === "object" ? result.tasks : {};
  result.nextIds = result.nextIds && typeof result.nextIds === "object" ? result.nextIds : {};
  return result;
}

function loadState(config) {
  return normalizeState(readJson(statePath(config), { version: 1, tasks: {}, nextIds: {} }));
}

function saveState(config, state) {
  state.updatedAt = now();
  writeJson(statePath(config), normalizeState(state));
  return state;
}

function loadCurrent(config) {
  const result = readJson(currentPath(config), { users: {} });
  result.users = result.users && typeof result.users === "object" ? result.users : {};
  return result;
}

function saveCurrent(config, current) {
  writeJson(currentPath(config), { users: current.users || {}, updatedAt: now() });
}

function userKey(fromUser) {
  return String(fromUser || "local");
}

function currentTask(config, fromUser) {
  const key = loadCurrent(config).users[userKey(fromUser)]?.active;
  if (!key) return null;
  return loadState(config).tasks[key] || null;
}

function setCurrent(config, fromUser, task) {
  const current = loadCurrent(config);
  current.users[userKey(fromUser)] = { active: task ? task.key : "", updatedAt: now() };
  saveCurrent(config, current);
}

function commandExists(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command.replace(/[^A-Za-z0-9_.-]/gu, "")}`], { stdio: "ignore" });
  return result.status === 0;
}

function tmuxHasSession(name) {
  return Boolean(name) && spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
}

function tmuxPane(name, config) {
  const lines = Math.max(20, Number(config?.toolCaptureLines || process.env.CODEX_TOOL_ROUTER_CAPTURE_LINES || DEFAULT_CAPTURE_LINES));
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

function killTmux(name) {
  if (!tmuxHasSession(name)) return false;
  const result = spawnSync("tmux", ["kill-session", "-t", name], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "tmux kill-session failed");
  return true;
}

function toolCwd(config) {
  const cwd = expandHome(config?.toolCwd || config?.codexCwd || process.env.CODEX_TOOL_CWD || process.env.CODEX_WEIXIN_CODEX_CWD || process.cwd());
  return fs.existsSync(cwd) ? cwd : process.cwd();
}

function toolCommand(runner, task, config) {
  const command = runner === "claude"
    ? String(config?.claudeCommand || process.env.CODEX_WEIXIN_CLAUDE_COMMAND || "claude")
    : String(config?.opencodeCommand || process.env.CODEX_WEIXIN_OPENCODE_COMMAND || "opencode");
  const args = [];
  if (runner === "claude") {
    if (task.toolSessionId) args.push("--resume", task.toolSessionId);
  } else if (task.toolSessionId) {
    args.push("-s", task.toolSessionId);
  }
  return { command, args };
}

function tmuxName(task, config) {
  const prefix = config?.toolTmuxPrefix || process.env.CODEX_TOOL_TMUX_PREFIX || "codex-wx-tool";
  return sanitize(`${prefix}-${sanitize(config?.namespace || "default")}-${task.runner}-${task.id}`);
}

function createTask(config, runner, target) {
  const state = loadState(config);
  const targetText = String(target || "").trim();
  const numeric = /^\d+$/u.test(targetText) ? targetText : "";
  let id = numeric;
  let sessionId = "";
  if (!id) {
    const existing = Object.values(state.tasks).find((task) => task.runner === runner && task.toolSessionId === targetText);
    if (existing) return existing;
    sessionId = targetText;
    id = String(state.nextIds[runner] || 1);
  }
  const key = taskKey(runner, id);
  if (state.tasks[key]) {
    const existing = state.tasks[key];
    if (sessionId && !existing.toolSessionId) existing.toolSessionId = sessionId;
    return existing;
  }
  const nextId = Number(state.nextIds[runner] || 1);
  if (numeric && Number(id) !== nextId) return null;
  const timestamp = now();
  const task = {
    key,
    id,
    runner,
    toolSessionId: sessionId,
    cwd: toolCwd(config),
    status: "ready",
    prompt: "",
    summary: "",
    tmuxSession: "",
    activeReplyContext: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.tasks[key] = task;
  state.nextIds[runner] = Number(id) + 1;
  saveState(config, state);
  return task;
}

function updateTask(config, key, updater) {
  const state = loadState(config);
  const current = state.tasks[key];
  if (!current) return null;
  const next = updater({ ...current });
  next.updatedAt = now();
  state.tasks[key] = next;
  saveState(config, state);
  return next;
}

function findTask(config, runner, target) {
  const state = loadState(config);
  const targetText = String(target || "").trim();
  return Object.values(state.tasks).find((task) => task.runner === runner && (task.id === targetText || task.toolSessionId === targetText)) || null;
}

function parseChoice(text) {
  const lines = String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, "").split(/\r?\n/u);
  const start = lines.findIndex((line) => /Question\s+\d+\/\d+|(?:select|choose|which)\b|需要选择|请选择/iu.test(line));
  if (start < 0) return null;
  const options = [];
  for (const line of lines.slice(start, start + 24)) {
    const match = line.match(/^\s*(?:[>›•*]\s*)?(\d+)[.)：:]\s+(.+?)\s*$/u);
    if (match) options.push({ number: Number(match[1]), text: compact(match[2], 240) });
  }
  if (options.length < 2) return null;
  const question = lines.slice(start, Math.min(lines.length, start + 12)).join("\n").trim();
  return { signature: `${question}\n${options.map((item) => `${item.number}:${item.text}`).join("|")}`, question, options };
}

function cleanPane(text) {
  return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, "")
    .split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean).join("\n").trim();
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

function captureOptions(config) {
  return {
    pollMs: Math.max(200, Number(config?.toolWatchPollMs || process.env.CODEX_TOOL_WATCH_POLL_MS || DEFAULT_WATCH_POLL_MS)),
    readyTimeoutMs: Math.max(1000, Number(config?.toolReadyTimeoutMs || process.env.CODEX_TOOL_READY_TIMEOUT_MS || DEFAULT_READY_TIMEOUT_MS)),
    responseTimeoutMs: Math.max(1000, Number(config?.toolResponseTimeoutMs || process.env.CODEX_TOOL_RESPONSE_TIMEOUT_MS || DEFAULT_RESPONSE_TIMEOUT_MS)),
  };
}

function replyConfigFor(task, config, deps) {
  return deps.configWithReplyContext && task.activeReplyContext
    ? deps.configWithReplyContext(config, task.activeReplyContext)
    : config;
}

function send(deps, method, text, config, args) {
  const fn = deps[method];
  if (typeof fn !== "function") return Promise.resolve();
  return Promise.resolve(fn(text, config, args)).catch((error) => {
    if (deps.log) deps.log(error);
  });
}

function taskReply(task, status, output = "") {
  return [
    `tool ${task.runner} ${task.id} · ${status}`,
    `会话: ${task.tmuxSession || task.toolSessionId || "未记录"}`,
    `目录: ${task.cwd}`,
    output ? `\n${compact(output, 8000)}` : null,
  ].filter(Boolean).join("\n");
}

function persistWatch(config, task, watcher) {
  return updateTask(config, task.key, (current) => ({
    ...current,
    status: watcher.waitingChoice ? "waiting" : "running",
    tmuxSession: watcher.sessionName,
    activeReplyContext: watcher.replyContext,
    interactiveWatch: {
      sessionName: watcher.sessionName,
      previousPane: watcher.previousPane,
      waitingChoice: watcher.waitingChoice,
      startedAt: new Date(watcher.startedAt).toISOString(),
      updatedAt: now(),
    },
  }));
}

function clearWatch(config, task, status = "ready") {
  return updateTask(config, task.key, (current) => ({
    ...current,
    status,
    interactiveWatch: null,
    updatedAt: now(),
  }));
}

function watcherKey(config, task) {
  return `${config?.namespace || "default"}:${task.key}`;
}

function stopWatcher(config, task) {
  const key = watcherKey(config, task);
  const watcher = WATCHERS.get(key);
  if (watcher) watcher.cancelled = true;
  WATCHERS.delete(key);
}

function startWatcher(task, config, deps, options = {}) {
  const key = watcherKey(config, task);
  stopWatcher(config, task);
  const watcher = {
    taskKey: task.key,
    sessionName: options.sessionName || task.tmuxSession,
    previousPane: options.previousPane || "",
    waitingChoice: options.waitingChoice || null,
    replyContext: options.replyContext || task.activeReplyContext || null,
    startedAt: options.startedAt || Date.now(),
    cancelled: false,
  };
  WATCHERS.set(key, watcher);
  persistWatch(config, task, watcher);
  const { pollMs, responseTimeoutMs } = captureOptions(config);

  (async () => {
    const deadline = Date.now() + responseTimeoutMs;
    let lastPane = watcher.previousPane;
    while (!watcher.cancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (watcher.cancelled) return;
      if (!tmuxHasSession(watcher.sessionName)) {
        clearWatch(config, task, "failed");
        await send(deps, "sendTextWithMedia", taskReply(task, "会话已结束"), replyConfigFor(task, config, deps), options.args || {});
        WATCHERS.delete(key);
        return;
      }
      const pane = tmuxPane(watcher.sessionName, config);
      const cleaned = cleanPane(pane);
      const choice = parseChoice(pane);
      if (choice && (!watcher.waitingChoice || watcher.waitingChoice.signature !== choice.signature)) {
        watcher.waitingChoice = choice;
        watcher.previousPane = cleaned;
        persistWatch(config, task, watcher);
        await send(deps, "sendText", taskReply(task, "等待选择", `${choice.question}\n${choice.options.map((item) => `${item.number}. ${item.text}`).join("\n")}`), replyConfigFor(task, config, deps), options.args || {});
        lastPane = cleaned;
        continue;
      }
      if (!watcher.waitingChoice && isDone(pane, watcher.previousPane || lastPane)) {
        clearWatch(config, task, "ready");
        await send(deps, "sendTextWithMedia", taskReply(task, "完成", cleaned), replyConfigFor(task, config, deps), options.args || {});
        WATCHERS.delete(key);
        return;
      }
      lastPane = cleaned;
    }
    if (!watcher.cancelled) {
      persistWatch(config, task, watcher);
      await send(deps, "sendText", taskReply(task, "仍在运行，watcher 超时"), replyConfigFor(task, config, deps), options.args || {});
      WATCHERS.delete(key);
    }
  })().catch((error) => {
    log(config, `watcher ${task.key} failed: ${error.stack || error.message}`);
    clearWatch(config, task, "failed");
    WATCHERS.delete(key);
  });
  return watcher;
}

function ensureSession(task, config) {
  if (task.tmuxSession && tmuxHasSession(task.tmuxSession)) return task.tmuxSession;
  if (!commandExists("tmux")) throw new Error("tmux 未安装，无法启动工具交互会话。");
  const sessionName = tmuxName(task, config);
  if (tmuxHasSession(sessionName)) return sessionName;
  const { command, args } = toolCommand(task.runner, task, config);
  const result = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", task.cwd, command, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `tmux exit ${result.status}`);
  return sessionName;
}

function sendInstruction(task, text, config, fromUser, attachments, options, deps) {
  const prompt = [String(text || "").trim(), ...attachments.map((item) => `附件: ${item.filePath || item}`)].filter(Boolean).join("\n");
  if (!prompt) return `tool ${task.runner} ${task.id}: 空消息已忽略`;
  if (ACTIVE_STATUSES.has(task.status) && task.interactiveWatch) {
    return taskReply(task, task.status === "waiting" ? "等待选择" : "仍在处理中", "请等待当前回合结束后再发送下一条消息。\n如正在等待选项，请回复选项编号。");
  }
  if (config.dryRun) return taskReply(task, "将发送", prompt);
  let sessionName;
  try {
    sessionName = ensureSession(task, config);
    const before = tmuxPane(sessionName, config);
    tmuxSend(sessionName, prompt);
    const updated = updateTask(config, task.key, (current) => ({
      ...current,
      status: "running",
      tmuxSession: sessionName,
      prompt: compact(text, 240),
      activeReplyContext: deps.serializableReplyContext ? deps.serializableReplyContext(options.replyConfig || config) : null,
      updatedAt: now(),
    }));
    startWatcher(updated || { ...task, tmuxSession: sessionName }, config, deps, {
      sessionName,
      previousPane: cleanPane(before),
      replyContext: deps.serializableReplyContext ? deps.serializableReplyContext(options.replyConfig || config) : null,
      args: options.args || {},
    });
    return taskReply(task, "已发送", prompt);
  } catch (error) {
    updateTask(config, task.key, (current) => ({ ...current, status: "failed", error: error.message, updatedAt: now() }));
    return taskReply(task, "启动失败", error.message);
  }
}

function answerChoice(task, text, config, options, deps) {
  const watch = task.interactiveWatch;
  if (!watch?.waitingChoice) return null;
  if (!/^\d+$/u.test(String(text || "").trim())) {
    return `${taskReply(task, "等待选择")}\n请输入 1-${watch.waitingChoice.options.length}。`;
  }
  const choice = Number(String(text).trim());
  if (choice < 1 || choice > watch.waitingChoice.options.length) return `${taskReply(task, "选择无效")}\n请输入 1-${watch.waitingChoice.options.length}。`;
  if (config.dryRun) return taskReply(task, `将选择 ${choice}`);
  try {
    tmuxChoice(watch.sessionName || task.tmuxSession, choice);
    const updated = updateTask(config, task.key, (current) => ({
      ...current,
      status: "running",
      interactiveWatch: current.interactiveWatch ? { ...current.interactiveWatch, waitingChoice: null, updatedAt: now() } : null,
      updatedAt: now(),
    }));
    const running = updated || task;
    startWatcher(running, config, deps, {
      sessionName: watch.sessionName || task.tmuxSession,
      previousPane: watch.previousPane || "",
      replyContext: task.activeReplyContext,
      startedAt: Date.parse(watch.startedAt) || Date.now(),
      args: options.args || {},
    });
    return taskReply(task, `已选择 ${choice}，继续处理中`);
  } catch (error) {
    return taskReply(task, "选择失败", error.message);
  }
}

export function parseToolCommand(text) {
  const trimmed = String(text || "").trim();
  const direct = trimmed.match(/^(claude|opencode)\s+(.+)$/iu);
  if (direct) {
    const runner = direct[1].toLowerCase();
    const rest = direct[2].trim();
    const close = rest.match(/^(?:close|关闭)\s+(\S+)$/iu);
    if (close) return { type: "close", runner, target: close[1] };
    const match = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/u);
    return { type: "select", runner, target: match[1], text: match[2] || "" };
  }
  if (/^(?:工具列表|tool\s+list)$/iu.test(trimmed)) return { type: "list" };
  if (/^(?:工具退出|tool\s+(?:off|退出|返回))$/iu.test(trimmed)) return { type: "off" };
  const tool = trimmed.match(/^tool\s+(.+)$/iu);
  if (!tool) return null;
  const rest = tool[1].trim();
  if (/^(?:off|退出|返回)$/iu.test(rest)) return { type: "off" };
  if (/^(?:list|列表)$/iu.test(rest)) return { type: "list" };
  const close = rest.match(/^(?:close|关闭)\s+(claude|opencode)\s+(\S+)$/iu);
  if (close) return { type: "close", runner: close[1].toLowerCase(), target: close[2] };
  return null;
}

export function hasSelectedTool(config, fromUser) {
  return Boolean(currentTask(config, fromUser));
}

export function toolList(config, fromUser) {
  const state = loadState(config);
  const selected = currentTask(config, fromUser)?.key;
  const tasks = Object.values(state.tasks).sort((a, b) => a.runner.localeCompare(b.runner) || Number(a.id) - Number(b.id));
  if (tasks.length === 0) return "tool: 暂无 Claude Code/opencode 会话。\n用 claude 1 或 opencode 1 创建。";
  return ["tool 会话:", ...tasks.map((task) => [
    `${task.runner} ${task.id}${task.key === selected ? " · current" : ""}`,
    `状态: ${task.status || "ready"}`,
    `目录: ${task.cwd}`,
    `tmux: ${task.tmuxSession || "未启动"}`,
    task.toolSessionId ? `session: ${task.toolSessionId}` : null,
  ].filter(Boolean).join(" | "))].join("\n");
}

export async function handleToolCommand(command, fromUser, config, options = {}, deps = {}) {
  if (!command) return null;
  if (command.type === "off") {
    setCurrent(config, fromUser, null);
    return "tool: 已退出工具会话，后续消息回到 Codex task。";
  }
  if (command.type === "list") return toolList(config, fromUser);
  if (command.type === "close") {
    const task = findTask(config, command.runner, command.target);
    if (!task) return `tool ${command.runner} ${command.target}: 不存在。`;
    if (config.dryRun) return taskReply(task, "将关闭");
    stopWatcher(config, task);
    try { killTmux(task.tmuxSession); } catch (error) { return taskReply(task, "关闭失败", error.message); }
    updateTask(config, task.key, (current) => ({ ...current, status: "closed", tmuxSession: "", interactiveWatch: null, updatedAt: now() }));
    if (currentTask(config, fromUser)?.key === task.key) setCurrent(config, fromUser, null);
    return taskReply(task, "已关闭");
  }
  if (command.type !== "select") return null;
  let task = findTask(config, command.runner, command.target);
  if (!task) task = createTask(config, command.runner, command.target);
  if (!task) return `tool ${command.runner} ${command.target}: 只能按顺序创建下一个数字会话。`;
  if (task.status === "closed") task = updateTask(config, task.key, (current) => ({ ...current, status: "ready", error: "", updatedAt: now() })) || task;
  setCurrent(config, fromUser, task);
  if (!command.text) {
    if (config.dryRun) return taskReply(task, "将启动");
    try {
      const sessionName = ensureSession(task, config);
      const started = updateTask(config, task.key, (current) => ({ ...current, status: "ready", tmuxSession: sessionName, error: "", updatedAt: now() }));
      return taskReply(started || { ...task, tmuxSession: sessionName }, "已启动");
    } catch (error) {
      updateTask(config, task.key, (current) => ({ ...current, status: "failed", error: error.message, updatedAt: now() }));
      return taskReply(task, "启动失败", error.message);
    }
  }
  const answered = answerChoice(task, command.text, config, options, deps);
  if (answered) return answered;
  return sendInstruction(task, command.text, config, fromUser, [], options, deps);
}

export function forwardToSelectedTool(text, fromUser, config, options = {}, attachments = [], deps = {}) {
  const task = currentTask(config, fromUser);
  if (!task) return null;
  const answered = answerChoice(task, text, config, options, deps);
  if (answered) return answered;
  return sendInstruction(task, text, config, fromUser, attachments, options, deps);
}

export function resumeToolWatchers(config, args = {}, deps = {}) {
  if (config?.dryRun) return [];
  const state = loadState(config);
  const resumed = [];
  for (const task of Object.values(state.tasks)) {
    const watch = task.interactiveWatch;
    if (!watch || !ACTIVE_STATUSES.has(task.status)) continue;
    if (!watch.sessionName || !tmuxHasSession(watch.sessionName)) {
      updateTask(config, task.key, (current) => ({
        ...current,
        status: "failed",
        tmuxSession: "",
        interactiveWatch: null,
        error: "工具 tmux 会话已不存在。",
        updatedAt: now(),
      }));
      continue;
    }
    startWatcher(task, config, deps, {
      sessionName: watch.sessionName,
      previousPane: watch.previousPane || "",
      waitingChoice: watch.waitingChoice || null,
      replyContext: task.activeReplyContext,
      startedAt: Date.parse(watch.startedAt) || Date.now(),
      args,
    });
    resumed.push({ runner: task.runner, id: task.id, sessionName: watch.sessionName });
  }
  return resumed;
}

export const toolRouterForTests = {
  parseToolCommand,
  toolList,
};
