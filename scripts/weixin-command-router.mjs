#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATH = "~/.codex/weixin-notifier.json";
const COMPAT_ACCOUNT_PATH = "~/.codex/channels/wechat/account.json";
const STATE_DIR = "~/.codex/weixin-notifier";
const TASKS_PATH = `${STATE_DIR}/tasks.json`;
const PENDING_PATH = `${STATE_DIR}/pending.json`;
const SYNC_PATH = `${STATE_DIR}/command-sync.json`;
const LOG_DIR = `${STATE_DIR}/logs`;
const FOCUS_PATH = `${STATE_DIR}/focus.json`;
const COMPAT_SYNC_PATH = "~/.codex/channels/wechat/sync_buf.json";
const COMPAT_CONTEXT_TOKENS_PATH = "~/.codex/channels/wechat/context_tokens.json";
const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_TIMEOUT_MS = 35_000;
const LOOP_DELAY_MS = 1000;
const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const MESSAGE_ITEM_TEXT = 1;
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const DEFAULT_RUNNER = "tmux";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

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

function writeTextFile(filePath, text) {
  const resolved = expandHome(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, text, "utf8");
  return resolved;
}

function valueFrom(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function splitWords(value) {
  return String(value || "").split(/\s+/).filter(Boolean);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandExists(command) {
  if (!command) return false;
  const result = spawnSync("sh", ["-lc", `command -v ${shQuote(command)} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return result.status === 0;
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

function pendingOwnerKey(request) {
  return request?.fromUser ? `user:${focusKey(request.fromUser)}` : "local";
}

function normalizePendingRequests(requests) {
  const seen = new Set();
  const normalized = [];
  for (const request of Array.isArray(requests) ? requests : []) {
    const key = pendingOwnerKey(request);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(request);
  }
  return normalized;
}

function loadPending() {
  const pending = readJsonFile(PENDING_PATH, { requests: [] });
  return {
    ...pending,
    requests: normalizePendingRequests(pending.requests),
  };
}

function savePending(state) {
  return writeJsonFile(PENDING_PATH, {
    requests: normalizePendingRequests(state.requests),
    updatedAt: new Date().toISOString(),
  });
}

function latestPendingForUser(fromUser) {
  const pending = loadPending();
  const requests = Array.isArray(pending.requests) ? pending.requests : [];
  const key = focusKey(fromUser);
  return requests.find((request) => focusKey(request.fromUser) === key)
    || requests.find((request) => !request.fromUser)
    || null;
}

function removePending(requestId) {
  const pending = loadPending();
  const before = pending.requests.length;
  pending.requests = pending.requests.filter((item) => item.id !== requestId);
  savePending(pending);
  return before !== pending.requests.length;
}

function updatePending(requestId, updater) {
  const pending = loadPending();
  const index = pending.requests.findIndex((item) => item.id === requestId);
  if (index === -1) return null;
  pending.requests[index] = updater({ ...pending.requests[index] });
  savePending(pending);
  return pending.requests[index];
}

function loadFocus() {
  return readJsonFile(FOCUS_PATH, { users: {} });
}

function saveFocus(state) {
  return writeJsonFile(FOCUS_PATH, {
    users: state.users && typeof state.users === "object" ? state.users : {},
    updatedAt: new Date().toISOString(),
  });
}

function focusKey(fromUser) {
  return String(fromUser || "local");
}

function getFocusedTask(fromUser) {
  const state = loadFocus();
  const entry = state.users?.[focusKey(fromUser)];
  if (!entry?.target) return null;
  const task = findTaskByTarget(entry.target);
  if (!task) {
    delete state.users[focusKey(fromUser)];
    saveFocus(state);
    return null;
  }
  return task;
}

function setFocusedTask(fromUser, target) {
  const task = findTaskByTarget(target);
  if (!task) return { ok: false, message: `No task matches ${target}. Use list to see recent task ids.` };
  const state = loadFocus();
  state.users[focusKey(fromUser)] = {
    target: task.id,
    setAt: new Date().toISOString(),
  };
  saveFocus(state);
  return {
    ok: true,
    task,
    message: [
      `Focused task ${task.id}`,
      `Status: ${task.status}`,
      `Cwd: ${task.cwd}`,
      "Plain messages will append to this task. Use unfocus to return plain messages to new-task mode.",
    ].join("\n"),
  };
}

function clearFocusedTask(fromUser) {
  const state = loadFocus();
  const key = focusKey(fromUser);
  const existed = Boolean(state.users?.[key]);
  delete state.users[key];
  saveFocus(state);
  return existed ? "Cleared focused task." : "No focused task was set.";
}

function loadCommandSync() {
  const commandSync = readJsonFile(SYNC_PATH, {});
  if (commandSync.get_updates_buf) return commandSync.get_updates_buf;
  return readJsonFile(COMPAT_SYNC_PATH, {}).get_updates_buf || "";
}

function rememberRecipientContext(config, message, sync) {
  const replyTarget = getReplyTarget(message, config);
  const contextToken = message?.context_token;
  if (!replyTarget || !contextToken) return;

  const updated = {
    ...readJsonFile(config.configPath, {}),
    toUser: replyTarget,
    contextToken,
    boundFromUser: message.from_user_id,
    boundGroup: message.group_id,
    boundMessageId: message.message_id,
    boundText: extractText(message),
    boundAt: new Date().toISOString(),
  };
  writeJsonFile(config.configPath, updated);
  config.toUser = replyTarget;
  config.contextToken = contextToken;

  const contextTokens = readJsonFile(COMPAT_CONTEXT_TOKENS_PATH, {});
  contextTokens[replyTarget] = contextToken;
  if (message.from_user_id) contextTokens[message.from_user_id] = contextToken;
  writeJsonFile(COMPAT_CONTEXT_TOKENS_PATH, contextTokens);

  writeJsonFile(COMPAT_SYNC_PATH, { get_updates_buf: sync || "", updatedAt: new Date().toISOString() });
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

function codexArgGroups(config) {
  const configuredGlobal = Array.isArray(config.codexGlobalArgs)
    ? config.codexGlobalArgs
    : splitWords(process.env.CODEX_WEIXIN_CODEX_GLOBAL_ARGS);
  const configured = Array.isArray(config.codexArgs)
    ? config.codexArgs
    : splitWords(process.env.CODEX_WEIXIN_CODEX_ARGS);
  const globalArgs = [...configuredGlobal];
  const execArgs = [];

  for (let i = 0; i < configured.length; i += 1) {
    const arg = configured[i];
    if (arg.startsWith("--ask-for-approval=") || arg.startsWith("-a=")) {
      globalArgs.push(arg);
      continue;
    }
    if (arg === "--ask-for-approval" || arg === "-a") {
      globalArgs.push(arg);
      if (configured[i + 1]) {
        globalArgs.push(configured[i + 1]);
        i += 1;
      }
      continue;
    }
    execArgs.push(arg);
  }

  if (!globalArgs.length && !execArgs.length) {
    return {
      globalArgs: ["--ask-for-approval", "never"],
      execArgs: ["--json", "--skip-git-repo-check"],
    };
  }

  return { globalArgs, execArgs };
}

function buildCodexArgs({ prompt, cwd, outputLastMessage, config, resumeSessionId, resumeLast = false }) {
  const { globalArgs, execArgs } = codexArgGroups(config);

  if (resumeSessionId || resumeLast) {
    return [
      ...globalArgs,
      "exec",
      "resume",
      ...execArgs,
      "-o",
      outputLastMessage,
      ...(resumeSessionId ? [resumeSessionId] : ["--last"]),
      prompt,
    ];
  }

  return [
    ...globalArgs,
    "exec",
    ...execArgs,
    "-C",
    cwd,
    "-o",
    outputLastMessage,
    prompt,
  ];
}

function selectedRunner(config) {
  const requested = valueFrom(process.env.CODEX_WEIXIN_RUNNER, config.runner, DEFAULT_RUNNER);
  const normalized = String(requested).toLowerCase();
  if (normalized === "spawn" || normalized === "direct") return "spawn";
  if (normalized === "tmux" && commandExists("tmux")) return "tmux";
  return "spawn";
}

function sanitizeTmuxName(value) {
  return String(value || "codex-wx")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "codex-wx";
}

function makeTmuxSessionName(task, runId) {
  return sanitizeTmuxName(`codex-wx-${task.id}-${runId}`);
}

function tmuxHasSession(sessionName) {
  if (!sessionName) return false;
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
  return result.status === 0;
}

function getTmuxPanePid(sessionName) {
  if (!sessionName) return "";
  const result = spawnSync("tmux", ["display-message", "-p", "-t", sessionName, "#{pane_pid}"], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function startTmuxRun({ task, prompt, config, resumeSessionId = "", resumeLast = false, command, args, runId, stdoutPath, stderrPath, lastMessagePath }) {
  const sessionName = makeTmuxSessionName(task, runId);
  const shell = valueFrom(process.env.SHELL, "/bin/bash");
  const envPrefix = [
    ["CODEX_SESSION_ID", task.id],
    ["CODEX_PRODUCT", "codex-weixin-command-router"],
  ].map(([key, value]) => `${key}=${shQuote(value)}`).join(" ");
  const codexLine = [
    envPrefix,
    shQuote(command),
    ...args.map(shQuote),
  ].filter(Boolean).join(" ");
  const completionLine = [
    shQuote(process.execPath),
    shQuote(SCRIPT_PATH),
    "--complete-task",
    "--task-id",
    shQuote(task.id),
    "--run-id",
    shQuote(runId),
    "--exit-code",
    '"$code"',
    "--config",
    shQuote(config.configPath),
    ">>",
    shQuote(stderrPath),
    "2>&1",
  ].join(" ");
  const script = [
    "set -u",
    `cd ${shQuote(task.cwd)} || exit 127`,
    `: > ${shQuote(stdoutPath)}`,
    `: > ${shQuote(stderrPath)}`,
    `printf '%s\\n' ${shQuote(`Codex Weixin task ${task.id}`)}`,
    `printf '%s\\n' ${shQuote(`cwd: ${task.cwd}`)}`,
    `printf '%s\\n' ${shQuote(`logs: ${stdoutPath}`)}`,
    `${codexLine} > >(tee -a ${shQuote(stdoutPath)}) 2> >(tee -a ${shQuote(stderrPath)} >&2)`,
    "code=$?",
    completionLine,
    `printf '\\n[Codex Weixin task ${task.id} finished with exit %s.]\\n' "$code"`,
    "printf '[Attach remains open for inspection. Press Ctrl-D to close.]\\n'",
    `exec ${shQuote(shell)} -l`,
  ].join("\n");

  const tmux = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", task.cwd, "/bin/bash", "-lc", script], {
    encoding: "utf8",
  });
  if (tmux.status !== 0) {
    throw new Error(`tmux start failed: ${tmux.stderr || tmux.stdout || `exit ${tmux.status}`}`);
  }

  const panePid = getTmuxPanePid(sessionName);
  updateTask(task.id, (current) => ({
    ...current,
    status: "running",
    runner: "tmux",
    tmuxSession: sessionName,
    tmuxAttach: `tmux attach -t ${sessionName}`,
    tmuxPanePid: panePid,
    pid: panePid || current.pid,
    runId,
    startedAt: current.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: { stdout: stdoutPath, stderr: stderrPath, lastMessage: lastMessagePath },
    resumeOf: resumeSessionId || current.resumeOf || "",
    resumeLast: Boolean(resumeLast || current.resumeLast),
  }));

  return { pid: panePid, tmuxSession: sessionName, stdoutPath, stderrPath, lastMessagePath };
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

  if (selectedRunner(config) === "tmux") {
    return startTmuxRun({
      task,
      prompt,
      config,
      resumeSessionId,
      resumeLast,
      command,
      args,
      runId,
      stdoutPath,
      stderrPath,
      lastMessagePath,
    });
  }

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
  writeTextFile(stdoutPath, "");
  writeTextFile(stderrPath, "");

  updateTask(task.id, (current) => ({
    ...current,
    status: "running",
    runner: "spawn",
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
    try {
      await completeTask({ taskId: task.id, runId, exitCode: code, signal, config });
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

function extractSessionIdFromJsonl(filePath) {
  if (!filePath) return "";
  try {
    const text = fs.readFileSync(filePath, "utf8");
    let found = "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const sessionId = extractSessionId(JSON.parse(line));
        if (sessionId) found = sessionId;
      } catch {
        // Ignore non-JSON terminal output.
      }
    }
    return found;
  } catch {
    return "";
  }
}

async function completeTask({ taskId, runId, exitCode, signal = "", config }) {
  const numericExit = exitCode === null || exitCode === undefined || exitCode === ""
    ? null
    : Number(exitCode);
  const finishedAt = new Date().toISOString();
  const latest = updateTask(taskId, (current) => {
    const codexSessionId = current.codexSessionId || extractSessionIdFromJsonl(current.logs?.stdout);
    return {
      ...current,
      status: numericExit === 0 ? "completed" : "failed",
      exitCode: numericExit,
      signal,
      codexSessionId,
      finishedAt,
      updatedAt: finishedAt,
    };
  });

  if (!latest) return null;
  const pending = Array.isArray(latest.pendingInstructions) ? [...latest.pendingInstructions] : [];
  if (pending.length > 0) {
    const nextInstruction = pending.shift();
    const updated = updateTask(latest.id, (current) => ({
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
    return updated;
  }

  const last = readLastMessage(latest);
  await sendText(
    [
      `Task ${latest.id} ${latest.status}`,
      `Exit: ${numericExit === null ? signal || "unknown" : numericExit}`,
      `Runner: ${latest.runner || "spawn"}`,
      latest.tmuxSession ? `Tmux: ${latest.tmuxSession}` : null,
      latest.tmuxAttach ? `Attach: ${latest.tmuxAttach}` : null,
      `Cwd: ${latest.cwd}`,
      last ? "" : null,
      last ? compact(last, 1200) : null,
    ].filter(Boolean).join("\n"),
    config,
  );
  return latest;
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
  const withoutPrefix = normalized.replace(/^(task|pid|tmux):/i, "");
  return state.tasks.find((task) => {
    return task.id === withoutPrefix
      || task.id.startsWith(withoutPrefix)
      || String(task.pid || "") === withoutPrefix
      || task.tmuxSession === withoutPrefix
      || String(task.tmuxSession || "").startsWith(withoutPrefix);
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
      `Runner: ${run.tmuxSession ? "tmux" : "spawn"}`,
      run.pid ? `PID: ${run.pid}` : null,
      run.tmuxSession ? `Tmux: ${run.tmuxSession}` : null,
      run.tmuxSession ? `Attach: tmux attach -t ${run.tmuxSession}` : null,
      `Cwd: ${task.cwd}`,
      `Intent: ${compact(task.intent)}`,
    ].filter(Boolean).join("\n"),
  };
}

function createPendingTask(intent, fromUser, config, args) {
  const proposal = proposeWorkdir(intent, config, args);
  const request = {
    id: createId("req"),
    kind: "create",
    summary: "启动新任务",
    text: intent,
    intent,
    cwd: proposal.cwd,
    proposedCwd: proposal.cwd,
    reason: proposal.reason,
    fromUser,
    status: "pending_yes_no",
    createdAt: new Date().toISOString(),
  };
  const pending = loadPending();
  pending.requests = pending.requests.filter((item) => pendingOwnerKey(item) !== pendingOwnerKey(request));
  pending.requests.unshift(request);
  savePending(pending);
  return request;
}

function createPendingAction(action) {
  const pending = loadPending();
  const request = {
    id: createId("req"),
    status: "pending_yes_no",
    createdAt: new Date().toISOString(),
    ...action,
  };
  pending.requests = pending.requests.filter((item) => pendingOwnerKey(item) !== pendingOwnerKey(request));
  pending.requests.unshift(request);
  savePending(pending);
  return request;
}

function recentFinishedTasks(limit = 8) {
  const state = loadTasks();
  return (state.tasks || [])
    .filter((task) => ["completed", "failed", "unknown", "running", "queued", "starting"].includes(task.status))
    .sort((a, b) => String(b.updatedAt || b.finishedAt || b.createdAt).localeCompare(String(a.updatedAt || a.finishedAt || a.createdAt)))
    .slice(0, limit);
}

function scoreTaskForText(task, text) {
  const haystack = [
    task.id,
    task.cwd,
    path.basename(task.cwd || ""),
    task.intent,
    task.tmuxSession,
  ].join("\n").toLowerCase();
  let score = 0;
  for (const token of tokenize(text)) {
    if (haystack.includes(token)) score += token.length > 3 ? 4 : 1;
  }
  if (/刚才|继续|追加|补充|再|日志|修复|检查|看一下/u.test(text)) score += 1;
  return score;
}

function chooseTaskForText(text, fromUser) {
  const focused = getFocusedTask(fromUser);
  if (focused) return focused;

  let best = null;
  let bestScore = 0;
  for (const task of recentFinishedTasks(12)) {
    const score = scoreTaskForText(task, text);
    if (score > bestScore) {
      best = task;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function planNaturalMessage(text, fromUser, config, args) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return createPendingAction({
      kind: "ask",
      fromUser,
      question: "你想让我做什么？",
      summary: "需要补充需求",
    });
  }

  if (/^(状态|看看|查看|最近|任务|进度|结果)/u.test(trimmed) || /任务.*(状态|列表|进度|结果)/u.test(trimmed)) {
    return createPendingAction({
      kind: "view",
      fromUser,
      summary: "显示任务状态和最近任务",
    });
  }

  const wantsCreate = /(新任务|启动|开始|创建|新开|另开|从头)/u.test(trimmed)
    || /^(帮我|请|处理|做|实现|修复|检查|改|写)/u.test(trimmed);
  const wantsSend = /(继续|追加|补充|接着|刚才|那个|这个|日志|再)/u.test(trimmed);
  const target = wantsCreate ? null : (wantsSend ? chooseTaskForText(trimmed, fromUser) : getFocusedTask(fromUser));

  if (target) {
    return createPendingAction({
      kind: "send",
      fromUser,
      target: target.id,
      text: trimmed,
      summary: `发送给 ${target.id}`,
    });
  }

  const proposal = proposeWorkdir(trimmed, config, args);
  return createPendingAction({
    kind: "create",
    fromUser,
    summary: "启动新任务",
    text: trimmed,
    intent: trimmed,
    cwd: proposal.cwd,
    proposedCwd: proposal.cwd,
    reason: proposal.reason,
  });
}

function listChildDirs(parent, limit = 12) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(parent, entry.name))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function meaningfulPathTokens(text) {
  return tokenize(text)
    .filter((token) => ![
      "是",
      "不是",
      "目录",
      "里面",
      "子文件夹",
      "文件夹",
      "godot",
      "应该",
      "改成",
      "换成",
      "the",
      "subfolder",
      "folder",
    ].includes(token));
}

function chooseChildDir(parent, text) {
  const tokens = meaningfulPathTokens(text);
  if (!tokens.length) return null;
  let best = null;
  let bestScore = 0;
  for (const child of listChildDirs(parent, 200)) {
    const name = path.basename(child).toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (name.includes(token.toLowerCase())) score += token.length > 3 ? 4 : 1;
    }
    if (score > bestScore) {
      best = child;
      bestScore = score;
    }
  }
  return best;
}

function revisePendingAction(text, fromUser, config, args) {
  const request = latestPendingForUser(fromUser);
  if (!request) return null;
  const kind = request.kind || "create";
  const trimmed = String(text || "").trim();
  if (!trimmed) return formatProposal(request);

  if (kind === "create") {
    const currentCwd = request.cwd || request.proposedCwd;
    if (/子文件夹|subfolder/i.test(trimmed) && currentCwd) {
      const child = chooseChildDir(currentCwd, trimmed);
      if (!child) {
        const children = listChildDirs(currentCwd, 8).map((dir) => path.basename(dir));
        return [
          "我理解你是在修正当前准备动作：目录要用 godot 的子文件夹。",
          "但还缺子文件夹名字。",
          children.length ? `可见子目录：${children.join(", ")}` : null,
          "",
          "直接发子文件夹名字；yes 仍会用当前目录。",
        ].filter(Boolean).join("\n");
      }
      const updated = updatePending(request.id, (current) => ({
        ...current,
        cwd: child,
        proposedCwd: child,
        text: current.text || current.intent,
        clarification: compact(trimmed, 300),
        reason: `updated from clarification: ${trimmed}`,
        updatedAt: new Date().toISOString(),
      }));
      return [
        "已修改当前准备动作。",
        "",
        formatProposal(updated),
      ].join("\n");
    }

    const explicit = findPathHint(trimmed);
    const combined = [request.text || request.intent, trimmed].filter(Boolean).join("\n");
    const proposal = explicit
      ? { cwd: explicit, reason: "the clarification includes an existing directory path" }
      : proposeWorkdir(combined, config, args);
    const updated = updatePending(request.id, (current) => ({
      ...current,
      text: combined,
      intent: combined,
      cwd: proposal.cwd,
      proposedCwd: proposal.cwd,
      clarification: compact(trimmed, 300),
      reason: proposal.reason,
      updatedAt: new Date().toISOString(),
    }));
    return [
      "已按补充说明修改当前准备动作。",
      "",
      formatProposal(updated),
    ].join("\n");
  }

  if (kind === "send") {
    const updated = updatePending(request.id, (current) => ({
      ...current,
      text: [current.text || current.instruction, trimmed].filter(Boolean).join("\n"),
      updatedAt: new Date().toISOString(),
    }));
    return [
      "已修改当前准备发送的内容。",
      "",
      formatProposal(updated),
    ].join("\n");
  }

  return null;
}

function cancelPending(requestId) {
  const pending = loadPending();
  const before = pending.requests.length;
  pending.requests = pending.requests.filter((item) => !(item.id === requestId || item.id.startsWith(requestId)));
  savePending(pending);
  return before !== pending.requests.length;
}

function formatProposal(request) {
  const kind = request.kind || "create";
  if (kind === "create") {
    return [
      "准备：启动新任务",
      `目录：${request.cwd || request.proposedCwd}`,
      `内容：${compact(request.text || request.intent, 500)}`,
      request.reason ? `依据：${request.reason}` : null,
      "",
      "回复 yes 执行，no 取消",
    ].filter(Boolean).join("\n");
  }
  if (kind === "send") {
    return [
      "准备：发送给已有任务",
      `目标：${request.target}`,
      `内容：${compact(request.text || request.instruction, 500)}`,
      "",
      "回复 yes 执行，no 取消",
    ].join("\n");
  }
  if (kind === "view") {
    return [
      "准备：查看状态",
      request.summary || "显示任务状态",
      "",
      "回复 yes 执行，no 取消",
    ].join("\n");
  }
  if (kind === "ask") {
    return request.question || request.summary || "我需要你再说明一下。";
  }

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
    if (task.runner === "tmux" || task.tmuxSession) {
      if (!tmuxHasSession(task.tmuxSession)) {
        task.status = "unknown";
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
      continue;
    }
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
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("PID ")) return null;
          const parts = trimmed.split(/\s+/, 5);
          const pid = parts[0] || "";
          const ppid = parts[1] || "";
          const stat = parts[2] || "";
          const comm = parts[3] || "";
          const command = parts[4] || "";
          if (comm !== "codex") return null;
          if (stat.includes("Z")) return null;
          if (/\bcodex\s+app-server\b/.test(trimmed)) return null;
          if (trimmed.includes("weixin-command-router.mjs")) return null;
          let cwd = "(unavailable)";
          try {
            cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
          } catch {
            // The process may exit between ps and cwd lookup.
          }
          return [
            `pid=${pid}`,
            `ppid=${ppid}`,
            `stat=${stat}`,
            `cwd=${cwd}`,
            `cmd=${compact(command, 160)}`,
          ].join(" | ");
        })
        .filter(Boolean)
        .slice(0, 20);
      resolve(rows);
    });
    proc.on("error", () => resolve([]));
  });
}

function formatTaskLine(task, intentMax = 100) {
  return [
    `${task.id} [${task.status}]`,
    `runner=${task.runner || "spawn"}`,
    task.tmuxSession ? `tmux=${task.tmuxSession}` : null,
    `pid=${task.pid || "-"}`,
    `cwd=${task.cwd}`,
    task.finishedAt ? `finished=${task.finishedAt}` : null,
    `intent=${compact(task.intent, intentMax)}`,
  ].filter(Boolean).join(" | ");
}

async function formatList(fromUser = "") {
  const state = pruneDeadTasks();
  const pending = loadPending();
  const taskLines = state.tasks
    .filter((task) => ["starting", "running", "queued", "unknown"].includes(task.status))
    .slice(0, 12)
    .map((task) => formatTaskLine(task));

  const recentLines = state.tasks
    .filter((task) => ["completed", "failed", "canceled"].includes(task.status))
    .sort((a, b) => String(b.finishedAt || b.updatedAt || b.createdAt).localeCompare(String(a.finishedAt || a.updatedAt || a.createdAt)))
    .slice(0, 8)
    .map((task) => formatTaskLine(task, 120));

  const pendingLines = pending.requests.slice(0, 8).map((request) => (
    `${request.id} [${request.kind || "create"}] | ${request.cwd || request.proposedCwd || request.target || "-"} | ${compact(request.text || request.intent || request.summary || request.question, 100)}`
  ));
  const processes = await listCodexProcesses();
  const focused = getFocusedTask(fromUser);

  return [
    focused ? `Focused task: ${focused.id} [${focused.status}] | cwd=${focused.cwd}` : "Focused task: (none)",
    "",
    "Codex Weixin tasks",
    taskLines.length ? taskLines.join("\n") : "(no active registered tasks)",
    "",
    "Recent completed tasks",
    recentLines.length ? recentLines.join("\n") : "(none)",
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

async function acceptPendingAction(fromUser, config) {
  const request = latestPendingForUser(fromUser);
  if (!request) return "没有待确认事项。直接发需求给我就行。";
  const kind = request.kind || "create";

  if (kind === "create") {
    const result = startTaskFromPending(request.id, request.cwd || request.proposedCwd, config);
    if (result.ok && result.task?.id) {
      setFocusedTask(fromUser, result.task.id);
    }
    return result.ok
      ? `${result.message}\n\n已自动切到这个任务。后续普通文字会先准备发送给它。`
      : result.message;
  }

  removePending(request.id);
  if (kind === "send") {
    const result = appendInstruction(request.target, request.text || request.instruction, config);
    if (result.ok) setFocusedTask(fromUser, request.target);
    return result.message;
  }

  if (kind === "view") {
    return formatList(fromUser);
  }

  if (kind === "ask") {
    return request.question || "我还需要你补充一句。";
  }

  return `未知待确认类型：${kind}`;
}

function rejectPendingAction(fromUser) {
  const request = latestPendingForUser(fromUser);
  if (!request) return "没有待取消事项。";
  removePending(request.id);
  return "已取消。";
}

function parseCommand(text) {
  const trimmed = String(text || "").trim();
  const yesPattern = /^(yes|y|ok|okay|好|好的|是|确认|可以|行|执行|启动|开始)$/iu;
  const noPattern = /^(no|n|nope|不|不要|否|取消|算了|停止)$/iu;
  const listPattern = /^(s|show|status|list|ls|tasks|processes|状态|进度|任务|列表|进程)$/iu;
  const helpPattern = /^(help|帮助|\?)$/iu;
  const focusStatusPattern = /^(focus|焦点)$/iu;
  const focusPattern = /^(focus|use|select|切换|选中|焦点)\s+(\S+)$/iu;
  const unfocusPattern = /^(unfocus|clear focus|取消焦点|退出焦点)$/iu;
  const confirmPattern = /^(confirm|确认|start|开始)\s+(\S+)(?:\s+(.+))?$/iu;
  const dirPattern = /^(dir|cwd|目录|工作目录)\s+(\S+)\s+(.+)$/iu;
  const cancelPattern = /^(cancel|取消)\s+(\S+)$/iu;
  const appendPattern = /^(append|追加|send|发|to|给|继续)\s+(\S+)\s+([\s\S]+)$/iu;
  const mentionPattern = /^@(\S+)\s+([\s\S]+)$/iu;
  const newPattern = /^(new|task|开始任务|新任务)\s+([\s\S]+)$/iu;

  let match = trimmed.match(listPattern);
  if (trimmed.match(yesPattern)) return { type: "yes" };
  if (trimmed.match(noPattern)) return { type: "no" };
  if (match) return { type: "list" };
  match = trimmed.match(helpPattern);
  if (match) return { type: "help" };
  match = trimmed.match(focusStatusPattern);
  if (match) return { type: "focus-status" };
  match = trimmed.match(focusPattern);
  if (match) return { type: "focus", target: match[2] };
  match = trimmed.match(unfocusPattern);
  if (match) return { type: "unfocus" };
  match = trimmed.match(confirmPattern);
  if (match) return { type: "confirm", id: match[2], cwd: match[3] || "" };
  match = trimmed.match(dirPattern);
  if (match) return { type: "confirm", id: match[2], cwd: match[3] };
  match = trimmed.match(cancelPattern);
  if (match) return { type: "cancel", id: match[2] };
  match = trimmed.match(appendPattern);
  if (match) return { type: "append", target: match[2], instruction: match[3] };
  match = trimmed.match(mentionPattern);
  if (match) return { type: "append", target: match[1], instruction: match[2] };
  match = trimmed.match(newPattern);
  if (match) return { type: "new", intent: match[2] };
  return { type: "message", text: trimmed };
}

function formatHelp(fromUser = "") {
  const focused = getFocusedTask(fromUser);
  return [
    "直接发需求，我会先给出准备动作。",
    "回复 yes 执行，no 取消。",
    "",
    "可选：s / show / list 查看状态",
    "可选：@task-id 补充指令",
    "",
    focused
      ? `当前默认目标：${focused.id}`
      : "当前没有默认目标。",
  ].join("\n");
}

async function handleText(text, fromUser, config, args) {
  const command = parseCommand(text);
  switch (command.type) {
    case "yes":
      return acceptPendingAction(fromUser, config);
    case "no":
      return rejectPendingAction(fromUser);
    case "list":
      return formatList(fromUser);
    case "help":
      return formatHelp(fromUser);
    case "focus-status": {
      const focused = getFocusedTask(fromUser);
      return focused
        ? `Focused task: ${focused.id} [${focused.status}]\nCwd: ${focused.cwd}\nPlain messages append to this task.`
        : "No focused task. Plain messages create a new pending task.";
    }
    case "focus":
      return setFocusedTask(fromUser, command.target).message;
    case "unfocus":
      return clearFocusedTask(fromUser);
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
    case "message": {
      if (!command.text) return formatHelp(fromUser);
      const revision = revisePendingAction(command.text, fromUser, config, args);
      if (revision) return revision;
      const request = planNaturalMessage(command.text, fromUser, config, args);
      return formatProposal(request);
    }
    default:
      return formatHelp(fromUser);
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
  let sync = loadCommandSync();
  process.stdout.write("Listening for Weixin Codex commands. Send 'list' to see tasks.\n");

  while (true) {
    const updates = await getUpdates(config, sync);
    sync = updates.get_updates_buf || sync;
    writeJsonFile(SYNC_PATH, { get_updates_buf: sync, updatedAt: new Date().toISOString() });
    for (const message of updates.msgs || []) {
      try {
        if (!isInboundUserMessage(message)) continue;
        const text = extractText(message);
        if (!text) continue;
        rememberRecipientContext(config, message, sync);
        const replyTarget = getReplyTarget(message, config);
        const response = await handleText(text, replyTarget, config, args);
        await sendText(response, {
          ...config,
          toUser: replyTarget || config.toUser,
          contextToken: message.context_token || config.contextToken,
        }, args);
      } catch (error) {
        appendTextFile(path.join(LOG_DIR, "router-errors.log"), `[${new Date().toISOString()}] ${error.stack || error.message}\n`);
        process.stderr.write(`${error.stack || error.message}\n`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Number(args.interval || LOOP_DELAY_MS)));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args);

  if (args["complete-task"] === "true") {
    await completeTask({
      taskId: valueFrom(args["task-id"], args.task),
      runId: args["run-id"] || "",
      exitCode: args["exit-code"],
      signal: args.signal || "",
      config,
    });
    return;
  }
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
