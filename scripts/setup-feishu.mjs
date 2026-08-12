#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline/promises";
import qrcode from "qrcode-terminal";
import * as lark from "@larksuiteoapi/node-sdk";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./lib/catm-config.mjs";
import { createFeishuChannel } from "./lib/feishu-channel.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) {
    const key = argv[i].slice(2); const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; }
  }
  return out;
}

async function hidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
  }
  process.stdout.write(prompt); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (data) => { for (const char of data) {
      if (char === "\r" || char === "\n") { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); resolve(value.trim()); return; }
      if (char === "\u0003") { process.stdin.setRawMode(false); reject(new Error("Cancelled")); return; }
      if (char === "\u007f") value = value.slice(0, -1); else value += char;
    } };
    process.stdin.on("data", onData);
  });
}

async function manual() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let appId;
  try { appId = (await rl.question("Feishu App ID: ")).trim(); } finally { rl.close(); }
  return { appId, appSecret: await hidden("Feishu App Secret (hidden): ") };
}

async function qr(options = {}) {
  const registerApp = options.registerApp || lark.registerApp;
  const result = await registerApp({
    domain: "accounts.feishu.cn",
    larkDomain: "accounts.larksuite.com", source: "catm", createOnly: true,
    appPreset: { name: "CATM", desc: "CATM author control" },
    addons: { preset: true, scopes: { tenant: ["application:bot.basic_info:read", "im:message.group_at_msg:readonly", "im:message.p2p_msg:readonly", "im:message:send_as_bot"] }, events: { items: { tenant: ["im.message.receive_v1"] } } },
    onQRCodeReady(info) { process.stdout.write(`${info.url}\n`); qrcode.generate(info.url, { small: true }); },
  });
  return { appId: result.client_id, appSecret: result.client_secret };
}

export async function runSetupFeishu(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.platform) throw new Error("--platform was removed; CATM 2.0 supports Feishu only");
  if (args.mode && !["manual", "qr"].includes(String(args.mode))) throw new Error("--mode must be manual or qr");
  const loaded = loadConfig(options);
  const tenant = loaded.config.tenants[loaded.config.defaultTenantId];
  if (args.check) {
    const existing = tenant.channels.feishu;
    if (!existing) throw new Error("feishu is not configured");
    const client = createFeishuChannel({ ...existing, account: "default", bot: "feishu" });
    await client.connect(); await client.disconnect();
    process.stdout.write("feishu connection ok.\n");
    return existing;
  }
  const credentials = options.credentials || (args.mode === "qr" ? await qr(options) : await manual());
  if (!/^cli_[A-Za-z0-9]+$/u.test(credentials.appId || "") || !credentials.appSecret) throw new Error("Invalid app credentials");
  const channel = { type: "feishu", enabled: true, appId: credentials.appId, appSecret: credentials.appSecret, authorTargets: {} };
  tenant.channels.feishu = channel;
  saveConfig(loaded.config, { paths: loaded.paths });
  process.stdout.write(`feishu saved to ${loaded.paths.configPath}. Publish the app, enable long-connection message events, restart CATM, then run "catm bind-code".\n`);
  return channel;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runSetupFeishu().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
