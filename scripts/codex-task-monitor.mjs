#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const STATE_DIR = process.env.CODEX_WEIXIN_STATE_DIR || path.join(CODEX_HOME, "weixin-notifier");
const SESSION_STATE_PATH = path.join(STATE_DIR, "codex-sessions.json");
const SESSION_LOCK_PATH = path.join(STATE_DIR, "codex-sessions.lock");
const ROUTER_TASKS_PATH = path.join(STATE_DIR, "tasks.json");
const CURRENT_TASK_PATH = path.join(STATE_DIR, "current-task.json");
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const TRANSCRIPT_ROOT = path.join(CODEX_HOME, "sessions");
const ACTIVE_STATUSES = new Set(["running", "starting", "queued", "waiting"]);
const RECENT_SESSION_MS = 24 * 60 * 60 * 1000;
const FALLBACK_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const STALE_ACTIVE_MS = 2 * 60 * 60 * 1000;
const MAX_STORED_SESSIONS = 200;
const MAX_DISCOVERED_SESSIONS = 80;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0));
}

function withStateLock(callback) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  let descriptor = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      descriptor = fs.openSync(SESSION_LOCK_PATH, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(SESSION_LOCK_PATH).mtimeMs;
        if (age > 10_000) fs.unlinkSync(SESSION_LOCK_PATH);
      } catch {
        // Another writer may have released the lock.
      }
      sleepSync(20);
    }
  }
  if (descriptor === null) throw new Error(`Timed out waiting for ${SESSION_LOCK_PATH}`);
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(SESSION_LOCK_PATH);
    } catch {
      // A stale-lock cleanup may already have removed it.
    }
  }
}

function compact(value, max = 160) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function isInternalUserMessage(value) {
  const text = String(value || "").trim();
  return /^The following is the Codex agent history/u.test(text)
    || /^<environment_context>/u.test(text);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function safeTimestamp(value, fallback = "") {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : fallback;
}

function timestampMs(value) {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? millis : 0;
}

function readFileSlice(filePath, start, length) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(descriptor, buffer, 0, length, start);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readTranscriptHead(filePath, maxBytes = 512 * 1024) {
  try {
    const size = fs.statSync(filePath).size;
    return readFileSlice(filePath, 0, Math.min(size, maxBytes));
  } catch {
    return "";
  }
}

function transcriptMetadata(filePath) {
  for (const line of readTranscriptHead(filePath).split(/\r?\n/u)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "session_meta") continue;
      const payload = entry.payload || {};
      return {
        sessionId: firstString(payload.session_id, payload.id),
        cwd: firstString(payload.cwd),
        source: firstString(payload.source, payload.originator),
        originator: firstString(payload.originator),
        createdAt: safeTimestamp(payload.timestamp, entry.timestamp),
      };
    } catch {
      // Ignore partial or non-JSON transcript lines.
    }
  }
  return {};
}

function normalizeSource(value, originator = "") {
  const combined = `${value} ${originator}`.toLowerCase();
  if (combined.includes("vscode") || combined.includes("ide")) return "vscode";
  if (combined.includes("weixin") || combined.includes("wechat")) return "weixin";
  return "cli";
}

function hookSource(payload) {
  const metadata = payload.transcript_path ? transcriptMetadata(payload.transcript_path) : {};
  return {
    source: normalizeSource(
      firstString(payload.source, process.env.CODEX_PRODUCT, metadata.source),
      metadata.originator,
    ),
    metadata,
  };
}

function hookToolName(payload) {
  return firstString(payload.tool_name, payload.toolName, payload.tool?.name, payload.name, "工具");
}

function toolStage(toolName, payload, completed = false) {
  const name = String(toolName || "工具");
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  let action = name;
  if (/^(?:Bash|exec_command)$/iu.test(name)) action = `执行命令 ${compact(input.command || input.cmd, 80)}`.trim();
  else if (/^(?:apply_patch|Edit|Write)$/iu.test(name)) action = "修改文件";
  else if (/Agent|spawn_agent/iu.test(name)) action = "运行子任务";
  else if (/WebSearch|web/iu.test(name)) action = "查询资料";
  else action = `调用 ${name}`;
  return completed ? `${action}已完成` : action;
}

export function recordHookPayload(payload = {}, options = {}) {
  if (process.env.CODEX_WEIXIN_ROUTER_TASK === "1" && options.includeRouterTask !== true) return null;
  const now = new Date().toISOString();
  const event = firstString(payload.hook_event_name, payload.event, payload.type);
  const sourceInfo = hookSource(payload);
  const sessionId = firstString(payload.session_id, payload.sessionId, sourceInfo.metadata.sessionId);
  if (!sessionId || !event) return null;

  return withStateLock(() => {
    const state = readJson(SESSION_STATE_PATH, { sessions: {} });
    const sessions = state.sessions && typeof state.sessions === "object" ? state.sessions : {};
    const previous = sessions[sessionId] || {};
    const turnId = firstString(payload.turn_id, payload.turnId, previous.turnId);
    const prompt = compact(firstString(payload.prompt, payload.user_prompt, payload.message), 240);
    const summary = compact(firstString(
      payload.last_assistant_message,
      payload.last_agent_message,
      payload.summary,
      payload.output,
    ), 320);
    const next = {
      ...previous,
      sessionId,
      turnId,
      source: sourceInfo.source,
      cwd: firstString(payload.cwd, sourceInfo.metadata.cwd, previous.cwd, process.cwd()),
      model: firstString(payload.model, previous.model),
      permissionMode: firstString(payload.permission_mode, previous.permissionMode),
      transcriptPath: firstString(payload.transcript_path, previous.transcriptPath),
      createdAt: previous.createdAt || sourceInfo.metadata.createdAt || now,
      updatedAt: now,
      lastEvent: event,
    };

    if (event === "SessionStart") {
      next.status = previous.status || "ready";
      next.stage = "会话已启动";
    } else if (event === "UserPromptSubmit") {
      next.status = "running";
      next.stage = "开始处理";
      next.prompt = prompt || previous.prompt || "";
      next.startedAt = now;
      next.completedAt = "";
    } else if (event === "PermissionRequest") {
      const toolName = hookToolName(payload);
      next.status = "waiting";
      next.stage = `等待确认：${toolStage(toolName, payload)}`;
      next.lastTool = toolName;
    } else if (event === "PreToolUse") {
      const toolName = hookToolName(payload);
      next.status = "running";
      next.stage = toolStage(toolName, payload);
      next.lastTool = toolName;
    } else if (event === "PostToolUse") {
      const toolName = hookToolName(payload);
      next.status = "running";
      next.stage = toolStage(toolName, payload, true);
      next.lastTool = toolName;
    } else if (event === "Stop") {
      next.status = "completed";
      next.stage = "本轮已完成";
      next.completedAt = now;
      if (summary) next.summary = summary;
    }

    sessions[sessionId] = next;
    const kept = Object.values(sessions)
      .sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt))
      .slice(0, MAX_STORED_SESSIONS);
    atomicWriteJson(SESSION_STATE_PATH, {
      sessions: Object.fromEntries(kept.map((session) => [session.sessionId, session])),
      updatedAt: now,
    });
    return next;
  });
}

function recentTranscriptFiles() {
  const files = [];
  const cutoff = Date.now() - (RECENT_SESSION_MS * 2);
  if (!fs.existsSync(TRANSCRIPT_ROOT)) return files;
  const years = fs.readdirSync(TRANSCRIPT_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const year of years) {
    const yearDir = path.join(TRANSCRIPT_ROOT, year.name);
    for (const month of fs.readdirSync(yearDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const monthDir = path.join(yearDir, month.name);
      for (const day of fs.readdirSync(monthDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
        const dayDir = path.join(monthDir, day.name);
        for (const entry of fs.readdirSync(dayDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const filePath = path.join(dayDir, entry.name);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs >= cutoff) files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
          } catch {
            // A session can disappear while the picker is being cleaned up.
          }
        }
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, MAX_DISCOVERED_SESSIONS);
}

function readTranscriptTail(filePath, size, maxBytes = 768 * 1024) {
  try {
    const start = Math.max(0, size - maxBytes);
    const text = readFileSlice(filePath, start, Math.min(size, maxBytes));
    return start === 0 ? text : text.slice(Math.max(0, text.indexOf("\n") + 1));
  } catch {
    return "";
  }
}

function discoverVscodeSessions() {
  const sessions = [];
  for (const file of recentTranscriptFiles()) {
    const metadata = transcriptMetadata(file.filePath);
    if (!metadata.sessionId || normalizeSource(metadata.source, metadata.originator) !== "vscode") continue;
    let latestStartedAt = "";
    let latestCompletedAt = "";
    let turnId = "";
    let prompt = "";
    let summary = "";
    let stage = "等待新指令";
    for (const line of readTranscriptTail(file.filePath, file.size).split(/\r?\n/u)) {
      try {
        const entry = JSON.parse(line);
        const payload = entry.payload || {};
        if (entry.type === "event_msg" && payload.type === "task_started") {
          latestStartedAt = safeTimestamp(payload.started_at, entry.timestamp);
          turnId = firstString(payload.turn_id, turnId);
          stage = "分析处理中";
        } else if (entry.type === "event_msg" && payload.type === "task_complete") {
          latestCompletedAt = safeTimestamp(payload.completed_at, entry.timestamp);
          summary = compact(firstString(payload.last_agent_message, summary), 320);
          stage = "本轮已完成";
        } else if (entry.type === "event_msg" && payload.type === "user_message") {
          const candidate = firstString(payload.message);
          if (candidate && !isInternalUserMessage(candidate)) prompt = compact(candidate, 240);
        } else if (entry.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
          stage = toolStage(firstString(payload.name, "工具"), { input: payload.arguments || payload.input });
        }
      } catch {
        // Ignore partial transcript lines while Codex is still writing.
      }
    }
    const running = timestampMs(latestStartedAt) > timestampMs(latestCompletedAt)
      && Date.now() - file.mtimeMs <= FALLBACK_ACTIVE_WINDOW_MS;
    sessions.push({
      sessionId: metadata.sessionId,
      turnId,
      source: "vscode",
      cwd: metadata.cwd,
      status: running ? "running" : "completed",
      stage: running ? stage : "本轮已完成",
      prompt,
      summary,
      createdAt: metadata.createdAt,
      startedAt: latestStartedAt,
      completedAt: latestCompletedAt,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      transcriptPath: file.filePath,
      discovery: "transcript-fallback",
    });
  }
  return sessions;
}

function tmuxOutput(args) {
  const result = spawnSync("tmux", args, { encoding: "utf8", timeout: 2000 });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function tmuxHasSession(name) {
  if (!name) return false;
  const result = spawnSync("tmux", ["has-session", "-t", name], { encoding: "utf8", timeout: 2000 });
  return result.status === 0;
}

function routerTaskView(task) {
  const sessionName = task.tmuxSession || `codex-wx-task-${task.id}`;
  const online = tmuxHasSession(sessionName);
  let status = task.status || "unknown";
  let stage = task.intent ? compact(task.intent, 120) : "微信 Codex 任务";
  if (online && status !== "closed") {
    const pane = tmuxOutput(["capture-pane", "-p", "-S", "-30", "-t", sessionName]);
    const paneLines = pane.split(/\r?\n/u).map((line) => line.trim());
    const lastIndexMatching = (pattern) => paneLines.reduce((last, line, index) => pattern.test(line) ? index : last, -1);
    const questionIndex = lastIndexMatching(/^Question\s+\d+\/\d+/iu);
    const workingIndex = lastIndexMatching(/^(?:[•◦]\s*)?Working\s*\(/iu);
    if (questionIndex > workingIndex) {
      status = "waiting";
      stage = "等待微信选择";
    } else if (workingIndex >= 0 || task.interactiveWatch) {
      status = "running";
      stage = "Codex 正在处理";
    } else {
      status = "ready";
      stage = "等待新指令";
    }
  } else if (!online && ACTIVE_STATUSES.has(status)) {
    status = "unknown";
    stage = "tmux 会话未运行";
  }
  return {
    id: String(task.id),
    key: `weixin-${task.id}`,
    source: "weixin",
    alias: task.alias || "",
    cwd: task.cwd || "",
    status,
    stage,
    prompt: compact(task.intent, 200),
    startedAt: task.interactiveWatch?.startedAt || task.startedAt || "",
    completedAt: task.lastInteractiveCompletedAt || task.completedAt || "",
    updatedAt: task.updatedAt || task.createdAt || "",
    sessionName,
    online,
  };
}

function localSessionViews() {
  const state = readJson(SESSION_STATE_PATH, { sessions: {} });
  const hooked = Object.values(state.sessions || {});
  const merged = new Map(discoverVscodeSessions().map((session) => [session.sessionId, session]));
  for (const session of hooked) {
    const fallback = merged.get(session.sessionId);
    if (!fallback || timestampMs(session.updatedAt) >= timestampMs(fallback.updatedAt)) {
      merged.set(session.sessionId, { ...fallback, ...session, discovery: "hook" });
    }
  }
  return [...merged.values()]
    .filter((session) => ACTIVE_STATUSES.has(session.status) || Date.now() - timestampMs(session.updatedAt) <= RECENT_SESSION_MS)
    .sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
}

function allTaskViews() {
  const routerState = readJson(ROUTER_TASKS_PATH, { tasks: [] });
  const routerTasks = (routerState.tasks || [])
    .map(routerTaskView)
    .sort((left, right) => Number(left.id) - Number(right.id));
  return { routerTasks, localSessions: localSessionViews() };
}

function statusLabel(status) {
  return {
    ready: "空闲",
    running: "执行中",
    starting: "启动中",
    queued: "排队中",
    waiting: "等待确认",
    completed: "已完成",
    failed: "失败",
    closed: "已关闭",
    unknown: "状态未知",
  }[status] || status || "未知";
}

function sourceLabel(source) {
  if (source === "vscode") return "VS Code";
  if (source === "weixin") return "微信 CLI";
  return "WSL CLI";
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

function relativeTime(value) {
  const millis = timestampMs(value);
  if (!millis) return "未知";
  return `${formatDuration(Date.now() - millis)}前`;
}

function currentTaskId(fromUser = "") {
  const current = readJson(CURRENT_TASK_PATH, { users: {} });
  if (fromUser && current.users?.[fromUser]?.currentTask !== undefined) {
    return String(current.users[fromUser].currentTask);
  }
  const first = Object.values(current.users || {})[0];
  return first?.currentTask !== undefined ? String(first.currentTask) : "0";
}

function formatViewBlock(view, options = {}) {
  const isRouterTask = String(view.key || "").startsWith("weixin-");
  const identity = isRouterTask
    ? `task ${view.id}${view.alias ? ` (${view.alias})` : ""}`
    : `${sourceLabel(view.source)} ${String(view.sessionId || "").slice(0, 8)}`;
  const tags = [sourceLabel(view.source), statusLabel(view.status)];
  if (isRouterTask && String(view.id) === String(options.currentTask)) tags.push("当前");
  const lines = [
    `${identity} [${tags.join(" · ")}]`,
    view.cwd ? `目录：${view.cwd}` : null,
    view.stage ? `阶段：${view.stage}` : null,
  ].filter(Boolean);
  const activeSince = view.startedAt || view.updatedAt;
  if (ACTIVE_STATUSES.has(view.status) && timestampMs(activeSince)) {
    lines.push(`已运行：${formatDuration(Date.now() - timestampMs(activeSince))}`);
  }
  if (view.prompt && view.stage !== view.prompt) lines.push(`任务：${compact(view.prompt, 100)}`);
  lines.push(`更新：${relativeTime(view.updatedAt)}`);
  if (ACTIVE_STATUSES.has(view.status) && Date.now() - timestampMs(view.updatedAt) > STALE_ACTIVE_MS) {
    lines.push("提示：长时间没有事件，可能已失联");
  }
  return lines.join("\n");
}

export function formatTaskOverview(fromUser = "") {
  const { routerTasks, localSessions } = allTaskViews();
  const currentTask = currentTaskId(fromUser);
  const recentCompleted = localSessions.filter((session) => !ACTIVE_STATUSES.has(session.status)).slice(0, 5);
  const activeLocal = localSessions.filter((session) => ACTIVE_STATUSES.has(session.status));
  const visible = [...routerTasks, ...activeLocal, ...recentCompleted];
  const activeCount = visible.filter((view) => ACTIVE_STATUSES.has(view.status)).length;
  const header = [
    `任务概览 · ${visible.length} 个（活动 ${activeCount}）`,
    `当前微信任务：task ${currentTask}`,
  ].join("\n");
  const body = visible.map((view) => formatViewBlock(view, { currentTask })).join("\n\n");
  return body ? `${header}\n\n${body}` : header;
}

export function formatTaskProgress(fromUser = "") {
  const { routerTasks, localSessions } = allTaskViews();
  const currentTask = currentTaskId(fromUser);
  const active = [...routerTasks, ...localSessions]
    .filter((view) => ACTIVE_STATUSES.has(view.status))
    .sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
  if (active.length === 0) return "任务进度 · 当前没有正在执行或等待确认的任务";
  return [
    `任务进度 · 活动 ${active.length} 个`,
    active.map((view) => formatViewBlock(view, { currentTask })).join("\n\n"),
  ].join("\n\n");
}

function processCounts() {
  const result = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 3000 });
  const counts = { cli: 0, vscode: 0 };
  if (result.status !== 0) return counts;
  for (const line of String(result.stdout || "").split(/\r?\n/u)) {
    if (!/\bcodex\b/u.test(line) || /codex-code-mode-host/u.test(line)) continue;
    if (/\bapp-server\b/u.test(line) && /openai\.chatgpt|\.vscode-server/u.test(line)) counts.vscode += 1;
    else if (!/weixin-command-router|codex-task-monitor/u.test(line)) counts.cli += 1;
  }
  return counts;
}

export function formatSystemStatus() {
  const { routerTasks, localSessions } = allTaskViews();
  const processes = processCounts();
  const routerOnline = tmuxHasSession("codex-wx-router");
  const taskOnline = routerTasks.filter((task) => task.online).length;
  const active = [...routerTasks, ...localSessions].filter((view) => ACTIVE_STATUSES.has(view.status));
  const waiting = active.filter((view) => view.status === "waiting");
  const configText = (() => {
    try {
      return fs.readFileSync(CONFIG_PATH, "utf8");
    } catch {
      return "";
    }
  })();
  const hookConfigured = configText.includes("codex-task-state-hook.mjs") && configText.includes("codex-finish-hook.mjs");
  const hookState = readJson(SESSION_STATE_PATH, { sessions: {}, updatedAt: "" });
  const hookSessions = Object.values(hookState.sessions || {});
  const lastEvent = hookSessions.sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt))[0]?.updatedAt;
  return [
    "Codex 监控状态",
    "",
    `微信路由器：${routerOnline ? "正常" : "未运行"}`,
    `微信 CLI：${taskOnline} 个 tmux 会话在线`,
    `WSL Codex：${processes.cli} 个进程`,
    `VS Code Codex：${processes.vscode > 0 ? `正常（${processes.vscode} 个 app-server）` : "未检测到"}`,
    `状态采集 Hook：${hookConfigured ? "已配置" : "未配置"}`,
    `Hook 最近事件：${lastEvent ? relativeTime(lastEvent) : "等待首次事件"}`,
    `活动任务：${active.length}`,
    `等待确认：${waiting.length}`,
    `状态文件：${SESSION_STATE_PATH}`,
  ].join("\n");
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

async function main() {
  const command = process.argv[2] || "tasks";
  if (command === "hook") {
    recordHookPayload(await readStdinJson());
    return;
  }
  if (command === "tasks") process.stdout.write(`${formatTaskOverview(process.argv[3] || "")}\n`);
  else if (command === "progress") process.stdout.write(`${formatTaskProgress(process.argv[3] || "")}\n`);
  else if (command === "status") process.stdout.write(`${formatSystemStatus()}\n`);
  else throw new Error(`Unknown command: ${command}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
