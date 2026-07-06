#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderMarkdownImage, terminalSnapshotMarkdown } from "./markdown-image-renderer.mjs";

const DEFAULT_CONFIG_PATH = "~/.codex/weixin-notifier.json";
const COMPAT_ACCOUNT_PATH = "~/.codex/channels/wechat/account.json";
const STATE_DIR = "~/.codex/weixin-notifier";
const TASKS_PATH = `${STATE_DIR}/tasks.json`;
const CURRENT_PATH = `${STATE_DIR}/current-task.json`;
const SYNC_PATH = `${STATE_DIR}/command-sync.json`;
const LOG_DIR = `${STATE_DIR}/logs`;
const TASK_WORKSPACE_ROOT = "~/codex";
const COMPAT_SYNC_PATH = "~/.codex/channels/wechat/sync_buf.json";
const COMPAT_CONTEXT_TOKENS_PATH = "~/.codex/channels/wechat/context_tokens.json";
const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_TIMEOUT_MS = 35_000;
const LOOP_DELAY_MS = 1000;
const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const MESSAGE_ITEM_TEXT = 1;
const MESSAGE_ITEM_IMAGE = 2;
const MESSAGE_ITEM_FILE = 4;
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const DEFAULT_RUNNER = "interactive";
const DEFAULT_TASK_ID = "0";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MEDIA_TYPE_IMAGE = 1;
const MEDIA_TYPE_FILE = 3;
const INBOUND_MEDIA_DIR = "inbox";
const DEFAULT_INTERACTIVE_CAPTURE_DELAY_MS = 3000;
const DEFAULT_INTERACTIVE_CAPTURE_LINES = 120;
const DEFAULT_INTERACTIVE_READY_TIMEOUT_MS = 20000;
const DEFAULT_INTERACTIVE_RESPONSE_TIMEOUT_MS = 60000;
const DEFAULT_INTERACTIVE_RESPONSE_POLL_MS = 1000;
const DEFAULT_MARKDOWN_IMAGE_WIDTH = 920;
const DEFAULT_MARKDOWN_IMAGE_MAX_CHARS = 12_000;
const DEFAULT_MARKDOWN_IMAGE_MAX_HEIGHT = 6000;

const EXTENSION_TO_MIME = {
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".tar": "application/x-tar",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

const IMAGE_MIME_PREFIX = "image/";
const MIME_TO_EXTENSION = Object.fromEntries(Object.entries(EXTENSION_TO_MIME).map(([ext, mime]) => [mime, ext]));

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

function splitList(value) {
  return String(value || "").split(/[,\n]/u).map((item) => item.trim()).filter(Boolean);
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

function isTruthyConfig(value) {
  if (value === true) return true;
  return /^(?:1|true|yes|on)$/iu.test(String(value || "").trim());
}

function markdownImageRepliesEnabled(config) {
  return isTruthyConfig(config.renderMarkdownImages) || isTruthyConfig(process.env.CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES);
}

function markdownImageNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function markdownImageOptions(config, title = "Codex Weixin") {
  return {
    title,
    chromePath: valueFrom(config.chromePath, process.env.CODEX_WEIXIN_CHROME_PATH, ""),
    width: markdownImageNumber(valueFrom(config.markdownImageWidth, process.env.CODEX_WEIXIN_MARKDOWN_IMAGE_WIDTH), DEFAULT_MARKDOWN_IMAGE_WIDTH),
    maxChars: markdownImageNumber(valueFrom(config.markdownImageMaxChars, process.env.CODEX_WEIXIN_MARKDOWN_IMAGE_MAX_CHARS), DEFAULT_MARKDOWN_IMAGE_MAX_CHARS),
    maxHeight: markdownImageNumber(valueFrom(config.markdownImageMaxHeight, process.env.CODEX_WEIXIN_MARKDOWN_IMAGE_MAX_HEIGHT), DEFAULT_MARKDOWN_IMAGE_MAX_HEIGHT),
  };
}

function canSendMarkdownImage(config, args = {}) {
  if (!markdownImageRepliesEnabled(config)) return false;
  if (isDryRun(args, config)) return true;
  return !valueFrom(config.endpoint, process.env.WEIXIN_ILINK_ENDPOINT);
}

function taskWorkspaceRoot() {
  return expandHome(valueFrom(process.env.CODEX_WEIXIN_TASK_ROOT, TASK_WORKSPACE_ROOT));
}

function taskCwd(taskId) {
  return path.join(taskWorkspaceRoot(), `task${taskId}`);
}

function ensureTaskCwd(taskId) {
  const cwd = taskCwd(taskId);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

function isTaskActive(task) {
  return ["running", "starting", "queued"].includes(task?.status);
}

function fixedTaskCwd(taskId) {
  return ensureTaskCwd(taskId);
}

function isValidAlias(alias) {
  const name = String(alias || "").trim();
  if (!name || /\s/u.test(name) || /^\d+$/u.test(name)) return false;
  return !new Set(["task", "list", "close", "alias", "unalias", "pwd", "ls", "snap", "screenshot"]).has(name.toLowerCase());
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
      cwd: fixedTaskCwd(DEFAULT_TASK_ID),
      status: "default",
      createdAt: new Date().toISOString(),
      pendingInstructions: [],
    };
    tasks.unshift(defaultTask);
  } else {
    defaultTask.kind = "default";
    defaultTask.intent = defaultTask.intent || "默认 Codex 助理";
    if (!defaultTask.cwd || defaultTask.cwd !== fixedTaskCwd(DEFAULT_TASK_ID)) {
      defaultTask.cwd = fixedTaskCwd(DEFAULT_TASK_ID);
      defaultTask.codexSessionId = "";
      defaultTask.resumeOf = "";
      defaultTask.resumeLast = false;
      if (!isTaskActive(defaultTask)) {
        defaultTask.logs = {};
        defaultTask.pid = "";
        defaultTask.tmuxSession = "";
        defaultTask.tmuxPanePid = "";
        defaultTask.tmuxAttach = "";
        defaultTask.status = "default";
      }
    }
    defaultTask.status = defaultTask.status || "default";
    defaultTask.pendingInstructions = Array.isArray(defaultTask.pendingInstructions) ? defaultTask.pendingInstructions : [];
  }

  for (const task of tasks) {
    const numericId = Number(task.id);
    if (Number.isInteger(numericId) && numericId >= 0) {
      const fixedCwd = fixedTaskCwd(String(task.id));
      if (!task.cwd || task.cwd !== fixedCwd) {
        task.cwd = fixedCwd;
        task.codexSessionId = "";
        task.resumeOf = "";
        task.resumeLast = false;
        if (!isTaskActive(task)) {
          task.logs = {};
          task.pid = "";
          task.tmuxSession = "";
          task.tmuxPanePid = "";
          task.tmuxAttach = "";
        }
      }
      task.kind = String(task.id) === DEFAULT_TASK_ID ? "default" : task.kind || "task";
      task.intent = task.intent || (String(task.id) === DEFAULT_TASK_ID ? "默认 Codex 助理" : `微信任务 task ${task.id}`);
      task.pendingInstructions = Array.isArray(task.pendingInstructions) ? task.pendingInstructions : [];
      if (task.alias && !isValidAlias(task.alias)) task.alias = "";
    }
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
      || String(task.alias || "") === normalized
      || String(task.pid || "") === normalized
      || task.tmuxSession === normalized;
  }) || null;
}

function getCurrentTask(fromUser) {
  const current = loadCurrentTasks();
  const target = current.users?.[userKey(fromUser)]?.currentTask || DEFAULT_TASK_ID;
  return findTaskByTarget(target) || findTaskByTarget(DEFAULT_TASK_ID);
}

function setCurrentTask(fromUser, target, options = {}) {
  const task = findTaskByTarget(target);
  if (!task) return { ok: false, message: `task ${target}: 不存在。发送 list 查看任务。` };
  if (options.dryRun) {
    return {
      ok: true,
      task,
      message: [`task ${task.id}: 将切换`, `status=${task.status}`, `cwd=${task.cwd}`].join("\n"),
    };
  }
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

function createTaskSlot(taskId, fromUser = "", options = {}) {
  const id = String(taskId);
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) {
    return { ok: false, message: `task ${id}: 只能创建 task 1 及以后的数字任务。` };
  }

  const state = loadTasks();
  const existing = state.tasks.find((task) => String(task.id) === id);
  if (existing) return { ok: true, task: existing, created: false };

  const nextId = Number(state.nextTaskId || 1);
  if (numericId !== nextId) {
    return { ok: false, message: `task ${id}: 不存在。只能创建 task ${nextId}，task id 必须每次加 1。` };
  }

  const cwd = fixedTaskCwd(id);
  const task = {
    id,
    kind: "task",
    intent: `微信任务 task ${id}`,
    cwd,
    status: "ready",
    fromUser,
    createdAt: new Date().toISOString(),
    pendingInstructions: [],
  };
  if (options.dryRun) return { ok: true, task, created: true };

  state.tasks.push(task);
  state.nextTaskId = numericId + 1;
  saveTasks(state);
  return { ok: true, task, created: true };
}

function enterTask(target, fromUser = "", options = {}) {
  const normalized = String(target || "").trim();
  if (!normalized) return "缺少 task 编号或别名。用法：task 1";

  if (/^\d+$/u.test(normalized)) {
    const existing = findTaskByTarget(normalized);
    let task = existing;
    let created = false;
    if (!task && normalized !== DEFAULT_TASK_ID) {
      const result = createTaskSlot(normalized, fromUser, options);
      if (!result.ok) return result.message;
      task = result.task;
      created = Boolean(result.created);
    }
    if (!task) return `task ${normalized}: 不存在。`;
    if (options.dryRun && created) {
      return [
        taskHeader(task.id, "将创建并进入"),
        `状态: ${task.status || "unknown"}`,
        `目录: ${task.cwd}`,
      ].join("\n");
    }

    const switched = setCurrentTask(fromUser, task.id, options);
    if (!switched.ok) return switched.message;
    return [
      taskHeader(task.id, created ? "已创建并进入" : "已进入"),
      `状态: ${task.status || "unknown"}`,
      `目录: ${task.cwd}`,
      task.alias ? `别名: ${task.alias}` : null,
    ].filter(Boolean).join("\n");
  }

  const task = findTaskByTarget(normalized);
  if (!task || !task.alias) return `task ${normalized}: 别名不存在。用 task alias N ${normalized} 设置。`;
  const switched = setCurrentTask(fromUser, task.id, options);
  if (!switched.ok) return switched.message;
  return [
    taskHeader(task.id, "已进入"),
    `别名: ${task.alias}`,
    `状态: ${task.status || "unknown"}`,
    `目录: ${task.cwd}`,
  ].join("\n");
}

function setTaskAlias(taskTarget, alias, options = {}) {
  const name = String(alias || "").trim();
  if (!isValidAlias(name)) {
    return "别名无效。别名不能是纯数字、不能有空格，也不能使用 task/list/close/alias/unalias/pwd/ls。";
  }
  const task = findTaskByTarget(taskTarget);
  if (!task) return `task ${taskTarget}: 不存在，先用 task ${taskTarget} 创建。`;
  const conflict = findTaskByTarget(name);
  if (conflict && String(conflict.id) !== String(task.id)) {
    return `别名 ${name} 已被 task ${conflict.id} 使用。`;
  }
  if (options.dryRun) return `task ${task.id} · 将设置别名: ${name}`;
  const updated = updateTask(task.id, (current) => ({
    ...current,
    alias: name,
    updatedAt: new Date().toISOString(),
  }));
  return [`task ${updated.id} · 已设置别名`, `别名: ${updated.alias}`, `目录: ${updated.cwd}`].join("\n");
}

function unsetTaskAlias(target, options = {}) {
  const task = findTaskByTarget(target);
  if (!task || !task.alias) return `task ${target}: 未找到别名。`;
  if (options.dryRun) return `task ${task.id} · 将移除别名: ${task.alias}`;
  const oldAlias = task.alias;
  const updated = updateTask(task.id, (current) => ({
    ...current,
    alias: "",
    updatedAt: new Date().toISOString(),
  }));
  return [`task ${updated.id} · 已移除别名`, `原别名: ${oldAlias}`].join("\n");
}

function resetTaskTargets(targets, options = {}) {
  const ids = targets.map((target) => String(target).trim()).filter(Boolean);
  if (ids.length === 0) return "没有指定要 reset 的 task。用法：task reset 1";

  const lines = [];
  const seenTaskIds = new Set();
  for (const id of ids) {
    const task = findTaskByTarget(id);
    if (!task) {
      lines.push(`task ${id} · 不存在`);
      continue;
    }
    if (seenTaskIds.has(String(task.id))) continue;
    seenTaskIds.add(String(task.id));

    if (isTaskActive(task)) {
      lines.push([
        taskHeader(task.id, "不能 reset"),
        `状态: ${task.status}`,
        `先执行: task close ${task.id}`,
      ].join("\n"));
      continue;
    }

    if (options.dryRun) {
      lines.push([
        taskHeader(task.id, "将 reset"),
        `目录: ${task.cwd}`,
        "会清除: codexSessionId/resumeOf/resumeLast/pendingInstructions/pid/tmuxSession/runId/log refs",
      ].join("\n"));
      continue;
    }

    const resetAt = new Date().toISOString();
    const updated = updateTask(task.id, (current) => ({
      ...current,
      status: String(current.id) === DEFAULT_TASK_ID ? "default" : "ready",
      pendingInstructions: [],
      codexSessionId: "",
      resumeOf: "",
      resumeLast: false,
      pid: "",
      tmuxSession: "",
      tmuxAttach: "",
      tmuxPanePid: "",
      runId: "",
      logs: {},
      signal: "reset-by-user",
      resetAt,
      updatedAt: resetAt,
    }));

    lines.push([
      taskHeader(updated.id, "已 reset"),
      `状态: ${updated.status}`,
      `目录: ${updated.cwd}`,
    ].join("\n"));
  }
  return lines.join("\n\n");
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

function compactLines(text, max = 1200) {
  const value = String(text || "").replace(/\r\n/g, "\n").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3).trimEnd()}...`;
}

function getMimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] || "application/octet-stream";
}

function isImageFile(filePath) {
  return getMimeFromFilename(filePath).startsWith(IMAGE_MIME_PREFIX);
}

function isImageAttachment(attachment) {
  return attachment?.kind === "image" || String(attachment?.mime || "").startsWith(IMAGE_MIME_PREFIX) || isImageFile(attachment?.filePath || "");
}

function imagePathsFromAttachments(attachments = []) {
  return attachments.filter(isImageAttachment).map((attachment) => attachment.filePath).filter(Boolean);
}

function findFirstStringByKeys(value, keys) {
  if (!value || typeof value !== "object") return "";
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const stack = [value];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      if (wanted.has(key.toLowerCase()) && typeof child === "string" && child.trim()) {
        return child.trim();
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return "";
}

function mediaPayloadFromItem(item, kind) {
  if (kind === "image") return item?.image_item || item?.imageItem || item?.image || item;
  return item?.file_item || item?.fileItem || item?.file || item;
}

function extractInboundMedia(message) {
  const attachments = [];
  for (const item of messageItems(message)) {
    const kind = item?.type === MESSAGE_ITEM_IMAGE || item?.image_item || item?.imageItem ? "image"
      : item?.type === MESSAGE_ITEM_FILE || item?.file_item || item?.fileItem ? "file"
        : "";
    if (!kind) continue;
    const payload = mediaPayloadFromItem(item, kind);
    const fileName = findFirstStringByKeys(payload, ["file_name", "filename", "fileName", "name", "title"]);
    const mime = findFirstStringByKeys(payload, ["mime", "mime_type", "mimeType", "content_type", "contentType"]);
    attachments.push({
      kind,
      fileName,
      mime,
      url: findFirstStringByKeys(payload, ["download_url", "downloadUrl", "file_url", "fileUrl", "cdn_url", "cdnUrl", "media_url", "mediaUrl", "url"]),
      encryptedParam: findFirstStringByKeys(payload, ["encrypt_query_param", "encrypted_query_param", "encryptedQueryParam", "download_encrypt_query_param"]),
      aesKey: findFirstStringByKeys(payload, ["aes_key", "aesKey", "aeskey"]),
      item,
    });
  }
  return attachments;
}

function decodeMediaAesKey(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^[0-9a-f]{32}$/iu.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  const decodedText = decoded.toString("utf8").trim();
  if (/^[0-9a-f]{32}$/iu.test(decodedText)) return Buffer.from(decodedText, "hex");
  if (decoded.length === 16) return decoded;
  throw new Error("微信附件 AES key 格式无法识别");
}

function decryptAesEcb(ciphertext, aesKey) {
  const key = decodeMediaAesKey(aesKey);
  if (!key) return ciphertext;
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function buildCdnDownloadUrl({ cdnBaseUrl, encryptedParam }) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedParam)}`;
}

function inboundFileExtension({ fileName, mime, kind }) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (ext) return ext;
  if (mime && MIME_TO_EXTENSION[mime]) return MIME_TO_EXTENSION[mime];
  return kind === "image" ? ".png" : ".bin";
}

function sanitizeFileStem(value, fallback) {
  const stem = path.basename(String(value || fallback), path.extname(String(value || "")))
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return stem || fallback;
}

function inboundFilePath(task, attachment) {
  const dir = path.join(task.cwd, INBOUND_MEDIA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ext = inboundFileExtension(attachment);
  const stem = sanitizeFileStem(attachment.fileName, attachment.kind === "image" ? "weixin-image" : "weixin-file");
  return path.join(dir, `${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}-${stem}${ext}`);
}

async function fetchBinary(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(valueFrom(config.timeoutMs, 15000)));
  try {
    const headers = {};
    const configuredBaseUrl = valueFrom(config.baseUrl, DEFAULT_ILINK_BASE_URL);
    if (url.startsWith(configuredBaseUrl) && valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN)) {
      Object.assign(headers, buildHeaders(valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN)));
    }
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadInboundMedia(attachment, config) {
  const cdnBaseUrl = valueFrom(config.cdnBaseUrl, process.env.WEIXIN_CDN_BASE_URL, DEFAULT_CDN_BASE_URL);
  const downloadUrl = attachment.url || (attachment.encryptedParam
    ? buildCdnDownloadUrl({ cdnBaseUrl, encryptedParam: attachment.encryptedParam })
    : "");
  if (!downloadUrl) throw new Error("微信附件没有可用的下载地址");
  const downloaded = await fetchBinary(downloadUrl, config);
  return attachment.aesKey ? decryptAesEcb(downloaded, attachment.aesKey) : downloaded;
}

async function saveInboundMediaForTask(task, attachments, config) {
  const saved = [];
  const maxBytes = Number(valueFrom(config.maxMediaBytes, process.env.CODEX_WEIXIN_MAX_MEDIA_BYTES, MAX_MEDIA_BYTES));
  for (const attachment of attachments) {
    const buffer = attachment.filePath ? fs.readFileSync(attachment.filePath) : await downloadInboundMedia(attachment, config);
    if (buffer.length > maxBytes) throw new Error(`微信附件过大：${buffer.length} bytes > ${maxBytes} bytes`);
    const filePath = attachment.filePath ? path.resolve(attachment.filePath) : inboundFilePath(task, attachment);
    if (!attachment.filePath) fs.writeFileSync(filePath, buffer);
    const savedAttachment = {
      kind: attachment.kind,
      filePath,
      fileName: path.basename(filePath),
      mime: attachment.mime || getMimeFromFilename(filePath),
      size: buffer.length,
      savedAt: new Date().toISOString(),
    };
    saved.push(savedAttachment);
    if (!attachment.filePath) {
      writeJsonFile(`${filePath}.json`, {
        ...savedAttachment,
        originalFileName: attachment.fileName || "",
        source: attachment.url ? "url" : "cdn",
        encrypted: Boolean(attachment.aesKey),
      });
    }
  }
  return saved;
}

function mediaRoots(config) {
  const configured = Array.isArray(config.mediaRoots)
    ? config.mediaRoots
    : splitWords(process.env.CODEX_WEIXIN_MEDIA_ROOTS);
  const roots = configured.length ? configured : [os.homedir(), "/tmp"];
  return roots.map((root) => path.resolve(expandHome(root)));
}

function ensureMediaAllowed(filePath, config) {
  const resolved = path.resolve(expandHome(filePath));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`媒体路径不是文件：${resolved}`);
  const maxBytes = Number(valueFrom(config.maxMediaBytes, process.env.CODEX_WEIXIN_MAX_MEDIA_BYTES, MAX_MEDIA_BYTES));
  if (stat.size > maxBytes) throw new Error(`媒体文件过大：${stat.size} bytes > ${maxBytes} bytes`);
  const roots = mediaRoots(config);
  const allowed = roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error(`媒体路径不在允许目录内：${resolved}`);
  return { filePath: resolved, stat };
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function isVerboseTaskReplies(config) {
  return config.verboseTaskReplies === true || process.env.CODEX_WEIXIN_VERBOSE_TASK_REPLIES === "1";
}

function taskHeader(taskId, text) {
  return `task ${taskId} · ${text}`;
}

function taskStatusText(status) {
  if (status === "completed") return "完成";
  if (status === "closed") return "已关闭";
  if (status === "failed") return "失败";
  if (status === "running") return "运行中";
  if (status === "queued") return "排队中";
  if (status === "starting") return "启动中";
  if (status === "ready") return "就绪";
  return status || "未知";
}

function extractText(message) {
  if (typeof message === "string") return message.trim();
  for (const item of messageItems(message)) {
    const text = item?.text_item?.text || item?.textItem?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

function messageItems(message) {
  return Array.isArray(message?.item_list) ? message.item_list
    : Array.isArray(message?.itemList) ? message.itemList
      : [];
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

async function getUploadUrl({ filePath, toUser, mediaType, config, stat, aeskey, filekey }) {
  const plaintext = fs.readFileSync(filePath);
  const body = {
    filekey,
    media_type: mediaType,
    to_user_id: toUser,
    rawsize: stat.size,
    rawfilemd5: crypto.createHash("md5").update(plaintext).digest("hex"),
    filesize: aesEcbPaddedSize(stat.size),
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
    base_info: {
      channel_version: "2.4.6",
      bot_agent: "CodexWeixinNotifier/0.1.0",
    },
  };
  const response = await postJson({
    baseUrl: config.baseUrl || DEFAULT_ILINK_BASE_URL,
    endpoint: "ilink/bot/getuploadurl",
    token: valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN),
    timeoutMs: Number(valueFrom(config.timeoutMs, 15000)),
    body,
  });
  if (response?.ret && response.ret !== 0) {
    throw new Error(`getuploadurl failed: ret=${response.ret} errmsg=${response.errmsg || "(none)"}`);
  }
  return { response, plaintext, ciphertextSize: body.filesize };
}

async function uploadBufferToCdn({ plaintext, uploadUrl, uploadParam, filekey, aeskey, config }) {
  const cdnBaseUrl = valueFrom(config.cdnBaseUrl, process.env.WEIXIN_CDN_BASE_URL, DEFAULT_CDN_BASE_URL);
  const target = uploadUrl?.trim() || buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (response.status !== 200) {
        const body = await response.text();
        throw new Error(`CDN upload failed: HTTP ${response.status} ${body}`);
      }
      const encryptedParam = response.headers.get("x-encrypted-param");
      if (!encryptedParam) throw new Error("CDN upload response missing x-encrypted-param");
      return encryptedParam;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }
  }
  throw lastError || new Error("CDN upload failed");
}

async function uploadMediaFile(filePath, config) {
  const { filePath: resolved, stat } = ensureMediaAllowed(filePath, config);
  const token = valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN);
  const toUser = valueFrom(config.toUser, config.userId, process.env.WEIXIN_TO_USER);
  if (!token) throw new Error("Missing Weixin iLink token. Run pair-weixin.mjs first.");
  if (!toUser) throw new Error("Missing Weixin recipient. Run bind-recipient.mjs first.");

  const image = isImageFile(resolved);
  const mediaType = image ? MEDIA_TYPE_IMAGE : MEDIA_TYPE_FILE;
  const aeskey = crypto.randomBytes(16);
  const filekey = crypto.randomBytes(16).toString("hex");
  const { response, plaintext, ciphertextSize } = await getUploadUrl({
    filePath: resolved,
    toUser,
    mediaType,
    config,
    stat,
    aeskey,
    filekey,
  });
  const uploadParam = response.upload_param;
  const uploadUrl = response.upload_full_url;
  if (!uploadUrl && !uploadParam) throw new Error("getuploadurl returned no upload URL");
  const downloadEncryptedQueryParam = await uploadBufferToCdn({
    plaintext,
    uploadUrl,
    uploadParam,
    filekey,
    aeskey,
    config,
  });
  return {
    filePath: resolved,
    fileName: path.basename(resolved),
    image,
    fileSize: stat.size,
    fileSizeCiphertext: ciphertextSize,
    media: {
      encrypt_query_param: downloadEncryptedQueryParam,
      aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"),
      encrypt_type: 1,
    },
  };
}

async function sendOfficialMessageItem(item, config) {
  const token = valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN);
  const toUser = valueFrom(config.toUser, config.userId, process.env.WEIXIN_TO_USER);
  const contextToken = valueFrom(config.contextToken, process.env.WEIXIN_CONTEXT_TOKEN);
  if (!token) throw new Error("Missing Weixin iLink token. Run pair-weixin.mjs first.");
  if (!toUser) throw new Error("Missing Weixin recipient. Run bind-recipient.mjs first.");
  if (!contextToken) throw new Error("Missing contextToken. Send a message to the bot, then run bind-recipient.mjs.");

  const response = await postJson({
    baseUrl: config.baseUrl || DEFAULT_ILINK_BASE_URL,
    endpoint: "ilink/bot/sendmessage",
    token,
    timeoutMs: Number(valueFrom(config.timeoutMs, 15000)),
    body: {
      msg: {
        from_user_id: "",
        to_user_id: toUser,
        client_id: `codex-command-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [item],
        context_token: contextToken,
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexWeixinNotifier/0.1.0",
      },
    },
  });
  if (response?.ret && response.ret !== 0) {
    throw new Error(`sendmessage failed: ret=${response.ret} errmsg=${response.errmsg || "(none)"}`);
  }
}

function mediaItemFromUpload(uploaded) {
  if (uploaded.image) {
    return {
      type: MESSAGE_ITEM_IMAGE,
      image_item: {
        media: uploaded.media,
        mid_size: uploaded.fileSizeCiphertext,
      },
    };
  }
  return {
    type: MESSAGE_ITEM_FILE,
    file_item: {
      media: uploaded.media,
      file_name: uploaded.fileName,
      len: String(uploaded.fileSize),
    },
  };
}

async function sendMediaFile(filePath, config, args = {}) {
  if (isDryRun(args, config)) {
    const { filePath: resolved, stat } = ensureMediaAllowed(filePath, config);
    process.stdout.write(`[dry-run media] ${isImageFile(resolved) ? "image" : "file"} ${resolved} ${stat.size} bytes\n`);
    return;
  }
  if (config.endpoint || process.env.WEIXIN_ILINK_ENDPOINT) {
    throw new Error("Media sending requires official iLink login transport, not a custom WEIXIN_ILINK_ENDPOINT.");
  }
  const uploaded = await uploadMediaFile(filePath, config);
  await sendOfficialMessageItem(mediaItemFromUpload(uploaded), config);
}

function extractMediaDirectives(text) {
  const media = [];
  const kept = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:MEDIA|IMAGE|FILE)\s*:\s*(.+?)\s*$/iu);
    if (!match) {
      kept.push(line);
      continue;
    }
    media.push(match[1].replace(/^file:\/\//u, "").trim());
  }
  return { text: kept.join("\n").trim(), media };
}

async function sendMarkdownImageReply(text, config, args = {}) {
  if (!String(text || "").trim()) return false;
  if (!canSendMarkdownImage(config, args)) return false;
  try {
    const rendered = await renderMarkdownImage(text, markdownImageOptions(config));
    await sendMediaFile(rendered.filePath, config, args);
    return true;
  } catch (error) {
    appendTextFile(
      path.join(LOG_DIR, "markdown-image-errors.log"),
      `[${new Date().toISOString()}] ${error.stack || error.message}\n`,
    );
    return false;
  }
}

async function sendTextWithMedia(text, config, args = {}) {
  const parsed = extractMediaDirectives(text);
  if (parsed.text) {
    const sentImage = await sendMarkdownImageReply(parsed.text, config, args);
    if (!sentImage) await sendText(parsed.text, config, args);
  }
  for (const filePath of parsed.media) {
    try {
      await sendMediaFile(filePath, config, args);
    } catch (error) {
      await sendText(`媒体发送失败：${filePath}\n${error.message}`, config, args);
    }
  }
  if (!parsed.text && parsed.media.length === 0) await sendText(text, config, args);
}

function extractSessionId(value) {
  if (!value || typeof value !== "object") return "";
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
        if (
          (key === "session_id" || key === "sessionId" || key === "thread_id" || key === "threadId")
          && typeof child === "string"
          && child.trim()
        ) {
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
  const configuredAnyArgs = configuredGlobal.length > 0 || configured.length > 0;

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
    if (arg.startsWith("--sandbox=") || arg.startsWith("-s=")) {
      globalArgs.push(arg);
      continue;
    }
    if (arg === "--sandbox" || arg === "-s") {
      globalArgs.push(arg);
      if (configured[i + 1]) {
        globalArgs.push(configured[i + 1]);
        i += 1;
      }
      continue;
    }
    if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      globalArgs.push(arg);
      continue;
    }
    execArgs.push(arg);
  }

  const hasArg = (name, shortName = "") => globalArgs.some((arg) => {
    return arg === name || arg.startsWith(`${name}=`) || (shortName && (arg === shortName || arg.startsWith(`${shortName}=`)));
  });
  const bypassSandbox = process.env.CODEX_WEIXIN_CODEX_BYPASS_SANDBOX === "1"
    || config.codexBypassSandbox === true
    || config.dangerouslyBypassApprovalsAndSandbox === true;
  if (bypassSandbox) {
    if (!globalArgs.includes("--dangerously-bypass-approvals-and-sandbox")) {
      globalArgs.push("--dangerously-bypass-approvals-and-sandbox");
    }
  } else if (!hasArg("--sandbox", "-s")) {
    globalArgs.push("--sandbox", valueFrom(process.env.CODEX_WEIXIN_CODEX_SANDBOX, config.codexSandbox, "workspace-write"));
  }
  if (!bypassSandbox && !hasArg("--ask-for-approval", "-a")) {
    globalArgs.push("--ask-for-approval", "never");
  }

  if (!configuredAnyArgs && execArgs.length === 0) {
    execArgs.push("--json", "--skip-git-repo-check");
  }

  return { globalArgs, execArgs };
}

function codexImageArgs(imagePaths = []) {
  return imagePaths.flatMap((filePath) => ["--image", filePath]);
}

function buildCodexArgs({ prompt, cwd, outputLastMessage, config, resumeSessionId, resumeLast = false, imagePaths = [] }) {
  const { globalArgs, execArgs } = codexArgGroups(config);
  const imageArgs = codexImageArgs(imagePaths);

  if (resumeSessionId || resumeLast) {
    return [
      ...globalArgs,
      "exec",
      "resume",
      ...execArgs,
      ...imageArgs,
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
    ...imageArgs,
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
  if (["interactive", "tui", "codex"].includes(normalized) && commandExists("tmux")) return "interactive";
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
  return sanitizeTmuxName(`codex-wx-task-${task.id}`);
}

function tmuxHasSession(sessionName) {
  if (!sessionName) return false;
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
  return result.status === 0;
}

function killTmuxSession(sessionName) {
  if (!sessionName || !tmuxHasSession(sessionName)) return false;
  const result = spawnSync("tmux", ["kill-session", "-t", sessionName], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tmux kill-session failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return true;
}

function listTmuxSessions() {
  const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function isLegacyTaskTmuxSession(sessionName) {
  return /^codex-wx-task-\d+-(?:wxrun|wxr)-/u.test(String(sessionName || ""));
}

function cleanupLegacyTaskTmuxSessions(options = {}) {
  const legacySessions = listTmuxSessions().filter(isLegacyTaskTmuxSession);
  if (legacySessions.length === 0) return "task tmux clean · 没有旧 tmux session";
  if (options.dryRun) {
    return [
      `task tmux clean · 将清理 ${legacySessions.length} 个旧 session`,
      ...legacySessions.map((name) => `- ${name}`),
    ].join("\n");
  }

  const killed = [];
  const failed = [];
  for (const sessionName of legacySessions) {
    try {
      if (killTmuxSession(sessionName)) killed.push(sessionName);
    } catch (error) {
      failed.push(`${sessionName}: ${error.message}`);
    }
  }

  return [
    `task tmux clean · 已清理 ${killed.length} 个旧 session`,
    failed.length ? `失败 ${failed.length} 个:\n${failed.join("\n")}` : null,
  ].filter(Boolean).join("\n");
}

function getTmuxPanePid(sessionName) {
  if (!sessionName) return "";
  const result = spawnSync("tmux", ["display-message", "-p", "-t", sessionName, "#{pane_pid}"], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function sleepSync(ms) {
  const delay = Math.max(0, Number(ms || 0));
  if (delay === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function hasCliArg(args, name, shortName = "") {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`) || (shortName && (arg === shortName || arg.startsWith(`${shortName}=`))));
}

function interactiveCodexArgs({ cwd, config, imagePaths = [] }) {
  const { globalArgs } = codexArgGroups(config);
  const args = [...globalArgs];
  if (!args.includes("--no-alt-screen")) args.unshift("--no-alt-screen");
  if (!hasCliArg(args, "--cd", "-C")) args.push("-C", cwd);
  for (const filePath of imagePaths) args.push("--image", filePath);
  return args;
}

function interactiveCaptureDelayMs(config) {
  return Number(valueFrom(config.interactiveCaptureDelayMs, process.env.CODEX_WEIXIN_INTERACTIVE_CAPTURE_DELAY_MS, DEFAULT_INTERACTIVE_CAPTURE_DELAY_MS));
}

function interactiveCaptureLines(config) {
  return Number(valueFrom(config.interactiveCaptureLines, process.env.CODEX_WEIXIN_INTERACTIVE_CAPTURE_LINES, DEFAULT_INTERACTIVE_CAPTURE_LINES));
}

function interactiveReadyTimeoutMs(config) {
  return Number(valueFrom(config.interactiveReadyTimeoutMs, process.env.CODEX_WEIXIN_INTERACTIVE_READY_TIMEOUT_MS, DEFAULT_INTERACTIVE_READY_TIMEOUT_MS));
}

function interactiveResponseTimeoutMs(config) {
  return Number(valueFrom(config.interactiveResponseTimeoutMs, process.env.CODEX_WEIXIN_INTERACTIVE_RESPONSE_TIMEOUT_MS, DEFAULT_INTERACTIVE_RESPONSE_TIMEOUT_MS));
}

function interactiveResponsePollMs(config) {
  return Number(valueFrom(config.interactiveResponsePollMs, process.env.CODEX_WEIXIN_INTERACTIVE_RESPONSE_POLL_MS, DEFAULT_INTERACTIVE_RESPONSE_POLL_MS));
}

function captureTmuxPane(sessionName, config) {
  const lines = Math.max(20, interactiveCaptureLines(config));
  const result = spawnSync("tmux", ["capture-pane", "-pt", sessionName, "-S", `-${lines}`], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`tmux capture-pane failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result.stdout.trimEnd();
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function cleanInteractiveCapture(text) {
  const lines = stripAnsi(text).split(/\r?\n/).map((line) => line.trimEnd());
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^[╭╮╰╯│─\s]+$/u.test(trimmed)) return false;
    if (/^>_ OpenAI Codex/u.test(trimmed)) return false;
    if (/^model:\s+/u.test(trimmed)) return false;
    if (/^directory:\s+/u.test(trimmed)) return false;
    if (/^Tip:/u.test(trimmed)) return false;
    if (/^• You have /u.test(trimmed)) return false;
    if (/^[◦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Booting MCP server/u.test(trimmed)) return false;
    if (/^›\s*/u.test(trimmed)) return false;
    if (/^gpt-[\w.-]+.*·/u.test(trimmed)) return false;
    return true;
  }).map((line) => line.replace(/^•\s*/u, "")).join("\n").trim();
}

function cleanedInteractiveLines(text, options = {}) {
  return stripAnsi(text).split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^[╭╮╰╯│─\s]+$/u.test(trimmed)) return false;
    if (/^>_ OpenAI Codex/u.test(trimmed)) return false;
    if (/^model:\s+/u.test(trimmed)) return false;
    if (/^directory:\s+/u.test(trimmed)) return false;
    if (/^Tip:/u.test(trimmed)) return false;
    if (/^• You have /u.test(trimmed)) return false;
    if (/^[◦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Booting MCP server/u.test(trimmed)) return false;
    if (!options.keepPromptLines && /^›\s*/u.test(trimmed)) return false;
    if (/^gpt-[\w.-]+.*·/u.test(trimmed)) return false;
    return true;
  }).map((line) => line.replace(/^•\s*/u, ""));
}

function extractInteractiveQuestion(text) {
  const lines = cleanedInteractiveLines(text, { keepPromptLines: true });
  const start = lines.findLastIndex((line) => {
    return /Question\s+\d+\/\d+/iu.test(line) || /^Implement this plan\?/iu.test(line);
  });
  if (start === -1) return null;
  const block = lines.slice(start).map((line) => line.trim()).filter(Boolean);
  const options = [];
  for (const line of block) {
    const match = line.match(/^[›\s]*([1-9])\.\s+(.+)$/u);
    if (match) options.push({ index: Number(match[1]), label: match[2].trim() });
  }
  if (options.length === 0) return null;
  const questionLine = block.find((line, index) => {
    if (/^Implement this plan\?/iu.test(line)) return true;
    return index > 0
      && !/^[›\s]*[1-9]\./u.test(line)
      && !/tab to add notes|enter to submit|esc to interrupt|press enter to confirm/iu.test(line);
  }) || "";
  return {
    text: [
      "Codex 正在等待选择。请直接回复数字：",
      questionLine ? `问题: ${questionLine}` : null,
      ...options.map((option) => `${option.index}. ${option.label.replace(/\s+/gu, " ")}`),
    ].filter(Boolean).join("\n"),
    options,
  };
}

function currentInteractiveQuestion(sessionName, config) {
  if (!sessionName || !tmuxHasSession(sessionName)) return null;
  return extractInteractiveQuestion(captureTmuxPane(sessionName, config));
}

async function taskSnapshotResponse(task, config) {
  if (!task) return "当前没有可截图的 task。";
  const refreshed = refreshTaskLiveness(task) || task;
  const sessionName = refreshed.tmuxSession || makeTmuxSessionName(refreshed);
  if (!sessionName || !tmuxHasSession(sessionName)) {
    return [
      taskHeader(refreshed.id, "没有可截图的 tmux 会话"),
      "先发送一条普通消息启动该 task，或切换到正在运行的 task。",
    ].join("\n");
  }

  let pane = "";
  try {
    pane = stripAnsi(captureTmuxPane(sessionName, config));
    const markdown = terminalSnapshotMarkdown({
      taskId: refreshed.id,
      sessionName,
      paneText: pane,
    });
    const rendered = await renderMarkdownImage(
      markdown,
      markdownImageOptions(config, `task ${refreshed.id} tmux`),
    );
    return `MEDIA:${rendered.filePath}`;
  } catch (error) {
    appendTextFile(
      path.join(LOG_DIR, "markdown-image-errors.log"),
      `[${new Date().toISOString()}] task snap ${sessionName}: ${error.stack || error.message}\n`,
    );
    return [
      taskHeader(refreshed.id, "截图失败，改发文字"),
      `会话: ${sessionName}`,
      `错误: ${error.message}`,
      "",
      compactLines(pane || "(暂无可抓取输出)", 3000),
    ].join("\n");
  }
}

function parseInteractiveChoice(text, optionCount) {
  const match = String(text || "").trim().match(/^([1-9])(?:[.、\s].*)?$/u);
  if (!match) return null;
  const choice = Number(match[1]);
  if (!Number.isInteger(choice) || choice < 1 || choice > optionCount) return null;
  return choice;
}

function sendInteractiveChoice(sessionName, choice) {
  for (let index = 1; index < choice; index += 1) {
    const down = spawnSync("tmux", ["send-keys", "-t", sessionName, "Down"], { encoding: "utf8" });
    if (down.status !== 0) {
      throw new Error(`tmux choice down failed: ${down.stderr || down.stdout || `exit ${down.status}`}`);
    }
    sleepSync(80);
  }
  const enter = spawnSync("tmux", ["send-keys", "-t", sessionName, "C-m"], { encoding: "utf8" });
  if (enter.status !== 0) {
    throw new Error(`tmux choice enter failed: ${enter.stderr || enter.stdout || `exit ${enter.status}`}`);
  }
}

function answerInteractiveQuestion(task, text, config) {
  const sessionName = makeTmuxSessionName(task);
  const question = currentInteractiveQuestion(sessionName, config);
  if (!question) return null;

  const choice = parseInteractiveChoice(text, question.options.length);
  if (!choice) {
    return [
      taskHeader(task.id, "等待选择"),
      `会话: ${sessionName}`,
      "",
      question.text,
    ].join("\n");
  }

  const before = cleanInteractiveCapture(captureTmuxPane(sessionName, config));
  sendInteractiveChoice(sessionName, choice);
  sleepSync(interactiveCaptureDelayMs(config));
  const output = waitForInteractiveResponse(sessionName, before, config);
  const nextQuestion = currentInteractiveQuestion(sessionName, config);
  return [
    taskHeader(task.id, `已选择 ${choice}`),
    `会话: ${sessionName}`,
    "",
    nextQuestion ? nextQuestion.text : compactLines(output || "已提交选择，Codex 继续处理中。", 3000),
  ].join("\n");
}

function captureAfterPrevious(sessionName, previousCleaned, config) {
  const cleaned = cleanInteractiveCapture(captureTmuxPane(sessionName, config));
  if (!previousCleaned) return cleaned;
  if (cleaned.startsWith(previousCleaned)) return cleaned.slice(previousCleaned.length).trim();
  const previousLines = previousCleaned.split("\n").filter(Boolean);
  for (let count = Math.min(previousLines.length, 20); count > 0; count -= 1) {
    const tail = previousLines.slice(-count).join("\n");
    const index = cleaned.lastIndexOf(tail);
    if (index !== -1) return cleaned.slice(index + tail.length).trim();
  }
  return cleaned;
}

function waitForInteractiveResponse(sessionName, previousCleaned, config) {
  const deadline = Date.now() + interactiveResponseTimeoutMs(config);
  let lastOutput = "";
  let stableCount = 0;
  while (Date.now() < deadline) {
    const output = captureAfterPrevious(sessionName, previousCleaned, config);
    if (output && output === lastOutput) {
      stableCount += 1;
      if (stableCount >= 2) return output;
    } else if (output) {
      lastOutput = output;
      stableCount = 0;
    }
    sleepSync(interactiveResponsePollMs(config));
  }
  return lastOutput;
}

function paneLooksReady(text) {
  const cleaned = cleanInteractiveCapture(text);
  return /(?:^|\n)›\s*/u.test(cleaned) || /(?:^|\n)>\s*$/u.test(cleaned) || /gpt-[\w.-]+.*·/u.test(stripAnsi(text));
}

function waitForInteractiveReady(sessionName, config) {
  const deadline = Date.now() + interactiveReadyTimeoutMs(config);
  while (Date.now() < deadline) {
    const pane = captureTmuxPane(sessionName, config);
    if (paneLooksReady(pane)) return true;
    sleepSync(500);
  }
  return false;
}

function ensureInteractiveSession(task, config, imagePaths = []) {
  const sessionName = makeTmuxSessionName(task);
  if (tmuxHasSession(sessionName)) {
    const panePid = getTmuxPanePid(sessionName);
    updateTask(task.id, (current) => ({
      ...current,
      status: "running",
      runner: "interactive",
      tmuxSession: sessionName,
      tmuxAttach: `tmux attach -t ${sessionName}`,
      tmuxPanePid: panePid,
      pid: panePid || current.pid,
      updatedAt: new Date().toISOString(),
    }));
    return { sessionName, panePid, started: false };
  }

  const command = valueFrom(config.codexCommand, process.env.CODEX_WEIXIN_CODEX_COMMAND, "codex");
  const args = interactiveCodexArgs({ cwd: task.cwd, config, imagePaths });
  const tmuxArgs = [
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    task.cwd,
    "env",
    `CODEX_SESSION_ID=weixin-task-${task.id}`,
    "CODEX_PRODUCT=codex-weixin-command-router",
    "CODEX_WEIXIN_ROUTER_TASK=1",
    command,
    ...args,
  ];
  const tmux = spawnSync("tmux", tmuxArgs, { encoding: "utf8" });
  if (tmux.status !== 0) {
    throw new Error(`interactive tmux start failed: ${tmux.stderr || tmux.stdout || `exit ${tmux.status}`}`);
  }
  const panePid = getTmuxPanePid(sessionName);
  updateTask(task.id, (current) => ({
    ...current,
    status: "running",
    runner: "interactive",
    tmuxSession: sessionName,
    tmuxAttach: `tmux attach -t ${sessionName}`,
    tmuxPanePid: panePid,
    pid: panePid || current.pid,
    runId: current.runId || createId("interactive"),
    startedAt: current.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  return { sessionName, panePid, started: true };
}

function mapInteractiveCommand(text, attachments = []) {
  const instruction = instructionWithAttachments(text, attachments);
  const trimmed = instruction.trim();
  const planMatch = trimmed.match(/^plan(?:\s+(.+))?$/isu);
  if (planMatch) return `/plan${planMatch[1] ? ` ${planMatch[1].trim()}` : ""}`;
  const goalMatch = trimmed.match(/^(?:goal|gloal)(?:\s+(.+))?$/isu);
  if (goalMatch) {
    const arg = String(goalMatch[1] || "").trim();
    if (!arg || /^status$/iu.test(arg)) return "/goal";
    return `/goal ${arg}`;
  }
  return trimmed;
}

function sendTextToTmux(sessionName, text) {
  const normalized = String(text || "").replace(/\r?\n+/gu, " ").replace(/\s+/gu, " ").trim();
  const clear = spawnSync("tmux", ["send-keys", "-t", sessionName, "C-u"], { encoding: "utf8" });
  if (clear.status !== 0) {
    throw new Error(`tmux clear composer failed: ${clear.stderr || clear.stdout || `exit ${clear.status}`}`);
  }
  sleepSync(100);
  const type = spawnSync("tmux", ["send-keys", "-t", sessionName, "-l", normalized], { encoding: "utf8" });
  if (type.status !== 0) {
    throw new Error(`tmux send literal failed: ${type.stderr || type.stdout || `exit ${type.status}`}`);
  }
  sleepSync(150);
  const enter = spawnSync("tmux", ["send-keys", "-t", sessionName, "C-m"], { encoding: "utf8" });
  if (enter.status !== 0) {
    throw new Error(`tmux send-keys failed: ${enter.stderr || enter.stdout || `exit ${enter.status}`}`);
  }
}

function sendInteractiveInstruction(task, text, attachments, config) {
  const imagePaths = imagePathsFromAttachments(attachments);
  const mapped = mapInteractiveCommand(text, attachments);
  if (config.dryRun) {
    const command = valueFrom(config.codexCommand, process.env.CODEX_WEIXIN_CODEX_COMMAND, "codex");
    const args = interactiveCodexArgs({ cwd: task.cwd, config, imagePaths });
    return [
      taskHeader(task.id, "interactive dry-run"),
      `命令: ${[command, ...args].join(" ")}`,
      imagePaths.length ? `图片: ${imagePaths.join(" ")}` : null,
      "",
      mapped,
    ].filter(Boolean).join("\n");
  }
  const { sessionName, started } = ensureInteractiveSession(task, config, imagePaths);
  waitForInteractiveReady(sessionName, config);
  const before = cleanInteractiveCapture(captureTmuxPane(sessionName, config));
  sendTextToTmux(sessionName, mapped);
  sleepSync(interactiveCaptureDelayMs(config));
  let output = waitForInteractiveResponse(sessionName, before, config);
  if (!output) {
    spawnSync("tmux", ["send-keys", "-t", sessionName, "C-m"], { encoding: "utf8" });
    output = waitForInteractiveResponse(sessionName, before, config);
  }
  const question = currentInteractiveQuestion(sessionName, config);
  return [
    taskHeader(task.id, started ? "interactive 已启动并发送" : "interactive 已发送"),
    `会话: ${sessionName}`,
    "",
    question ? question.text : compactLines(output || "(暂无可抓取输出)", 3000),
  ].join("\n");
}

function startTmuxRun({ task, config, resumeSessionId = "", resumeLast = false, command, args, runId, stdoutPath, stderrPath, lastMessagePath }) {
  const sessionName = makeTmuxSessionName(task, runId);
  if (tmuxHasSession(sessionName)) killTmuxSession(sessionName);
  const keepOpen = process.env.CODEX_WEIXIN_KEEP_TMUX_OPEN === "1" || config.keepTmuxOpen === true;
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
    keepOpen ? "printf '[Attach remains open for inspection. Press Ctrl-D to close.]\\n'" : null,
    keepOpen ? `exec ${shQuote(shell)} -l` : "exit \"$code\"",
  ].filter(Boolean).join("\n");

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

function startCodexRun({ task, prompt, config, resumeSessionId = "", resumeLast = false, imagePaths = [] }) {
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
    imagePaths,
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

function parsedSimpleCommand(text) {
  const trimmed = String(text || "").trim();
  if (/^pwd$/iu.test(trimmed)) return { name: "pwd", args: [] };
  if (!/^ls(?:\s|$)/iu.test(trimmed)) return null;

  const words = splitWords(trimmed);
  if (words[0] !== "ls") return null;
  const allowedFlags = new Set(["-a", "-l", "-la", "-al", "-lh", "-hl", "-lah", "-alh", "-hla", "-hal"]);
  const flags = [];
  const paths = [];
  for (const word of words.slice(1)) {
    if (word.startsWith("-")) {
      if (!allowedFlags.has(word)) return null;
      flags.push(word);
      continue;
    }
    paths.push(word);
  }
  if (paths.length > 1) return null;
  return { name: "ls", args: [...flags, ...paths] };
}

function resolveCommandPath(cwd, target = "") {
  if (!target) return cwd;
  const expanded = expandHome(target);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function runSimpleCommand(task, command) {
  if (command.name === "pwd") {
    return [taskHeader(task.id, "pwd"), "", task.cwd].join("\n");
  }

  const flags = command.args.filter((arg) => arg.startsWith("-"));
  const targetArg = command.args.find((arg) => !arg.startsWith("-")) || "";
  const target = resolveCommandPath(task.cwd, targetArg);
  const result = spawnSync("ls", [...flags, target], {
    cwd: task.cwd,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("").trimEnd();
  const label = targetArg ? `ls ${targetArg}` : "ls";
  const status = result.status === 0 ? label : `${label} 失败`;
  return [
    taskHeader(task.id, status),
    "",
    compactLines(output || "(无输出)", 2000),
  ].join("\n");
}

function normalizeInstructionEntry(value) {
  if (value && typeof value === "object") {
    return {
      text: String(value.text || "").trim(),
      attachments: Array.isArray(value.attachments) ? value.attachments : [],
    };
  }
  return { text: String(value || "").trim(), attachments: [] };
}

function formatAttachmentSummary(attachments = []) {
  if (!attachments.length) return "";
  return [
    "微信附件已保存到本地：",
    ...attachments.map((attachment, index) => {
      const label = isImageAttachment(attachment) ? "image" : "file";
      const size = attachment.size ? ` ${attachment.size} bytes` : "";
      return `${index + 1}. ${label}: ${attachment.filePath}${size}`;
    }),
    "",
    "图片附件已通过 Codex --image 附加；文件附件请直接读取上面的本地路径。",
  ].join("\n");
}

function instructionWithAttachments(instruction, attachments = []) {
  const text = String(instruction || "").trim() || (attachments.length ? "请处理微信发来的附件。" : "");
  const summary = formatAttachmentSummary(attachments);
  return [text, summary].filter(Boolean).join("\n\n");
}

function formatDefaultTaskPrompt(instruction, attachments = []) {
  const userInstruction = instructionWithAttachments(instruction, attachments);
  return [
    "You are task 0, the default Codex assistant behind a Weixin chat.",
    "Answer directly inside task 0. Do not create or request separate subtasks.",
    "Task creation is controlled only by explicit Weixin commands such as task 1.",
    "To send an existing local image or file to Weixin, put a MEDIA directive on its own line: MEDIA:/absolute/path/to/file",
    "Use MEDIA only for files that already exist and are safe to share. Keep the directive on a separate line.",
    "",
    "Weixin user message:",
    userInstruction,
  ].join("\n");
}

function formatAppendPrompt(task, instruction, attachments = []) {
  const userInstruction = instructionWithAttachments(instruction, attachments);
  if (String(task.id) === DEFAULT_TASK_ID) return formatDefaultTaskPrompt(instruction, attachments);
  if (!task.codexSessionId && !task.resumeLast) {
    return [
      `You are Weixin-managed task ${task.id}.`,
      task.alias ? `Task alias: ${task.alias}` : null,
      `Working directory: ${task.cwd}`,
      "",
      "User instruction:",
      userInstruction,
      "",
      "If your answer needs to send an existing local image or file, put a MEDIA directive on its own line: MEDIA:/absolute/path/to/file",
    ].filter(Boolean).join("\n");
  }
  return [
    `Continue the existing task ${task.id}.`,
    `Original task: ${task.intent}`,
    "",
    "Additional instruction from Weixin:",
    userInstruction,
    "",
    "If your answer needs to send an existing local image or file, put a MEDIA directive on its own line: MEDIA:/absolute/path/to/file",
  ].join("\n");
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
    const nextInstruction = normalizeInstructionEntry(queued.shift());
    const updated = updateTask(latest.id, (current) => ({
      ...current,
      pendingInstructions: queued,
      status: "queued",
      updatedAt: new Date().toISOString(),
    }));
    if (updated) {
      startInstructionForTask(updated, nextInstruction, config);
    }
    return updated;
  }

  const last = readLastMessage(latest);
  const statusText = taskStatusText(latest.status);
  const lines = [taskHeader(latest.id, statusText)];
  if (latest.status !== "completed") lines.push(`exit: ${numericExit === null ? signal || "unknown" : numericExit}`);
  if (isVerboseTaskReplies(config)) {
    lines.push(`cwd: ${latest.cwd}`);
    if (latest.tmuxSession) lines.push(`tmux: ${latest.tmuxSession}`);
  }
  if (last) lines.push("", compactLines(last, 1200));
  await sendTextWithMedia(lines.join("\n"), config);
  return latest;
}

function forwardToTask(task, text, config, fromUser = "", attachments = []) {
  task = refreshTaskLiveness(task);
  const instruction = String(text || "").trim();
  if (!instruction && attachments.length === 0) return `task ${task.id}: 空消息已忽略`;

  const simpleCommand = attachments.length === 0 ? parsedSimpleCommand(instruction) : null;
  if (simpleCommand) return runSimpleCommand(task, simpleCommand);

  if (selectedRunner(config) === "interactive") {
    const answeredQuestion = answerInteractiveQuestion(task, instruction, config);
    if (answeredQuestion) return answeredQuestion;
    return sendInteractiveInstruction(task, instruction, attachments, config);
  }

  const entry = {
    id: createId("inst"),
    text: instruction,
    attachments,
    addedAt: new Date().toISOString(),
  };

  if (["running", "starting", "queued"].includes(task.status)) {
    const updated = updateTask(task.id, (current) => ({
      ...current,
      fromUser: fromUser || current.fromUser || "",
      pendingInstructions: [...(current.pendingInstructions || []), entry],
      updatedAt: new Date().toISOString(),
    }));
    return `${taskHeader(updated.id, "已排队")} (${updated.pendingInstructions.length})`;
  }

  const pending = Array.isArray(task.pendingInstructions) ? [...task.pendingInstructions] : [];
  if (pending.length > 0) {
    pending.push(entry);
    const nextInstruction = normalizeInstructionEntry(pending.shift());
    const updated = updateTask(task.id, (current) => {
      const recoveredSessionId = current.resetAt ? "" : extractSessionIdFromJsonl(current.logs?.stdout);
      return {
        ...current,
        fromUser: fromUser || current.fromUser || "",
        pendingInstructions: pending,
        status: "queued",
        codexSessionId: current.codexSessionId || recoveredSessionId,
        updatedAt: new Date().toISOString(),
      };
    });
    if (updated) startInstructionForTask(updated, nextInstruction, config);
    return `${taskHeader(updated.id, "恢复队列处理中")} (${updated.pendingInstructions.length})`;
  }

  const updated = updateTask(task.id, (current) => {
    const recoveredSessionId = current.resetAt ? "" : extractSessionIdFromJsonl(current.logs?.stdout);
    return {
      ...current,
      fromUser: fromUser || current.fromUser || "",
      status: "queued",
      codexSessionId: current.codexSessionId || recoveredSessionId,
      updatedAt: new Date().toISOString(),
    };
  });
  startInstructionForTask(updated, entry, config);
  return taskHeader(updated.id, "处理中");
}

function closeTaskTargets(targets, fromUser = "", options = {}) {
  const ids = targets.map((target) => String(target).trim()).filter(Boolean);
  if (ids.length === 0) return "没有指定要关闭的 task。用法：task close 1";

  const lines = [];
  const seenTaskIds = new Set();
  for (const id of ids) {
    const task = findTaskByTarget(id);
    if (!task) {
      lines.push(`task ${id} · 不存在`);
      continue;
    }
    if (seenTaskIds.has(String(task.id))) continue;
    seenTaskIds.add(String(task.id));
    if (String(task.id) === DEFAULT_TASK_ID) {
      lines.push("task 0 · 默认任务不能关闭");
      continue;
    }

    if (options.dryRun) {
      lines.push([
        taskHeader(task.id, "将关闭"),
        `会话: ${task.tmuxSession || task.pid || "未记录"}`,
        `目录: ${task.cwd}`,
      ].join("\n"));
      continue;
    }

    let killed = false;
    try {
      if (task.runner === "tmux" || task.tmuxSession) {
        killed = killTmuxSession(task.tmuxSession);
      } else if (runtimeChildren.has(String(task.id))) {
        runtimeChildren.get(String(task.id)).kill("SIGTERM");
        runtimeChildren.delete(String(task.id));
        killed = true;
      } else if (task.pid) {
        try {
          process.kill(Number(task.pid), "SIGTERM");
          killed = true;
        } catch {
          killed = false;
        }
      }
    } catch (error) {
      lines.push(`task ${task.id} · 关闭失败\n${error.message}`);
      continue;
    }

    const closedAt = new Date().toISOString();
    updateTask(task.id, (current) => ({
      ...current,
      status: "closed",
      closedAt,
      updatedAt: closedAt,
      pendingInstructions: [],
      signal: "closed-by-user",
      tmuxClosed: Boolean(killed),
    }));

    const current = getCurrentTask(fromUser);
    if (String(current?.id) === String(task.id)) {
      setCurrentTask(fromUser, DEFAULT_TASK_ID);
    }

    lines.push([
      taskHeader(task.id, "已关闭"),
      killed ? "会话: 已停止" : "会话: 未运行或已不存在",
      `目录: ${task.cwd}`,
    ].join("\n"));
  }
  return lines.join("\n\n");
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

function taskHasLiveRunner(task) {
  if (!isTaskActive(task)) return true;
  if (task.runner === "tmux" || task.tmuxSession) {
    return Boolean(task.tmuxSession && tmuxHasSession(task.tmuxSession));
  }
  if (!task.pid) return false;
  try {
    process.kill(Number(task.pid), 0);
    return true;
  } catch {
    return false;
  }
}

function refreshTaskLiveness(task) {
  if (!task || !isTaskActive(task) || taskHasLiveRunner(task)) return task;
  return updateTask(task.id, (current) => ({
    ...current,
    status: current.exitCode === 0 ? "completed" : "unknown",
    tmuxSession: "",
    tmuxAttach: "",
    tmuxPanePid: "",
    pid: "",
    staleRunnerClearedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })) || task;
}

function startInstructionForTask(task, instructionEntry, config) {
  const entry = normalizeInstructionEntry(instructionEntry);
  if (selectedRunner(config) === "interactive") {
    sendInteractiveInstruction(task, entry.text, entry.attachments, config);
    return;
  }
  const imagePaths = imagePathsFromAttachments(entry.attachments);
  startCodexRun({
    task,
    prompt: formatAppendPrompt(task, entry.text, entry.attachments, config),
    config,
    resumeSessionId: task.codexSessionId || "",
    resumeLast: !task.codexSessionId && Boolean(task.resumeLast),
    imagePaths,
  });
}

function recoverStaleTaskQueues(config) {
  const recovered = [];
  const state = loadTasks();
  for (const task of state.tasks) {
    const refreshed = refreshTaskLiveness(task);
    if (!refreshed || isTaskActive(refreshed)) continue;
    const queued = Array.isArray(refreshed.pendingInstructions) ? [...refreshed.pendingInstructions] : [];
    if (queued.length === 0) continue;

    const nextInstruction = normalizeInstructionEntry(queued.shift());
    const updated = updateTask(refreshed.id, (current) => ({
      ...current,
      pendingInstructions: queued,
      status: "queued",
      updatedAt: new Date().toISOString(),
    }));
    if (!updated) continue;
    startInstructionForTask(updated, nextInstruction, config);
    recovered.push(updated.id);
  }
  return recovered;
}

function formatTaskBlock(task, fromUser = "") {
  const current = getCurrentTask(fromUser);
  const tags = [];
  if (String(task.id) === DEFAULT_TASK_ID) tags.push("default");
  else tags.push(task.status || "unknown");
  if (String(current?.id) === String(task.id)) tags.push("current");
  const lines = [
    `task ${task.id} [${tags.join(",")}]`,
    task.alias ? `别名: ${task.alias}` : null,
    `状态: ${task.status || "unknown"}`,
    `目录: ${task.cwd}`,
  ].filter(Boolean);
  if (task.intent) lines.push(`摘要: ${compact(task.intent, 80)}`);
  return lines.join("\n");
}

async function formatList(fromUser = "") {
  const state = pruneDeadTasks();
  const ordered = state.tasks
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));
  return ordered.map((task) => formatTaskBlock(task, fromUser)).join("\n\n");
}

function parseCommand(text) {
  const trimmed = String(text || "").trim();
  if (/^list$/iu.test(trimmed)) return { type: "list" };
  if (/^task\s+tmux\s+clean$/iu.test(trimmed)) return { type: "tmux-clean" };
  if (/^task\s+(?:snap|screenshot)$/iu.test(trimmed)) return { type: "snapshot" };
  const aliasMatch = trimmed.match(/^task\s+alias\s+(\S+)\s+(\S+)$/iu);
  if (aliasMatch) return { type: "alias", target: aliasMatch[1], alias: aliasMatch[2] };
  const unaliasMatch = trimmed.match(/^task\s+unalias\s+(\S+)$/iu);
  if (unaliasMatch) return { type: "unalias", target: unaliasMatch[1] };
  const resetMatch = trimmed.match(/^task\s+reset\s+(.+)$/iu);
  if (resetMatch) {
    const targets = resetMatch[1].split(/\s+/u).filter(Boolean);
    return { type: "reset", targets };
  }
  const closeMatch = trimmed.match(/^task\s+close\s+(.+)$/iu);
  if (closeMatch) {
    const targets = closeMatch[1].split(/\s+/u).filter(Boolean);
    return { type: "close", targets };
  }
  const taskMatch = trimmed.match(/^task\s+(\S+)$/iu);
  if (taskMatch) return { type: "enter", target: taskMatch[1] };
  return { type: "message", text: trimmed };
}

async function handleText(text, fromUser, config) {
  const command = parseCommand(text);
  if (command.type === "list") return formatList(fromUser);
  if (command.type === "tmux-clean") return cleanupLegacyTaskTmuxSessions({ dryRun: Boolean(config.dryRun) });
  if (command.type === "snapshot") return taskSnapshotResponse(getCurrentTask(fromUser), config);
  if (command.type === "alias") return setTaskAlias(command.target, command.alias, { dryRun: Boolean(config.dryRun) });
  if (command.type === "unalias") return unsetTaskAlias(command.target, { dryRun: Boolean(config.dryRun) });
  if (command.type === "reset") return resetTaskTargets(command.targets, { dryRun: Boolean(config.dryRun) });
  if (command.type === "close") return closeTaskTargets(command.targets, fromUser, { dryRun: Boolean(config.dryRun) });
  if (command.type === "enter") return enterTask(command.target, fromUser, { dryRun: Boolean(config.dryRun) });

  const task = getCurrentTask(fromUser);
  if (!task) return "task 0: 状态异常，未找到默认任务。";
  return forwardToTask(task, command.text, config, fromUser);
}

async function handleTextWithAttachments(text, fromUser, config, attachments = []) {
  if (attachments.length === 0) return handleText(text, fromUser, config);
  const task = getCurrentTask(fromUser);
  if (!task) return "task 0: 状态异常，未找到默认任务。";
  const savedAttachments = await saveInboundMediaForTask(task, attachments, config);
  return forwardToTask(task, text, config, fromUser, savedAttachments);
}

function localAttachmentFromPath(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  const stat = fs.statSync(resolved);
  const mime = getMimeFromFilename(resolved);
  return {
    kind: mime.startsWith(IMAGE_MIME_PREFIX) ? "image" : "file",
    filePath: resolved,
    fileName: path.basename(resolved),
    mime,
    size: stat.size,
  };
}

async function runOnce(args, config) {
  const text = valueFrom(args.message, args._.join(" "));
  const attachments = args["attach-file"] ? [localAttachmentFromPath(args["attach-file"])] : [];
  if (!text && attachments.length === 0) throw new Error("Missing --message for --once.");
  const response = await handleTextWithAttachments(text || "", "local", config, attachments);
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
        const attachments = extractInboundMedia(message);
        if (!text && attachments.length === 0) continue;
        rememberRecipientContext(config, message, sync);
        const replyTarget = getReplyTarget(message, config);
        const response = await handleTextWithAttachments(text, replyTarget, config, attachments);
        await sendTextWithMedia(response, {
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
  config.dryRun = isDryRun(args, config);

  if (args["send-media"]) {
    await sendTextWithMedia(`${args.message || ""}\nMEDIA:${args["send-media"]}`.trim(), config, args);
    return;
  }

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
  const recovered = recoverStaleTaskQueues(config);
  if (recovered.length > 0) {
    process.stdout.write(`Recovered stale queued tasks: ${recovered.join(", ")}\n`);
  }
  await runPoll(args, config);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
