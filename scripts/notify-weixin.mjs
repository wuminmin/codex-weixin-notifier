#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONFIG_PATH = "~/.codex/weixin-notifier.json";
const COMPAT_ACCOUNT_PATH = "~/.codex/channels/wechat/account.json";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const MESSAGE_ITEM_TEXT = 1;

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

function valueFrom(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
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
    `Workspace: ${event.workspace}`,
    `Task: ${event.task}`,
    `Finished: ${event.finishedAt}`,
  ];

  if (event.startedAt) lines.splice(6, 0, `Started: ${event.startedAt}`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stdinEvent = await readStdinJson();
  const configPath = valueFrom(args.config, process.env.CODEX_WEIXIN_CONFIG, DEFAULT_CONFIG_PATH);
  const config = {
    ...normalizeCompatAccount(readJsonFile(COMPAT_ACCOUNT_PATH)),
    ...readJsonFile(configPath),
    dryRun: args["dry-run"] === "true" || process.env.CODEX_WEIXIN_DRY_RUN === "1",
  };

  const event = normalizeEvent(stdinEvent, args);
  const message = formatMessage(event, config);

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
