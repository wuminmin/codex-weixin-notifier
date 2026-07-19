#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline/promises";
import qrcode from "qrcode-terminal";
import * as lark from "@larksuiteoapi/node-sdk";
import { createFeishuChannel } from "./lib/feishu-channel.mjs";
import {
  listBotConfigs,
  loadNotifierConfig,
  runtimeConfigForBot,
  upsertFeishuBotConfig,
} from "./lib/notifier-config.mjs";

const FEISHU_ADDONS = {
  preset: true,
  scopes: {
    tenant: [
      "application:bot.basic_info:read",
      "im:message.group_at_msg:readonly",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
      "im:resource",
    ],
  },
  events: {
    items: {
      tenant: ["im.message.receive_v1"],
    },
  },
};

function usage() {
  return [
    "Usage:",
    "  node scripts/setup-feishu.mjs --account NAME --bot NAME --mode manual [--config PATH]",
    "  node scripts/setup-feishu.mjs --account NAME --bot NAME --mode qr [--config PATH]",
    "  node scripts/setup-feishu.mjs --account NAME --bot NAME --check [--config PATH]",
    "",
    "Manual mode prompts for App ID and a hidden App Secret. QR mode uses the official Feishu SDK app-registration flow.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = "true";
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function validName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(String(value || ""));
}

async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function manualCredentials(options = {}) {
  if (options.credentials) return options.credentials;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let appId;
  try {
    appId = (await rl.question("Feishu App ID: ")).trim();
  } finally {
    rl.close();
  }
  const appSecret = await hiddenQuestion("Feishu App Secret (hidden): ");
  return { appId, appSecret };
}

async function qrCredentials(account, bot, options = {}) {
  const sdk = options.sdk || lark;
  const registerApp = options.registerApp || sdk.registerApp;
  const result = await registerApp({
    source: "codex-notifier",
    createOnly: true,
    appPreset: {
      name: `Codex ${bot}`,
      desc: `Codex task bot for ${account}`,
    },
    addons: FEISHU_ADDONS,
    onQRCodeReady(info) {
      process.stdout.write(`Open this Feishu link (expires in ${info.expireIn}s):\n${info.url}\n`);
      qrcode.generate(info.url, { small: true });
    },
    onStatusChange(info) {
      if (info.status !== "polling") process.stdout.write(`Registration status: ${info.status}\n`);
    },
  });
  if (result.user_info?.tenant_brand === "lark") {
    throw new Error("This release supports Feishu China tenants only; Lark tenants are not yet supported.");
  }
  return { appId: result.client_id, appSecret: result.client_secret };
}

async function checkBot(loaded, account, bot, options = {}) {
  const matches = listBotConfigs(loaded, { channel: "feishu", account, bot, includeDisabled: true });
  if (matches.length !== 1) throw new Error(`Feishu bot not found: ${account}/${bot}`);
  const config = runtimeConfigForBot(matches[0], { home: loaded.home });
  const channel = options.channel || createFeishuChannel(config, { sdk: options.sdk });
  await channel.connect();
  try {
    process.stdout.write(`ok feishu/${account}/${bot} appId=${config.appId} bot=${channel.botIdentity?.name || "unknown"} openId=${channel.botIdentity?.openId || "unknown"}\n`);
  } finally {
    await channel.disconnect();
  }
  return config;
}

export async function runSetupFeishu(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help === "true" || args.h === "true") {
    process.stdout.write(`${usage()}\n`);
    return { help: true };
  }
  const account = args.account;
  const bot = args.bot;
  if (!validName(account) || !validName(bot)) {
    throw new Error("--account and --bot are required and may contain letters, numbers, dot, underscore, or hyphen.");
  }
  const loaded = loadNotifierConfig({ configPath: args.config || process.env.CODEX_NOTIFIER_CONFIG });
  if (args.check === "true") return checkBot(loaded, account, bot, options);

  const mode = args.mode || "manual";
  const credentials = mode === "manual"
    ? await manualCredentials(options)
    : mode === "qr"
      ? await qrCredentials(account, bot, options)
      : null;
  if (!credentials) throw new Error("--mode must be manual or qr.");
  if (!/^cli_[A-Za-z0-9]+$/u.test(credentials.appId || "")) throw new Error("Invalid Feishu App ID.");
  if (!String(credentials.appSecret || "").trim()) throw new Error("Feishu App Secret is required.");

  const configPath = upsertFeishuBotConfig(loaded, account, bot, {
    enabled: true,
    appId: credentials.appId,
    appSecret: credentials.appSecret,
  });
  process.stdout.write(`Saved feishu/${account}/${bot} to ${configPath} with mode 0600.\n`);
  process.stdout.write("Publish the app, approve requested permissions, enable long-connection events, and add the bot to target groups.\n");
  return { configPath, account, bot };
}

if (process.argv[1]?.endsWith("setup-feishu.mjs")) {
  runSetupFeishu().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
