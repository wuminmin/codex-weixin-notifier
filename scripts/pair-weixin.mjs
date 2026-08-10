#!/usr/bin/env node

import crypto from "node:crypto";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./lib/catm-config.mjs";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) {
    const key = argv[i].slice(2); const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; }
  }
  return out;
}

function headers(token) {
  return {
    "content-type": "application/json",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": CLIENT_VERSION,
    "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64"),
    ...(token ? { authorization: `Bearer ${token}`, AuthorizationType: "ilink_bot_token" } : {}),
  };
}

async function request(baseUrl, endpoint, { method = "GET", body, token, timeout = 40_000 } = {}) {
  const response = await fetch(new URL(endpoint, `${baseUrl.replace(/\/?$/u, "/")}`), {
    method, headers: headers(token), ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Weixin HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function displayQr(url) {
  const qrcode = await import("qrcode-terminal");
  qrcode.default.generate(url, { small: true });
  process.stdout.write(`\nQR URL: ${url}\n\n`);
}

export async function runPairWeixin(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const loaded = loadConfig(options);
  const baseUrl = String(args["base-url"] || DEFAULT_BASE_URL);
  const start = await request(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(args["bot-type"] || "3")}`, { method: "POST", body: { local_token_list: [] } });
  if (!start.qrcode || !start.qrcode_img_content) throw new Error("Unexpected Weixin QR response");
  process.stdout.write("Scan this QR code with Weixin.\n");
  await displayQr(start.qrcode_img_content);
  const deadline = Date.now() + 8 * 60_000;
  let activeBase = baseUrl;
  let verifyCode = "";
  while (Date.now() < deadline) {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(start.qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    let status;
    try { status = await request(activeBase, endpoint); } catch (error) { if (error.name === "TimeoutError") continue; throw error; }
    if (status.status === "scaned_but_redirect" && status.redirect_host) activeBase = `https://${status.redirect_host}`;
    else if (status.status === "need_verifycode") {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { verifyCode = (await rl.question("Enter the number shown in Weixin: ")).trim(); } finally { rl.close(); }
    } else if (status.status === "expired") throw new Error("Weixin QR code expired");
    else if (status.status === "verify_code_blocked") throw new Error("Weixin verification is temporarily blocked");
    else if (status.status === "confirmed") {
      if (!status.bot_token || !status.ilink_bot_id) throw new Error("Weixin confirmation did not return credentials");
      const tenant = loaded.config.tenants[loaded.config.defaultTenantId];
      tenant.channels.weixin = {
        type: "weixin", enabled: true, baseUrl: status.baseurl || activeBase,
        token: status.bot_token, botId: status.ilink_bot_id, userId: status.ilink_user_id || "", authorTargets: {},
      };
      saveConfig(loaded.config, { paths: loaded.paths });
      process.stdout.write(`Weixin saved to ${loaded.paths.configPath}. Restart CATM, then run \"catm bind-code\".\n`);
      return tenant.channels.weixin;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Weixin pairing timed out");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runPairWeixin().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
