#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { renderMarkdownImages } from "./markdown-image-renderer.mjs";

const DEFAULT_CONFIG_PATH = "~/.codex/weixin-notifier.json";
const COMPAT_ACCOUNT_PATH = "~/.codex/channels/wechat/account.json";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const MESSAGE_ITEM_TEXT = 1;
const MESSAGE_ITEM_IMAGE = 2;
const MEDIA_TYPE_IMAGE = 1;
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_MARKDOWN_IMAGE_WIDTH = 920;
const DEFAULT_MARKDOWN_IMAGE_MAX_CHARS = 120_000;
const DEFAULT_MARKDOWN_IMAGE_MAX_HEIGHT = 30000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readJsonFile(filePath) {
  if (!filePath) return {};
  const resolved = expandHome(filePath);
  if (!fs.existsSync(resolved)) return {};
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
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

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readEventJson(args) {
  if (args["event-file"]) {
    const eventPath = expandHome(args["event-file"]);
    const raw = fs.readFileSync(eventPath, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  }
  return readStdinJson();
}

function valueFrom(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function isFalseyConfig(value) {
  if (value === false) return true;
  return /^(?:0|false|no|off)$/iu.test(String(value || "").trim());
}

function markdownImageRepliesEnabled(config) {
  if (process.env.CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES !== undefined) {
    return !isFalseyConfig(process.env.CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES);
  }
  if (config.renderMarkdownImages !== undefined && config.renderMarkdownImages !== null && config.renderMarkdownImages !== "") {
    return !isFalseyConfig(config.renderMarkdownImages);
  }
  return true;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function markdownImageOptions(config, title = "Codex task completed") {
  return {
    title,
    chromePath: valueFrom(config.chromePath, process.env.CODEX_WEIXIN_CHROME_PATH, ""),
    width: positiveInteger(valueFrom(config.markdownImageWidth, process.env.CODEX_WEIXIN_MARKDOWN_IMAGE_WIDTH), DEFAULT_MARKDOWN_IMAGE_WIDTH),
    maxChars: positiveInteger(valueFrom(config.markdownImageMaxChars, process.env.CODEX_WEIXIN_MARKDOWN_IMAGE_MAX_CHARS), DEFAULT_MARKDOWN_IMAGE_MAX_CHARS),
    maxHeight: positiveInteger(valueFrom(config.markdownImageMaxHeight, process.env.CODEX_WEIXIN_MARKDOWN_IMAGE_MAX_HEIGHT), DEFAULT_MARKDOWN_IMAGE_MAX_HEIGHT),
  };
}

function stableSessionId(event, args) {
  const explicit = valueFrom(
    args.session,
    event.sessionId,
    event.session_id,
    process.env.CODEX_SESSION_ID,
    process.env.CODEX_RUN_ID,
    process.env.VSCODE_PID && `vscode-${process.env.VSCODE_PID}-${process.pid}`,
  );
  if (explicit) return String(explicit);

  const seed = [
    process.env.PWD || process.cwd(),
    process.env.TERM_SESSION_ID || "",
    process.ppid,
    process.pid,
    Date.now(),
  ].join(":");
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

function normalizeEvent(event, args) {
  const status = valueFrom(args.status, event.status, event.result, "completed");
  const workspace = valueFrom(args.workspace, event.workspace, event.cwd, process.env.PWD, process.cwd());
  const task = valueFrom(args.task, event.task, event.prompt, event.title, "Codex task");
  const summary = valueFrom(args.summary, event.summary, event.message, event.final_message, "");
  const startedAt = valueFrom(args["started-at"], event.startedAt, event.started_at, "");
  const finishedAt = valueFrom(args["finished-at"], event.finishedAt, event.finished_at, new Date().toISOString());

  return {
    sessionId: stableSessionId(event, args),
    source: valueFrom(args.source, event.source, process.env.CODEX_PRODUCT, process.env.TERM_PROGRAM, "codex"),
    status,
    task,
    summary,
    workspace,
    startedAt,
    finishedAt,
  };
}

function normalizedPath(value) {
  return path.resolve(expandHome(String(value || "")));
}

function samePathValue(left, right) {
  if (!left || !right) return false;
  try {
    return normalizedPath(left) === normalizedPath(right);
  } catch {
    return String(left) === String(right);
  }
}

function shouldShowTask(event) {
  const task = String(event.task || "").trim();
  if (!task) return false;
  return !samePathValue(task, event.workspace);
}

function shouldShowWorkspace(event) {
  const workspace = String(event.workspace || "").trim();
  if (!workspace) return false;
  return !samePathValue(event.task, workspace);
}

function formatMessage(event, config) {
  const maxSummaryLength = Number(config.maxSummaryLength || 800);
  const summary = event.summary.length > maxSummaryLength
    ? `${event.summary.slice(0, maxSummaryLength)}...`
    : event.summary;

  const lines = [
    config.title || "Codex task completed",
    `Status: ${event.status}`,
    `Session: ${event.sessionId}`,
    `Source: ${event.source}`,
  ];

  if (shouldShowWorkspace(event)) lines.push(`Workspace: ${event.workspace}`);
  if (shouldShowTask(event)) lines.push(`Task: ${event.task}`);
  if (event.startedAt) lines.push(`Started: ${event.startedAt}`);
  lines.push(`Finished: ${event.finishedAt}`);
  if (summary) lines.push("", summary);
  return lines.join("\n");
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildILinkHeaders(token, extraHeaders = {}) {
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

function buildOfficialSendMessageRequest(message, event, config) {
  const token = valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN);
  const baseUrl = valueFrom(config.baseUrl, config.baseurl, process.env.WEIXIN_ILINK_BASE_URL, DEFAULT_ILINK_BASE_URL);
  const toUser = valueFrom(config.toUser, config.userId, config.ilinkUserId, process.env.WEIXIN_TO_USER);
  const contextToken = valueFrom(config.contextToken, process.env.WEIXIN_CONTEXT_TOKEN);
  if (!token) {
    throw new Error("Missing Weixin iLink token. Run pair-weixin.mjs or set config.token.");
  }
  if (!toUser) {
    throw new Error("Missing Weixin recipient. Run bind-recipient.mjs or set config.toUser.");
  }
  if (!contextToken) {
    throw new Error("Missing Weixin contextToken. Send a message to the paired bot, then run bind-recipient.mjs.");
  }

  const endpoint = new URL("ilink/bot/sendmessage", ensureTrailingSlash(baseUrl)).toString();
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUser,
      client_id: `codex-weixin-${event.sessionId}-${Date.now()}`,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [
        {
          type: MESSAGE_ITEM_TEXT,
          text_item: { text: message },
        },
      ],
      context_token: contextToken,
    },
    base_info: {
      channel_version: "2.4.6",
      bot_agent: "CodexWeixinNotifier/0.1.0",
    },
  };

  return {
    endpoint,
    headers: buildILinkHeaders(token, config.headers || {}),
    body,
  };
}

function buildOfficialMessageItemsRequest(items, event, config) {
  const token = valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN);
  const baseUrl = valueFrom(config.baseUrl, config.baseurl, process.env.WEIXIN_ILINK_BASE_URL, DEFAULT_ILINK_BASE_URL);
  const toUser = valueFrom(config.toUser, config.userId, config.ilinkUserId, process.env.WEIXIN_TO_USER);
  const contextToken = valueFrom(config.contextToken, process.env.WEIXIN_CONTEXT_TOKEN);
  if (!token) {
    throw new Error("Missing Weixin iLink token. Run pair-weixin.mjs or set config.token.");
  }
  if (!toUser) {
    throw new Error("Missing Weixin recipient. Run bind-recipient.mjs or set config.toUser.");
  }
  if (!contextToken) {
    throw new Error("Missing Weixin contextToken. Send a message to the paired bot, then run bind-recipient.mjs.");
  }

  const endpoint = new URL("ilink/bot/sendmessage", ensureTrailingSlash(baseUrl)).toString();
  return {
    endpoint,
    headers: buildILinkHeaders(token, config.headers || {}),
    body: {
      msg: {
        from_user_id: "",
        to_user_id: toUser,
        client_id: `codex-weixin-${event.sessionId}-${Date.now()}`,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: items,
        context_token: contextToken,
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexWeixinNotifier/0.1.0",
      },
    },
  };
}

function buildILinkRequest(message, config) {
  const endpoint = valueFrom(config.endpoint, process.env.WEIXIN_ILINK_ENDPOINT);
  if (!endpoint) {
    throw new Error("Missing Weixin iLink endpoint. Set WEIXIN_ILINK_ENDPOINT or config.endpoint.");
  }

  const token = valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN);
  const botId = valueFrom(config.botId, process.env.WEIXIN_ILINK_BOT_ID);
  const toUser = valueFrom(config.toUser, process.env.WEIXIN_TO_USER);
  const toChat = valueFrom(config.toChat, process.env.WEIXIN_TO_CHAT);

  const headers = {
    "content-type": "application/json",
    ...(config.headers || {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const body = {
    ...(config.body || {}),
    bot_id: botId,
    to_user: toUser,
    to_chat: toChat,
    msg_type: "text",
    text: { content: message },
  };

  for (const key of Object.keys(body)) {
    if (body[key] === undefined || body[key] === null || body[key] === "") delete body[key];
  }

  return { endpoint, headers, body };
}

async function postJson(endpoint, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Weixin iLink request failed: HTTP ${response.status} ${text}`);
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.ret && parsed.ret !== 0) {
        throw new Error(`Weixin iLink request failed: ret=${parsed.ret} errmsg=${parsed.errmsg || "(none)"}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) return text;
      throw error;
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
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
  const endpoint = new URL("ilink/bot/getuploadurl", ensureTrailingSlash(config.baseUrl || DEFAULT_ILINK_BASE_URL)).toString();
  const responseText = await postJson(
    endpoint,
    buildILinkHeaders(valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN), config.headers || {}),
    body,
    Number(valueFrom(config.timeoutMs, 15000)),
  );
  const response = responseText ? JSON.parse(responseText) : {};
  return { response, plaintext, ciphertextSize: body.filesize };
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
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

async function uploadImageFile(filePath, config) {
  const resolved = path.resolve(expandHome(filePath));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Image path is not a file: ${resolved}`);
  const maxBytes = Number(valueFrom(config.maxMediaBytes, process.env.CODEX_WEIXIN_MAX_MEDIA_BYTES, MAX_MEDIA_BYTES));
  if (stat.size > maxBytes) throw new Error(`Image file too large: ${stat.size} bytes > ${maxBytes} bytes`);

  const toUser = valueFrom(config.toUser, config.userId, config.ilinkUserId, process.env.WEIXIN_TO_USER);
  if (!valueFrom(config.token, process.env.WEIXIN_ILINK_TOKEN)) throw new Error("Missing Weixin iLink token. Run pair-weixin.mjs first.");
  if (!toUser) throw new Error("Missing Weixin recipient. Run bind-recipient.mjs first.");

  const aeskey = crypto.randomBytes(16);
  const filekey = crypto.randomBytes(16).toString("hex");
  const { response, plaintext, ciphertextSize } = await getUploadUrl({
    filePath: resolved,
    toUser,
    mediaType: MEDIA_TYPE_IMAGE,
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
    fileSizeCiphertext: ciphertextSize,
    media: {
      encrypt_query_param: downloadEncryptedQueryParam,
      aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"),
      encrypt_type: 1,
    },
  };
}

function imageItemFromUpload(uploaded) {
  return {
    type: MESSAGE_ITEM_IMAGE,
    image_item: {
      media: uploaded.media,
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
}

async function postOfficialImageItems(items, event, config, args) {
  const timeoutMs = Number(valueFrom(args.timeout, config.timeoutMs, DEFAULT_TIMEOUT_MS));
  for (const item of items) {
    const request = buildOfficialMessageItemsRequest([item], event, config);
    await postJson(request.endpoint, request.headers, request.body, timeoutMs);
  }
}

async function trySendMarkdownImageNotification(message, event, config, args) {
  if (!markdownImageRepliesEnabled(config)) return false;
  if (config.endpoint || process.env.WEIXIN_ILINK_ENDPOINT) return false;
  try {
    const rendered = await renderMarkdownImages(message, markdownImageOptions(config, config.title || "Codex task completed"));
    if (config.dryRun) {
      for (const filePath of rendered.filePaths) {
        const stat = fs.statSync(filePath);
        process.stdout.write(`[dry-run media] image ${filePath} ${stat.size} bytes\n`);
      }
      return true;
    }
    const uploaded = [];
    for (const filePath of rendered.filePaths) uploaded.push(await uploadImageFile(filePath, config));
    const items = uploaded.map(imageItemFromUpload);
    await postOfficialImageItems(items, event, config, args);
    return true;
  } catch (error) {
    process.stderr.write(`[markdown-image-fallback] ${error.message}\n`);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stdinEvent = await readEventJson(args);
  const configPath = valueFrom(args.config, process.env.CODEX_WEIXIN_CONFIG, DEFAULT_CONFIG_PATH);
  const config = {
    ...normalizeCompatAccount(readJsonFile(COMPAT_ACCOUNT_PATH)),
    ...readJsonFile(configPath),
    dryRun: args["dry-run"] === "true" || process.env.CODEX_WEIXIN_DRY_RUN === "1",
  };

  const event = normalizeEvent(stdinEvent, args);
  const message = formatMessage(event, config);

  if (await trySendMarkdownImageNotification(message, event, config, args)) {
    if (!config.dryRun) process.stdout.write(`Sent Weixin image notification for session ${event.sessionId}\n`);
    return;
  }

  if (config.dryRun) {
    process.stdout.write(`${message}\n`);
    return;
  }

  const { endpoint, headers, body } = config.endpoint || process.env.WEIXIN_ILINK_ENDPOINT
    ? buildILinkRequest(message, config)
    : buildOfficialSendMessageRequest(message, event, config);
  const timeoutMs = Number(valueFrom(args.timeout, config.timeoutMs, DEFAULT_TIMEOUT_MS));
  await postJson(endpoint, headers, body, timeoutMs);
  process.stdout.write(`Sent Weixin notification for session ${event.sessionId}\n`);
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

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
