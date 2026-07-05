#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_CONFIG_PATH = "~/.codex/weixin-notifier.json";
const COMPAT_ACCOUNT_PATH = "~/.codex/channels/wechat/account.json";
const STATE_DIR = "~/.codex/weixin-notifier";
const TASKS_PATH = `${STATE_DIR}/tasks.json`;
const PENDING_PATH = `${STATE_DIR}/pending.json`;
const SYNC_PATH = `${STATE_DIR}/command-sync.json`;
const LOG_DIR = `${STATE_DIR}/logs`;
const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_TIMEOUT_MS = 35_000;
const LOOP_DELAY_MS = 1000;
const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const MESSAGE_ITEM_TEXT = 1;
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);

const runtimeChildren = new Map();

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function readJsonFile(filePath, fallback = {}) {
  const resolved = expandHome(filePath);
  try {
    if (!fs.existsSync(resolved)) return fallback;
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  const resolved = expandHome(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(resolved, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return resolved;
}

function appendTextFile(filePath, text) {
  const resolved = expandHome(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(resolved, text, "utf8");
}

function valueFrom(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildHeaders(token, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function postJson({ baseUrl, endpoint, token, headers, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = endpoint ? new URL(endpoint, ensureTrailingSlash(baseUrl)).toString() : baseUrl;
    const response = await fetch(url, {
      method: "POST",
      headers: headers || buildHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: body?.get_updates_buf || "" };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCompatAccount(account) {
  if (!account || Object.keys(account).length === 0) return {};
  return {
    transport: "ilink-login",
    baseUrl: account.baseUrl,
    token: account.token,
    botId: account.accountId,
    userId: account.userId,
    toUser: account.userId,
  };
}

function loadConfig(args) {
  const configPath = valueFrom(args.config, process.env.CODEX_WEIXIN_CONFIG, DEFAULT_CONFIG_PATH);
  return {
    ...normalizeCompatAccount(readJsonFile(COMPAT_ACCOUNT_PATH, {})),
    ...readJsonFile(configPath, {}),
    configPath,
  };
}

function isDryRun(args, config) {
  return args["dry-run"] === "true" || process.env.CODEX_WEIXIN_DRY_RUN === "1" || config.dryRun === true;
}

function loadTasks() {
  return readJsonFile(TASKS_PATH, { tasks: [] });
}

function saveTasks(state) {
  return writeJsonFile(TASKS_PATH, {
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    updatedAt: new Date().toISOString(),
  });
}

function loadPending() {
  return readJsonFile(PENDING_PATH, { requests: [] });
}

function savePending(state) {
  return writeJsonFile(PENDING_PATH, {
    requests: Array.isArray(state.requests) ? state.requests : [],
    updatedAt: new Date().toISOString(),
  });
}

function createId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${prefix}-${stamp}-${suffix}`;
}

function compact(text, max = 180) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_\-\u4e00-\u9fa5]+/u)
    .filter((token) => token.length >= 2);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function configuredWorkspaceRoots(config, args) {
  const raw = valueFrom(args["workspace-root"], process.env.CODEX_WEIXIN_WORKSPACE_ROOT, config.workspaceRoot);
  const roots = [];
  if (raw) roots.push(...String(raw).split(path.delimiter));
  roots.push(process.cwd(), "~/codex", "~/plugins", "~");
  return unique(roots.map(expandHome)).filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function findPathHint(intent) {
  const matches = String(intent || "").match(/(?:~|\/)[^\s'"`]+/g) || [];
  for (const match of matches) {
    const resolved = expandHome(match.replace(/[.,;:!?，。；：！？]+$/u, ""));
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Ignore invalid path-like text.
    }
  }
  return null;
}

function readProjectText(dir) {
  const names = [".codex-plugin/plugin.json", "package.json", "README.md", "pyproject.toml", "Cargo.toml"];
  const parts = [path.basename(dir), dir];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) parts.push(fs.readFileSync(file, "utf8").slice(0, 3000));
    } catch {
      // Optional project metadata.
    }
  }
  return parts.join("\n");
}

function collectCandidateDirs(roots) {
  const candidates = new Set();
  for (const root of roots) {
    candidates.add(root);
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.join(root, entry.name);
      candidates.add(child);
      let grandchildren = [];
      try {
        grandchildren = fs.readdirSync(child, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const grandchild of grandchildren) {
        if (!grandchild.isDirectory() || grandchild.name.startsWith(".")) continue;
        candidates.add(path.join(child, grandchild.name));
      }
    }
  }
  return [...candidates];
}

function scoreCandidate(dir, intentTokens) {
  const haystack = readProjectText(dir).toLowerCase();
  let score = 0;
  for (const token of intentTokens) {
    if (!token) continue;
    if (haystack.includes(token)) score += token.length > 3 ? 3 : 1;
    if (path.basename(dir).toLowerCase().includes(token)) score += 5;
  }
  for (const marker of [".git", ".codex-plugin", "package.json", "pyproject.toml"]) {
    try {
      if (fs.existsSync(path.join(dir, marker))) score += 1;
    } catch {
      // Ignore.
    }
  }
  return score;
}

function proposeWorkdir(intent, config, args) {
  const hinted = findPathHint(intent);
  if (hinted) {
    return { cwd: hinted, reason: "the instruction includes an existing directory path" };
  }

  const roots = configuredWorkspaceRoots(config, args);
  const tokens = tokenize(intent);
  const candidates = collectCandidateDirs(roots);
  let best = roots[0] || process.cwd();
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, tokens);
    if (score > bestScore || (score === bestScore && candidate.length < best.length)) {
      best = candidate;
      bestScore = score;
    }
  }

  const reason = bestScore > 0
    ? `matched ${bestScore} token/metadata signals from the task intent`
    : "no strong project match was found, so the router used the default workspace root";
  return { cwd: best, reason };
}

function extractText(message) {
  if (typeof message === "string") return message.trim();
  for (const item of message?.item_list || []) {
    const text = item?.text_item?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

function isInboundUserMessage(message) {
  return message?.message_type === MESSAGE_TYPE_USER;
}

function getReplyTarget(message, config) {
  return valueFrom(message?.group_id, message?.from_user_id, config.toUser, config.userId);
}

async function getUpdates(config, syncBuf) {
  if (!config.token) throw new Error("Missing token. Run pair-weixin.mjs first.");
  return postJson({
    baseUrl: config.baseUrl || DEFAULT_ILINK_BASE_URL,
    endpoint: "ilink/bot/getupdates",
    token: config.token,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    body: {
      get_updates_buf: syncBuf || "",
      base_info: { channel_version: "2.4.6" },
    },
  });
}

async function sendText(text, config, args = {}) {
  if (isDryRun(args, config)) {
    process.stdout.write(`${text}\n`);
    return;
  }

  const endpoint = valueFrom(config.endpoint, process.env.WEIXIN_ILINK_ENDPOINT);
  if (endpoint) {
    const body = {
      ...(config.body || {}),
      bot_id: valueFrom(config.botId, process.env.WEIXIN_ILINK_BOT_ID),
      to_user: valueFrom(config.toUser, process.env.WEIXIN_TO_USER),
      to_chat: valueFrom(config.toChat, process.env.WEIXIN_TO_CHAT),
      msg_type: "text",
      text: { content: text },
    };
    for (const key of Object.keys(body)) {
      if (body[key] === undefined || body[key] === null || body[key] === "") delete body[key];
    }
    await postJson({
      baseUrl: endpoint,
      endpoint: "",
      headers: {
        "content-type": "application/json",
        ...(config.headers || {}),
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body,
      timeoutMs: Number(valueFrom(config.timeoutMs, 8000)),
    });
    return;
  }

  const token = valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN);
  const toUser = valueFrom(config.toUser, config.userId, process.env.WEIXIN_TO_USER);
  const contextToken = valueFrom(config.contextToken, process.env.WEIXIN_CONTEXT_TOKEN);
  if (!token) throw new Error("Missing Weixin iLink token. Run pair-weixin.mjs first.");
  if (!toUser) throw new Error("Missing Weixin recipient. Run bind-recipient.mjs first.");
  if (!contextToken) throw new Error("Missing contextToken. Send a message to the bot, then run bind-recipient.mjs.");

  await postJson({
    baseUrl: config.baseUrl || DEFAULT_ILINK_BASE_URL,
    endpoint: "ilink/bot/sendmessage",
    token,
    timeoutMs: Number(valueFrom(config.timeoutMs, 8000)),
    body: {
      msg: {
        from_user_id: "",
        to_user_id: toUser,
        client_id: `codex-command-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [{ type: MESSAGE_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexWeixinNotifier/0.1.0",
      },
    },
  });
}

function updateTask(taskId, updater) {
  const state = loadTasks();
  const index = state.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) return null;
  state.tasks[index] = updater({ ...state.tasks[index] });
  saveTasks(state);
  return state.tasks[index];
}

function extractSessionId(value) {
  if (!value || typeof value !== "object") return "";
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if ((key === "session_id" || key === "sessionId") && typeof child === "string" && child.trim()) {
        return child.trim();
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return "";
}

function buildCodexArgs({ prompt, cwd, outputLastMessage, config, resumeSessionId, resumeLast = false }) {
  const configured = Array.isArray(config.codexArgs)
    ? config.codexArgs
    : String(process.env.CODEX_WEIXIN_CODEX_ARGS || "").split(/\s+/).filter(Boolean);
  const defaults = configured.length
    ? configured
    : ["--json", "--skip-git-repo-check", "--ask-for-approval", "never"];

  if (resumeSessionId || resumeLast) {
    return [
      "exec",
      "resume",
      ...defaults,
      "-o",
      outputLastMessage,
      ...(resumeSessionId ? [resumeSessionId] : ["--last"]),
      prompt,
    ];
  }

  return [
    "exec",
    ...defaults,
    "-C",
    cwd,
    "-o",
    outputLastMessage,
    prompt,
  ];
}

function startCodexRun({ task, prompt, config, resumeSessionId = "", resumeLast = false }) {
  const command = valueFrom(config.codexCommand, process.env.CODEX_WEIXIN_CODEX_COMMAND, "codex");
  const runId = createId(resumeSessionId ? "wxr" : "wxrun");
  const logBase = expandHome(path.join(LOG_DIR, task.id, runId));
  fs.mkdirSync(logBase, { recursive: true });
  const stdoutPath = path.join(logBase, "stdout.jsonl");
  const stderrPath = path.join(logBase, "stderr.log");
  const lastMessagePath = path.join(logBase, "last-message.txt");
  const args = buildCodexArgs({
    prompt,
    cwd: task.cwd,
    outputLastMessage: lastMessagePath,
    config,
    resumeSessionId,
    resumeLast,
  });

  const child = spawn(command, args, {
    cwd: task.cwd,
    env: {
      ...process.env,
      CODEX_SESSION_ID: task.id,
      CODEX_PRODUCT: "codex-weixin-command-router",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  runtimeChildren.set(task.id, child);
  appendTextFile(stdoutPath, "");
  appendTextFile(stderrPath, "");

  updateTask(task.id, (current) => ({
    ...current,
    status: "running",
    pid: child.pid,
    runId,
    startedAt: current.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: { stdout: stdoutPath, stderr: stderrPath, lastMessage: lastMessagePath },
    resumeOf: resumeSessionId || current.resumeOf || "",
    resumeLast: Boolean(resumeLast || current.resumeLast),
  }));

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    appendTextFile(stdoutPath, text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const sessionId = extractSessionId(event);
        if (sessionId) {
          updateTask(task.id, (current) => ({
            ...current,
            codexSessionId: current.codexSessionId || sessionId,
            updatedAt: new Date().toISOString(),
          }));
        }
      } catch {
        // Non-JSON output is still kept in the log.
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    appendTextFile(stderrPath, chunk.toString("utf8"));
  });

  child.on("exit", async (code, signal) => {
    runtimeChildren.delete(task.id);
    const finishedAt = new Date().toISOString();
    const latest = updateTask(task.id, (current) => ({
      ...current,
      status: code === 0 ? "completed" : "failed",
      exitCode: code,
      signal,
      finishedAt,
      updatedAt: finishedAt,
    }));

    if (!latest) return;
    const pending = Array.isArray(latest.pendingInstructions) ? latest.pendingInstructions : [];
    if (pending.length > 0) {
      const nextInstruction = pending.shift();
      const updated = updateTask(task.id, (current) => ({
        ...current,
        pendingInstructions: pending,
        status: "queued",
        updatedAt: new Date().toISOString(),
      }));
      if (updated) {
        startCodexRun({
          task: updated,
          prompt: formatAppendPrompt(updated, nextInstruction),
          config,
          resumeSessionId: updated.codexSessionId || "",
          resumeLast: !updated.codexSessionId && Boolean(updated.resumeLast),
        });
      }
      return;
    }

    try {
      const last = readLastMessage(latest);
      await sendText(
        [
          `Task ${latest.id} ${latest.status}`,
          `Exit: ${code === null ? signal : code}`,
          `Cwd: ${latest.cwd}`,
          last ? "" : null,
          last ? compact(last, 1200) : null,
        ].filter(Boolean).join("\n"),
        config,
      );
    } catch (error) {
      appendTextFile(stderrPath, `\n[notify-error] ${error.stack || error.message}\n`);
    }
  });

  child.on("error", (error) => {
    runtimeChildren.delete(task.id);
    updateTask(task.id, (current) => ({
      ...current,
      status: "failed",
      error: error.message,
      updatedAt: new Date().toISOString(),
    }));
  });

  return { pid: child.pid, stdoutPath, stderrPath, lastMessagePath };
}

function readLastMessage(task) {
  const file = task?.logs?.lastMessage;
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function formatAppendPrompt(task, instruction) {
  return [
    `Continue the existing task ${task.id}.`,
    `Original task: ${task.intent}`,
    "",
    "Additional instruction from Weixin:",
    instruction,
  ].join("\n");
}

function findTaskByTarget(target) {
  const state = loadTasks();
  const normalized = String(target || "").trim();
  const withoutPrefix = normalized.replace(/^(task|pid):/i, "");
  return state.tasks.find((task) => {
    return task.id === withoutPrefix
      || task.id.startsWith(withoutPrefix)
      || String(task.pid || "") === withoutPrefix;
  }) || null;
}

function readProcessInfo(pid) {
  const normalized = String(pid || "").replace(/^pid:/i, "");
  if (!/^\d+$/.test(normalized)) return null;
  try {
    const cwd = fs.readlinkSync(`/proc/${normalized}/cwd`);
    const cmdline = fs.readFileSync(`/proc/${normalized}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (!/\bcodex\b/.test(cmdline)) return null;
    if (/\bcodex\s+app-server\b/.test(cmdline)) return null;
    return { pid: Number(normalized), cwd, cmdline };
  } catch {
    return null;
  }
}

function startTaskFromPending(requestId, cwdOverride, config) {
  const pending = loadPending();
  const request = pending.requests.find((item) => item.id === requestId || item.id.startsWith(requestId));
  if (!request) return { ok: false, message: `No pending task matches ${requestId}.` };

  const cwd = expandHome(cwdOverride || request.proposedCwd);
  try {
    if (!fs.statSync(cwd).isDirectory()) return { ok: false, message: `Directory does not exist: ${cwd}` };
  } catch {
    return { ok: false, message: `Directory does not exist: ${cwd}` };
  }

  const task = {
    id: request.id.replace(/^req-/, "task-"),
    intent: request.intent,
    cwd,
    status: "starting",
    fromUser: request.fromUser,
    createdAt: request.createdAt,
    confirmedAt: new Date().toISOString(),
    pendingInstructions: [],
  };

  pending.requests = pending.requests.filter((item) => item.id !== request.id);
  savePending(pending);
  const state = loadTasks();
  state.tasks.unshift(task);
  saveTasks(state);
  const run = startCodexRun({ task, prompt: request.intent, config });
  return {
    ok: true,
    task: { ...task, pid: run.pid },
    message: [
      `Started task ${task.id}`,
      `PID: ${run.pid}`,
      `Cwd: ${task.cwd}`,
      `Intent: ${compact(task.intent)}`,
    ].join("\n"),
  };
}

function createPendingTask(intent, fromUser, config, args) {
  const proposal = proposeWorkdir(intent, config, args);
  const request = {
    id: createId("req"),
    intent,
    proposedCwd: proposal.cwd,
    reason: proposal.reason,
    fromUser,
    status: "pending_workdir_confirmation",
    createdAt: new Date().toISOString(),
  };
  const pending = loadPending();
  pending.requests.unshift(request);
  savePending(pending);
  return request;
}

function cancelPending(requestId) {
  const pending = loadPending();
  const before = pending.requests.length;
  pending.requests = pending.requests.filter((item) => !(item.id === requestId || item.id.startsWith(requestId)));
  savePending(pending);
  return before !== pending.requests.length;
}

function formatProposal(request) {
  return [
    `Ready to start ${request.id}`,
    `Intent: ${compact(request.intent, 500)}`,
    `Suggested cwd: ${request.proposedCwd}`,
    `Reason: ${request.reason}`,
    "",
    `Reply "confirm ${request.id}" to start.`,
    `Reply "dir ${request.id} /path/to/workspace" to change cwd and start.`,
    `Reply "cancel ${request.id}" to discard.`,
  ].join("\n");
}

function pruneDeadTasks() {
  const state = loadTasks();
  let changed = false;
  for (const task of state.tasks) {
    if (!["running", "starting", "queued"].includes(task.status)) continue;
    if (!task.pid) continue;
    try {
      process.kill(Number(task.pid), 0);
    } catch {
      task.status = task.status === "queued" ? "queued" : "unknown";
      task.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveTasks(state);
  return state;
}

function listCodexProcesses() {
  const proc = spawn("ps", ["-eo", "pid,ppid,stat,comm,args"], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve) => {
    const chunks = [];
    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.on("exit", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const rows = text.split(/\r?\n/)
        .filter((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("PID ")) return false;
          const parts = trimmed.split(/\s+/, 5);
          const comm = parts[3] || "";
          return comm === "codex"
            && !/\bcodex\s+app-server\b/.test(trimmed)
            && !trimmed.includes("weixin-command-router.mjs");
        })
        .slice(0, 20);
      resolve(rows);
    });
    proc.on("error", () => resolve([]));
  });
}

async function formatList() {
  const state = pruneDeadTasks();
  const pending = loadPending();
  const taskLines = state.tasks
    .filter((task) => ["starting", "running", "queued", "unknown"].includes(task.status))
    .slice(0, 12)
    .map((task) => [
      `${task.id} [${task.status}]`,
      `pid=${task.pid || "-"}`,
      `cwd=${task.cwd}`,
      `intent=${compact(task.intent, 100)}`,
    ].join(" | "));

  const pendingLines = pending.requests.slice(0, 8).map((request) => (
    `${request.id} [pending cwd] | cwd=${request.proposedCwd} | intent=${compact(request.intent, 100)}`
  ));
  const processes = await listCodexProcesses();

  return [
    "Codex Weixin tasks",
    taskLines.length ? taskLines.join("\n") : "(no active registered tasks)",
    "",
    "Pending confirmations",
    pendingLines.length ? pendingLines.join("\n") : "(none)",
    "",
    "Codex processes",
    processes.length ? processes.join("\n") : "(none found)",
  ].join("\n");
}

function appendInstruction(target, instruction, config) {
  const task = findTaskByTarget(target);
  if (!task) {
    const processInfo = readProcessInfo(target);
    if (!processInfo) {
      return {
        ok: false,
        message: `No registered task or Codex process matches ${target}. Use "list" to see task ids and pids.`,
      };
    }
    const followup = {
      id: createId("task"),
      intent: `Follow-up for external Codex process ${processInfo.pid}: ${instruction}`,
      cwd: processInfo.cwd,
      status: "starting",
      externalPid: processInfo.pid,
      externalCommand: processInfo.cmdline,
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      pendingInstructions: [],
      resumeLast: true,
    };
    const state = loadTasks();
    state.tasks.unshift(followup);
    saveTasks(state);
    startCodexRun({
      task: followup,
      prompt: [
        `Append this instruction to the most recent Codex session for process ${processInfo.pid}.`,
        "",
        instruction,
      ].join("\n"),
      config,
      resumeLast: true,
    });
    return {
      ok: true,
      message: [
        `Started follow-up for external Codex process ${processInfo.pid}.`,
        `Registered as ${followup.id}.`,
        `Cwd: ${processInfo.cwd}`,
        "The router uses `codex exec resume --last` in that cwd; arbitrary terminal injection is not attempted.",
      ].join("\n"),
    };
  }

  const entry = {
    id: createId("inst"),
    text: instruction,
    addedAt: new Date().toISOString(),
  };

  if (["running", "starting"].includes(task.status)) {
    const updated = updateTask(task.id, (current) => ({
      ...current,
      pendingInstructions: [...(current.pendingInstructions || []), entry.text],
      updatedAt: new Date().toISOString(),
    }));
    return {
      ok: true,
      message: [
        `Queued instruction for running task ${updated.id}.`,
        "It will run automatically after the current Codex turn finishes.",
        `Instruction: ${compact(entry.text, 500)}`,
      ].join("\n"),
    };
  }

  if (task.status === "queued") {
    const updated = updateTask(task.id, (current) => ({
      ...current,
      pendingInstructions: [...(current.pendingInstructions || []), entry.text],
      updatedAt: new Date().toISOString(),
    }));
    return {
      ok: true,
      message: `Queued another instruction for ${updated.id}.`,
    };
  }

  const updated = updateTask(task.id, (current) => ({
    ...current,
    status: "queued",
    pendingInstructions: [],
    updatedAt: new Date().toISOString(),
  }));
  if (!updated) {
    return { ok: false, message: `Could not update task ${task.id}.` };
  }
  startCodexRun({
    task: updated,
    prompt: formatAppendPrompt(updated, entry.text),
    config,
    resumeSessionId: updated.codexSessionId || "",
    resumeLast: !updated.codexSessionId && Boolean(updated.resumeLast),
  });
  return {
    ok: true,
    message: [
      `Started follow-up instruction for ${updated.id}.`,
      updated.codexSessionId ? `Resuming Codex session: ${updated.codexSessionId}` : "No session id was found; using task context in a new Codex run.",
    ].join("\n"),
  };
}

function parseCommand(text) {
  const trimmed = String(text || "").trim();
  const listPattern = /^(list|ls|tasks|processes|任务|列表|进程)$/iu;
  const confirmPattern = /^(confirm|确认|start|开始)\s+(\S+)(?:\s+(.+))?$/iu;
  const dirPattern = /^(dir|cwd|目录|工作目录)\s+(\S+)\s+(.+)$/iu;
  const cancelPattern = /^(cancel|取消)\s+(\S+)$/iu;
  const appendPattern = /^(append|追加|send|发)\s+(\S+)\s+([\s\S]+)$/iu;
  const newPattern = /^(new|task|开始任务|新任务)\s+([\s\S]+)$/iu;

  let match = trimmed.match(listPattern);
  if (match) return { type: "list" };
  match = trimmed.match(confirmPattern);
  if (match) return { type: "confirm", id: match[2], cwd: match[3] || "" };
  match = trimmed.match(dirPattern);
  if (match) return { type: "confirm", id: match[2], cwd: match[3] };
  match = trimmed.match(cancelPattern);
  if (match) return { type: "cancel", id: match[2] };
  match = trimmed.match(appendPattern);
  if (match) return { type: "append", target: match[2], instruction: match[3] };
  match = trimmed.match(newPattern);
  if (match) return { type: "new", intent: match[2] };
  return { type: "new", intent: trimmed };
}

async function handleText(text, fromUser, config, args) {
  const command = parseCommand(text);
  switch (command.type) {
    case "list":
      return formatList();
    case "confirm": {
      const result = startTaskFromPending(command.id, command.cwd, config);
      return result.message;
    }
    case "cancel":
      return cancelPending(command.id)
        ? `Canceled pending task ${command.id}.`
        : `No pending task matches ${command.id}.`;
    case "append": {
      const result = appendInstruction(command.target, command.instruction, config);
      return result.message;
    }
    case "new": {
      if (!command.intent) return "Send a task instruction, or use list / append <task-id> <instruction>.";
      const request = createPendingTask(command.intent, fromUser, config, args);
      return formatProposal(request);
    }
    default:
      return "Unknown command. Use list, new <task>, confirm <id>, dir <id> <cwd>, append <task-id> <instruction>, or cancel <id>.";
  }
}

async function runOnce(args, config) {
  const text = valueFrom(args.message, args._.join(" "));
  if (!text) throw new Error("Missing --message for --once.");
  const response = await handleText(text, "local", config, args);
  process.stdout.write(`${response}\n`);
}

async function runLocalAppend(args, config) {
  const target = valueFrom(args.target, args._[0]);
  const instruction = valueFrom(args.instruction, args._.slice(1).join(" "));
  if (!target || !instruction) throw new Error("Usage: --append --target <task-or-pid> --instruction <text>");
  const result = appendInstruction(target, instruction, config);
  process.stdout.write(`${result.message}\n`);
}

async function runPoll(args, config) {
  let sync = readJsonFile(SYNC_PATH, {}).get_updates_buf || "";
  process.stdout.write("Listening for Weixin Codex commands. Send 'list' to see tasks.\n");

  while (true) {
    const updates = await getUpdates(config, sync);
    sync = updates.get_updates_buf || sync;
    writeJsonFile(SYNC_PATH, { get_updates_buf: sync, updatedAt: new Date().toISOString() });
    for (const message of updates.msgs || []) {
      if (!isInboundUserMessage(message)) continue;
      const text = extractText(message);
      if (!text) continue;
      const replyTarget = getReplyTarget(message, config);
      const response = await handleText(text, replyTarget, config, args);
      await sendText(response, { ...config, toUser: replyTarget || config.toUser }, args);
    }
    await new Promise((resolve) => setTimeout(resolve, Number(args.interval || LOOP_DELAY_MS)));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args);

  if (args.list === "true") {
    process.stdout.write(`${await formatList()}\n`);
    return;
  }
  if (args.append === "true") {
    await runLocalAppend(args, config);
    return;
  }
  if (args.once === "true") {
    await runOnce(args, config);
    return;
  }
  await runPoll(args, config);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
