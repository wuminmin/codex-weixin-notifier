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
const CURRENT_PATH = `${STATE_DIR}/current-task.json`;
const SYNC_PATH = `${STATE_DIR}/command-sync.json`;
const LOG_DIR = `${STATE_DIR}/logs`;
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
const DEFAULT_TASK_ID = "0";
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

function defaultTaskCwd() {
  return valueFrom(process.env.CODEX_WEIXIN_DEFAULT_CWD, process.env.PWD, os.homedir());
}

function normalizeTasksState(state) {
  const tasks = Array.isArray(state?.tasks) ? [...state.tasks] : [];
  let nextTaskId = Number(state?.nextTaskId || 1);
  let defaultTask = tasks.find((task) => String(task.id) === DEFAULT_TASK_ID);
  if (!defaultTask) {
    defaultTask = {
      id: DEFAULT_TASK_ID,
      kind: "default",
      intent: "默认 Codex 助理",
      cwd: defaultTaskCwd(),
      status: "default",
      createdAt: new Date().toISOString(),
      pendingInstructions: [],
    };
    tasks.unshift(defaultTask);
  } else {
    defaultTask.kind = "default";
    defaultTask.intent = defaultTask.intent || "默认 Codex 助理";
    defaultTask.cwd = defaultTask.cwd || defaultTaskCwd();
    defaultTask.status = defaultTask.status || "default";
    defaultTask.pendingInstructions = Array.isArray(defaultTask.pendingInstructions) ? defaultTask.pendingInstructions : [];
  }

  for (const task of tasks) {
    const numericId = Number(task.id);
    if (Number.isInteger(numericId) && numericId >= nextTaskId) nextTaskId = numericId + 1;
  }
  return { tasks, nextTaskId: Math.max(1, nextTaskId) };
}

function loadTasks() {
  return normalizeTasksState(readJsonFile(TASKS_PATH, { tasks: [] }));
}

function saveTasks(state) {
  const normalized = normalizeTasksState(state);
  return writeJsonFile(TASKS_PATH, {
    tasks: normalized.tasks,
    nextTaskId: normalized.nextTaskId,
    updatedAt: new Date().toISOString(),
  });
}

function allocateTaskId() {
  const state = loadTasks();
  const id = String(state.nextTaskId || 1);
  state.nextTaskId = Number(id) + 1;
  saveTasks(state);
  return id;
}

function loadCurrentTasks() {
  return readJsonFile(CURRENT_PATH, { users: {} });
}

function saveCurrentTasks(state) {
  return writeJsonFile(CURRENT_PATH, {
    users: state.users && typeof state.users === "object" ? state.users : {},
    updatedAt: new Date().toISOString(),
  });
}

function userKey(fromUser) {
  return String(fromUser || "local");
}

function findTaskByTarget(target) {
  const state = loadTasks();
  const normalized = String(target || "").trim().replace(/^task\s+/i, "");
  return state.tasks.find((task) => {
    return String(task.id) === normalized
      || String(task.pid || "") === normalized
      || task.tmuxSession === normalized;
  }) || null;
}

function getCurrentTask(fromUser) {
  const current = loadCurrentTasks();
  const target = current.users?.[userKey(fromUser)]?.currentTask || DEFAULT_TASK_ID;
  return findTaskByTarget(target) || findTaskByTarget(DEFAULT_TASK_ID);
}

function setCurrentTask(fromUser, target) {
  const task = findTaskByTarget(target);
  if (!task) return { ok: false, message: `task ${target}: 不存在。发送 list 查看任务。` };
  const current = loadCurrentTasks();
  current.users[userKey(fromUser)] = {
    currentTask: String(task.id),
    setAt: new Date().toISOString(),
  };
  saveCurrentTasks(current);
  return {
    ok: true,
    task,
    message: [`task ${task.id}: 已切换`, `status=${task.status}`, `cwd=${task.cwd}`].join("\n"),
  };
}

function updateTask(taskId, updater) {
  const state = loadTasks();
  const index = state.tasks.findIndex((task) => String(task.id) === String(taskId));
  if (index === -1) return null;
  state.tasks[index] = updater({ ...state.tasks[index] });
  saveTasks(state);
  return state.tasks[index];
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

function isVerboseTaskReplies(config) {
  return config.verboseTaskReplies === true || process.env.CODEX_WEIXIN_VERBOSE_TASK_REPLIES === "1";
}

function taskHeader(taskId, text) {
  return `task ${taskId} · ${text}`;
}

function taskStatusText(status) {
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "running") return "运行中";
  if (status === "queued") return "排队中";
  if (status === "starting") return "启动中";
  return status || "未知";
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
  return sanitizeTmuxName(`codex-wx-task-${task.id}-${runId}`);
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

function startTmuxRun({ task, config, resumeSessionId = "", resumeLast = false, command, args, runId, stdoutPath, stderrPath, lastMessagePath }) {
  const sessionName = makeTmuxSessionName(task, runId);
  const shell = valueFrom(process.env.SHELL, "/bin/bash");
  const envPrefix = [
    ["CODEX_SESSION_ID", `weixin-task-${task.id}`],
    ["CODEX_PRODUCT", "codex-weixin-command-router"],
    ["CODEX_WEIXIN_ROUTER_TASK", "1"],
  ].map(([key, value]) => `${key}=${shQuote(value)}`).join(" ");
  const codexLine = [envPrefix, shQuote(command), ...args.map(shQuote)].filter(Boolean).join(" ");
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
  const logBase = expandHome(path.join(LOG_DIR, String(task.id), runId));
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
      CODEX_SESSION_ID: `weixin-task-${task.id}`,
      CODEX_PRODUCT: "codex-weixin-command-router",
      CODEX_WEIXIN_ROUTER_TASK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  runtimeChildren.set(String(task.id), child);
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
    runtimeChildren.delete(String(task.id));
    try {
      await completeTask({ taskId: task.id, runId, exitCode: code, signal, config });
    } catch (error) {
      appendTextFile(stderrPath, `\n[notify-error] ${error.stack || error.message}\n`);
    }
  });

  child.on("error", (error) => {
    runtimeChildren.delete(String(task.id));
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

function formatDefaultTaskPrompt(instruction) {
  return [
    "You are task 0, the default Codex assistant behind a Weixin chat.",
    "You decide whether the user's message can be answered directly, needs a short clarification, or should become a separate Codex subtask.",
    "Do not use confirmation prompts as the main workflow.",
    "",
    "If a separate subtask should be started, include exactly one JSON object on its own line at the end of your final answer:",
    '{"type":"create_task","cwd":"/absolute/workdir","prompt":"the full task instruction"}',
    "",
    "Use an existing absolute cwd when you can infer it. If you cannot infer a safe cwd, ask a concise clarification instead of creating a task.",
    "If you answer directly or ask a clarification, do not include the JSON protocol.",
    "",
    "Weixin user message:",
    instruction,
  ].join("\n");
}

function formatAppendPrompt(task, instruction) {
  if (String(task.id) === DEFAULT_TASK_ID) return formatDefaultTaskPrompt(instruction);
  return [
    `Continue the existing task ${task.id}.`,
    `Original task: ${task.intent}`,
    "",
    "Additional instruction from Weixin:",
    instruction,
  ].join("\n");
}

function extractCreateTaskDirective(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "create_task" && parsed.cwd && parsed.prompt) return parsed;
    } catch {
      // Ignore non-protocol JSON-like text.
    }
  }
  return null;
}

function createNumberedTask({ prompt, cwd, fromUser = "", kind = "subtask", parentTaskId = DEFAULT_TASK_ID, config }) {
  const resolvedCwd = expandHome(cwd);
  try {
    if (!fs.statSync(resolvedCwd).isDirectory()) {
      return { ok: false, message: `task ${parentTaskId}: 子任务目录不存在：${resolvedCwd}` };
    }
  } catch {
    return { ok: false, message: `task ${parentTaskId}: 子任务目录不存在：${resolvedCwd}` };
  }

  const task = {
    id: allocateTaskId(),
    kind,
    parentTaskId,
    intent: prompt,
    cwd: resolvedCwd,
    status: "starting",
    fromUser,
    createdAt: new Date().toISOString(),
    pendingInstructions: [],
  };
  const state = loadTasks();
  state.tasks.unshift(task);
  saveTasks(state);
  const run = startCodexRun({ task, prompt, config });
  return {
    ok: true,
    task: { ...task, pid: run.pid },
    message: isVerboseTaskReplies(config)
      ? [
        taskHeader(parentTaskId, `已创建 task ${task.id}`),
        `cwd: ${task.cwd}`,
        run.tmuxSession ? `tmux: ${run.tmuxSession}` : null,
        run.pid ? `pid: ${run.pid}` : null,
      ].filter(Boolean).join("\n")
      : [taskHeader(parentTaskId, `已创建 task ${task.id}`), `cwd: ${task.cwd}`].join("\n"),
  };
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
  const queued = Array.isArray(latest.pendingInstructions) ? [...latest.pendingInstructions] : [];
  if (queued.length > 0) {
    const nextInstruction = queued.shift();
    const updated = updateTask(latest.id, (current) => ({
      ...current,
      pendingInstructions: queued,
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
  const directive = String(latest.id) === DEFAULT_TASK_ID ? extractCreateTaskDirective(last) : null;
  if (directive) {
    const created = createNumberedTask({
      prompt: directive.prompt,
      cwd: directive.cwd,
      fromUser: latest.fromUser || "",
      parentTaskId: latest.id,
      config,
    });
    await sendText(created.message, config);
    return latest;
  }

  const statusText = taskStatusText(latest.status);
  const lines = [taskHeader(latest.id, statusText)];
  if (latest.status !== "completed") lines.push(`exit: ${numericExit === null ? signal || "unknown" : numericExit}`);
  if (isVerboseTaskReplies(config)) {
    lines.push(`cwd: ${latest.cwd}`);
    if (latest.tmuxSession) lines.push(`tmux: ${latest.tmuxSession}`);
  }
  if (last) lines.push("", compact(last, 1000));
  await sendText(lines.join("\n"), config);
  return latest;
}

function forwardToTask(task, text, config, fromUser = "") {
  const instruction = String(text || "").trim();
  if (!instruction) return `task ${task.id}: 空消息已忽略`;

  const entry = {
    id: createId("inst"),
    text: instruction,
    addedAt: new Date().toISOString(),
  };

  if (["running", "starting", "queued"].includes(task.status)) {
    const updated = updateTask(task.id, (current) => ({
      ...current,
      fromUser: fromUser || current.fromUser || "",
      pendingInstructions: [...(current.pendingInstructions || []), entry.text],
      updatedAt: new Date().toISOString(),
    }));
    return `${taskHeader(updated.id, "已排队")} (${updated.pendingInstructions.length})`;
  }

  const updated = updateTask(task.id, (current) => ({
    ...current,
    fromUser: fromUser || current.fromUser || "",
    status: "queued",
    updatedAt: new Date().toISOString(),
  }));
  startCodexRun({
    task: updated,
    prompt: formatAppendPrompt(updated, entry.text),
    config,
    resumeSessionId: updated.codexSessionId || "",
    resumeLast: !updated.codexSessionId && Boolean(updated.resumeLast),
  });
  return taskHeader(updated.id, "处理中");
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

function formatTaskLine(task, fromUser = "") {
  const current = getCurrentTask(fromUser);
  const tags = [];
  if (String(task.id) === DEFAULT_TASK_ID) tags.push("default");
  else tags.push(task.status || "unknown");
  if (String(current?.id) === String(task.id)) tags.push("current");
  return [
    `task ${task.id} [${tags.join(",")}]`,
    `cwd=${task.cwd}`,
    task.intent ? compact(task.intent, 120) : null,
  ].filter(Boolean).join(" ");
}

async function formatList(fromUser = "") {
  const state = pruneDeadTasks();
  const ordered = state.tasks
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));
  return ordered.map((task) => formatTaskLine(task, fromUser)).join("\n");
}

function parseCommand(text) {
  const trimmed = String(text || "").trim();
  if (/^list$/iu.test(trimmed)) return { type: "list" };
  const taskMatch = trimmed.match(/^task\s+(\d+)$/iu);
  if (taskMatch) return { type: "switch", id: taskMatch[1] };
  return { type: "message", text: trimmed };
}

async function handleText(text, fromUser, config) {
  const command = parseCommand(text);
  if (command.type === "list") return formatList(fromUser);
  if (command.type === "switch") return setCurrentTask(fromUser, command.id).message;

  const task = getCurrentTask(fromUser);
  if (!task) return "task 0: 状态异常，未找到默认任务。";
  return forwardToTask(task, command.text, config, fromUser);
}

async function runOnce(args, config) {
  const text = valueFrom(args.message, args._.join(" "));
  if (!text) throw new Error("Missing --message for --once.");
  const response = await handleText(text, "local", config);
  process.stdout.write(`${response}\n`);
}

async function runPoll(args, config) {
  let sync = loadCommandSync();
  process.stdout.write("Listening for Weixin Codex tasks. Send 'list' or 'task 0'.\n");

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
        const response = await handleText(text, replyTarget, config);
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
  saveTasks(loadTasks());

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
