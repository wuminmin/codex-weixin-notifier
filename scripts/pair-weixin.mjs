#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const DEFAULT_CONFIG_PATH = "~/.codex/weixin-notifier.json";
const COMPAT_ACCOUNT_PATH = "~/.codex/channels/wechat/account.json";
const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_ILINK_BOT_TYPE = "3";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const LOGIN_TIMEOUT_MS = 8 * 60_000;

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

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildCommonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildPostHeaders(token) {
  const headers = {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(baseUrl, endpoint, body, token, timeoutMs = 15_000) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
  return fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: buildPostHeaders(token),
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

async function getJson(baseUrl, endpoint, timeoutMs = QR_LONG_POLL_TIMEOUT_MS) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
  return fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: buildCommonHeaders(),
    },
    timeoutMs,
  );
}

async function displayQRCode(qrcodeUrl) {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeUrl, { small: true });
  } catch {
    process.stdout.write("Could not render a terminal QR code. Open this URL instead:\n");
  }
  process.stdout.write(`\nQR URL: ${qrcodeUrl}\n\n`);
}

async function promptLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function saveConfig(configPath, update) {
  const resolved = expandHome(configPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let existing = {};
  try {
    if (fs.existsSync(resolved)) {
      existing = JSON.parse(fs.readFileSync(resolved, "utf8"));
    }
  } catch {
    existing = {};
  }
  const merged = {
    ...existing,
    ...update,
    pairedAt: new Date().toISOString(),
  };
  fs.writeFileSync(resolved, JSON.stringify(merged, null, 2), "utf8");
  try {
    fs.chmodSync(resolved, 0o600);
  } catch {
    // best effort on filesystems that support chmod
  }
  return resolved;
}

function saveCompatAccount(update) {
  const resolved = expandHome(COMPAT_ACCOUNT_PATH);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const account = {
    token: update.token,
    baseUrl: update.baseUrl,
    accountId: update.botId,
    userId: update.userId,
    savedAt: update.pairedAt || new Date().toISOString(),
  };
  fs.writeFileSync(resolved, JSON.stringify(account, null, 2) + "\n", "utf8");
  try {
    fs.chmodSync(resolved, 0o600);
  } catch {
    // best effort on filesystems that support chmod
  }
  return resolved;
}

async function startLogin(baseUrl, botType) {
  return postJson(
    baseUrl,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    { local_token_list: [] },
  );
}

async function pollStatus(baseUrl, qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await getJson(baseUrl, endpoint);
  } catch (error) {
    if (error?.name === "AbortError") return { status: "wait" };
    process.stdout.write(`\nPolling warning: ${String(error.message || error)}\n`);
    return { status: "wait" };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config || process.env.CODEX_WEIXIN_CONFIG || DEFAULT_CONFIG_PATH;
  const botType = args["bot-type"] || process.env.WEIXIN_ILINK_BOT_TYPE || DEFAULT_ILINK_BOT_TYPE;
  const startBaseUrl = args["base-url"] || process.env.WEIXIN_ILINK_BASE_URL || DEFAULT_ILINK_BASE_URL;

  process.stdout.write("Starting Codex Weixin pairing. Scan the QR code with Weixin.\n\n");
  const qrResponse = await startLogin(startBaseUrl, botType);
  if (!qrResponse.qrcode || !qrResponse.qrcode_img_content) {
    throw new Error(`Unexpected QR response: ${JSON.stringify(qrResponse)}`);
  }
  await displayQRCode(qrResponse.qrcode_img_content);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let currentBaseUrl = startBaseUrl;
  let verifyCode;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollStatus(currentBaseUrl, qrResponse.qrcode, verifyCode);
    switch (status.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          process.stdout.write("\nScanned. Confirm authorization on your phone.\n");
          scannedPrinted = true;
        }
        verifyCode = undefined;
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) currentBaseUrl = `https://${status.redirect_host}`;
        break;
      case "need_verifycode":
        verifyCode = await promptLine("\nEnter the number shown in Weixin: ");
        break;
      case "verify_code_blocked":
        throw new Error("Too many wrong verification-code attempts. Run pairing again later.");
      case "expired":
        throw new Error("QR code expired. Run pairing again.");
      case "binded_redirect":
        process.stdout.write("\nThis Weixin account is already paired with this iLink bot.\n");
        return;
      case "confirmed": {
        if (!status.bot_token || !status.ilink_bot_id) {
          throw new Error(`Confirmed but missing token or bot id: ${JSON.stringify(status)}`);
        }
        const pairedAt = new Date().toISOString();
        const credentials = {
          transport: "ilink-login",
          baseUrl: status.baseurl || currentBaseUrl,
          token: status.bot_token,
          botId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          toUser: status.ilink_user_id,
          title: "Codex task completed",
          timeoutMs: 8000,
          maxSummaryLength: 800,
          pairedAt,
        };
        const savedPath = saveConfig(configPath, credentials);
        const compatPath = saveCompatAccount(credentials);
        process.stdout.write(`\nPaired. Config saved to ${savedPath}\n`);
        process.stdout.write(`Compat account saved to ${compatPath}\n`);
        return;
      }
      default:
        process.stdout.write(`\nUnknown status: ${JSON.stringify(status)}\n`);
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Pairing timed out. Run pairing again.");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
