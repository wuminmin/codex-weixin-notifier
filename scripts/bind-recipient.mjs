#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONFIG_PATH = "~/.codex/weixin-notifier.json";
const COMPAT_ACCOUNT_PATH = "~/.codex/channels/wechat/account.json";
const COMPAT_CONTEXT_TOKENS_PATH = "~/.codex/channels/wechat/context_tokens.json";
const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const LONG_POLL_TIMEOUT_MS = 35_000;
const BIND_TIMEOUT_MS = 5 * 60_000;
const MESSAGE_TYPE_USER = 1;

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
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
  fs.writeFileSync(resolved, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    fs.chmodSync(resolved, 0o600);
  } catch {
    // best effort
  }
  return resolved;
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildHeaders(token, body) {
  const headers = {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
  return headers;
}

async function postJson({ baseUrl, endpoint, token, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const rawBody = JSON.stringify(body);
  try {
    const response = await fetch(new URL(endpoint, ensureTrailingSlash(baseUrl)).toString(), {
      method: "POST",
      headers: buildHeaders(token, rawBody),
      body: rawBody,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    return JSON.parse(text);
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: body.get_updates_buf };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCompatAccount(account) {
  return {
    baseUrl: account.baseUrl,
    token: account.token,
    botId: account.accountId,
    userId: account.userId,
    toUser: account.userId,
  };
}

function loadConfig(configPath) {
  return {
    ...normalizeCompatAccount(readJsonFile(COMPAT_ACCOUNT_PATH, {})),
    ...readJsonFile(configPath, {}),
  };
}

function extractText(message) {
  for (const item of message.item_list || []) {
    const text = item?.text_item?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

function getReplyTarget(message) {
  return message.group_id || message.from_user_id || null;
}

function isInboundUserMessage(message) {
  return message?.message_type === MESSAGE_TYPE_USER;
}

async function getUpdates(config, syncBuf) {
  return postJson({
    baseUrl: config.baseUrl || DEFAULT_ILINK_BASE_URL,
    endpoint: "ilink/bot/getupdates",
    token: config.token,
    timeoutMs: LONG_POLL_TIMEOUT_MS,
    body: {
      get_updates_buf: syncBuf || "",
      base_info: { channel_version: "0.1.2" },
    },
  });
}

function persistBinding(configPath, config, message, syncBuf) {
  const replyTarget = getReplyTarget(message);
  const contextToken = message.context_token;
  if (!replyTarget || !contextToken) {
    throw new Error(`Inbound message missing reply target or context token: ${JSON.stringify(message)}`);
  }

  const updated = {
    ...config,
    toUser: replyTarget,
    contextToken,
    boundFromUser: message.from_user_id,
    boundGroup: message.group_id,
    boundMessageId: message.message_id,
    boundText: extractText(message),
    boundAt: new Date().toISOString(),
  };
  const savedPath = writeJsonFile(configPath, updated);

  const compatContextTokens = readJsonFile(COMPAT_CONTEXT_TOKENS_PATH, {});
  compatContextTokens[replyTarget] = contextToken;
  if (message.group_id && message.from_user_id) {
    compatContextTokens[message.from_user_id] = contextToken;
  }
  const contextPath = writeJsonFile(COMPAT_CONTEXT_TOKENS_PATH, compatContextTokens);

  const syncPath = writeJsonFile("~/.codex/channels/wechat/sync_buf.json", {
    get_updates_buf: syncBuf || "",
    updatedAt: new Date().toISOString(),
  });

  return { savedPath, contextPath, syncPath, replyTarget };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config || process.env.CODEX_WEIXIN_CONFIG || DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);
  if (!config.token) throw new Error("Missing token. Run pair-weixin.mjs first.");

  process.stdout.write("Send any message to the paired Weixin bot now, for example: bind codex\n");
  process.stdout.write("Waiting for inbound Weixin message");

  const deadline = Date.now() + Number(args.timeout || BIND_TIMEOUT_MS);
  let syncBuf = "";
  while (Date.now() < deadline) {
    const updates = await getUpdates(config, syncBuf);
    syncBuf = updates.get_updates_buf || syncBuf;
    for (const message of updates.msgs || []) {
      if (!isInboundUserMessage(message)) continue;
      if (!message.context_token) continue;
      const result = persistBinding(configPath, config, message, syncBuf);
      process.stdout.write(`\nBound recipient: ${result.replyTarget}\n`);
      process.stdout.write(`Config updated: ${result.savedPath}\n`);
      process.stdout.write(`Compat context updated: ${result.contextPath}\n`);
      return;
    }
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Timed out waiting for an inbound Weixin message.");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
