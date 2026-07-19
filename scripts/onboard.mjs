#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  expandHome,
  GENERAL_CONFIG_PATH,
  readJsonFile,
  writeSecureJson,
} from "./lib/notifier-config.mjs";
import { runSetupFeishu } from "./setup-feishu.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const PLUGIN_DIR = path.dirname(SCRIPT_DIR);

function usage() {
  return [
    "Usage:",
    "  node scripts/onboard.mjs",
    "  node scripts/onboard.mjs --channel weixin --mode qr",
    "  node scripts/onboard.mjs --channel weixin --mode manual",
    "  node scripts/onboard.mjs --channel feishu --platform feishu --mode qr --account company-a --bot codex-main",
    "  node scripts/onboard.mjs --channel feishu --platform lark --mode manual --account company-a --bot codex-main",
    "",
    "Options:",
    "  --channel weixin|feishu   Channel to configure.",
    "  --platform feishu|lark    Feishu platform: Feishu China or Lark international. Default: feishu.",
    "  --mode qr|manual          Authentication mode. Default: qr.",
    "  --account NAME            Feishu/Lark account namespace. Default: company-a.",
    "  --bot NAME                Feishu/Lark bot namespace. Default: codex-main.",
    "  --config PATH             Notifier config path. Default: ~/.codex/codex-notifier.json.",
    "",
    "Success means the router is running and you have received task 0 after sending list in the chat app.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
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

function normalizeChannel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "wx") return "weixin";
  if (normalized === "feis") return "feishu";
  if (normalized === "lark") return "feishu";
  if (normalized === "weixin" || normalized === "feishu") return normalized;
  return "";
}

function normalizePlatform(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "lark") return "lark";
  return "feishu";
}

function normalizeMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["manual", "input", "text"].includes(normalized)) return "manual";
  return "qr";
}

function labelForChannel(channel, platform = "feishu") {
  if (channel === "weixin") return "微信 / Weixin";
  return normalizePlatform(platform) === "lark" ? "Lark 国际版" : "飞书 / Feishu";
}

async function question(prompt, options = {}) {
  if (options.prompt) return options.prompt(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function hiddenQuestion(prompt, options = {}) {
  if (options.hiddenPrompt) return options.hiddenPrompt(prompt);
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    return question(prompt, options);
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

async function choose(prompt, choices, options = {}) {
  if (options.choose) return options.choose(prompt, choices);
  process.stdout.write(`${prompt}\n`);
  choices.forEach((choice, index) => {
    process.stdout.write(`  ${index + 1}. ${choice.label}\n`);
  });
  while (true) {
    const answer = await question("> ", options);
    const byIndex = Number(answer);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= choices.length) return choices[byIndex - 1].value;
    const byValue = choices.find((choice) => choice.value === String(answer).toLowerCase());
    if (byValue) return byValue.value;
    process.stdout.write("Please choose one of the listed options.\n");
  }
}

function runScript(script, args = [], options = {}) {
  if (options.runScript) return options.runScript(script, args);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, script), ...args], {
      cwd: PLUGIN_DIR,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${signal || code}`));
    });
  });
}

function startRouter(options = {}) {
  if (options.startRouter) return options.startRouter();
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(SCRIPT_DIR, "start-router-tmux.sh"), ["--restart"], {
      cwd: PLUGIN_DIR,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`start-router-tmux.sh exited with ${signal || code}`));
    });
  });
}

function configPathFromArgs(args, home = os.homedir()) {
  return expandHome(args.config || process.env.CODEX_NOTIFIER_CONFIG || GENERAL_CONFIG_PATH, home);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function writeWeixinManualConfig(args, values, options = {}) {
  const configPath = configPathFromArgs(args, options.home);
  const current = readJsonFile(configPath, { version: 1, defaults: {}, channels: {} }, { home: options.home });
  current.version = Number(current.version || 1);
  current.defaults = object(current.defaults);
  current.channels = object(current.channels);
  current.channels.weixin = object(current.channels.weixin);
  current.channels.weixin.accounts = object(current.channels.weixin.accounts);
  current.channels.weixin.accounts.default = object(current.channels.weixin.accounts.default);
  const account = current.channels.weixin.accounts.default;
  account.displayName ||= "Weixin";
  account.bots = object(account.bots);
  account.bots.default = {
    ...object(account.bots.default),
    enabled: true,
    transport: "ilink-login",
    baseUrl: values.baseUrl || "https://ilinkai.weixin.qq.com",
    token: values.token,
    botId: values.botId,
    userId: values.userId,
    toUser: values.toUser,
    contextToken: values.contextToken,
  };
  return writeSecureJson(configPath, current, { home: options.home });
}

async function onboardWeixin(args, options = {}) {
  const mode = normalizeMode(args.mode);
  if (mode === "qr") {
    await runScript("pair-weixin.mjs", [], options);
    process.stdout.write("\nSend 'bind codex' to the paired Weixin bot, then press Enter here.\n");
    await question("", options);
    await runScript("bind-recipient.mjs", [], options);
  } else {
    const values = {
      baseUrl: await question("Weixin iLink base URL [https://ilinkai.weixin.qq.com]: ", options) || "https://ilinkai.weixin.qq.com",
      token: await hiddenQuestion("Weixin iLink token (hidden): ", options),
      botId: await question("Weixin bot id: ", options),
      userId: await question("Weixin user id: ", options),
      toUser: await question("Weixin recipient user/chat id: ", options),
      contextToken: await hiddenQuestion("Weixin context token (hidden): ", options),
    };
    writeWeixinManualConfig(args, values, options);
  }
  await finishWithRouter("weixin", "feishu", options);
  return { channel: "weixin", mode };
}

async function setupFeishu(args, platform, mode, options = {}) {
  const account = args.account || "company-a";
  const bot = args.bot || "codex-main";
  const setupArgs = [
    ...(args.config ? ["--config", args.config] : []),
    "--account", account,
    "--bot", bot,
    "--platform", platform,
    "--mode", mode,
  ];
  await (options.runSetupFeishu || runSetupFeishu)(setupArgs, options.setupOptions || {});
  process.stdout.write(`\nFinish the ${labelForChannel("feishu", platform)} developer-console steps, then press Enter to validate the app.\n`);
  await question("", options);
  const checkArgs = [
    ...(args.config ? ["--config", args.config] : []),
    "--account", account,
    "--bot", bot,
    "--platform", platform,
    "--check",
  ];
  await (options.runSetupFeishu || runSetupFeishu)(checkArgs, options.checkOptions || options.setupOptions || {});
  return { account, bot };
}

async function onboardFeishu(args, options = {}) {
  const platform = normalizePlatform(args.platform || args.brand || (normalizeChannel(args.channel) === "feishu" && String(args.channel).toLowerCase() === "lark" ? "lark" : "feishu"));
  const mode = normalizeMode(args.mode);
  const result = await setupFeishu(args, platform, mode, options);
  await finishWithRouter("feishu", platform, options);
  return { channel: "feishu", platform, mode, ...result };
}

async function finishWithRouter(channel, platform, options = {}) {
  await startRouter(options);
  const label = labelForChannel(channel, platform);
  process.stdout.write(`\n${label} router is running.\n`);
  if (channel === "feishu") {
    process.stdout.write("In a DM, send: list\nIn a group, send: @bot list\n");
  } else {
    process.stdout.write("In Weixin, send: list\n");
  }
  process.stdout.write("Press Enter after you receive task 0 [default,current].\n");
  await question("", options);
  process.stdout.write(`Authentication successful for ${label}.\n`);
}

export async function runOnboard(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help === "true" || args.h === "true") {
    process.stdout.write(`${usage()}\n`);
    return { help: true };
  }
  let channel = normalizeChannel(args.channel || args._[0]);
  if (!channel) {
    channel = await choose("Choose a channel:", [
      { label: "微信 / Weixin", value: "weixin" },
      { label: "飞书 / Feishu or Lark", value: "feishu" },
    ], options);
  }
  if (!args.channel) args.channel = channel;
  if (channel === "feishu" && !args.platform && !args.brand) {
    args.platform = await choose("Choose a Feishu platform:", [
      { label: "飞书 / Feishu China", value: "feishu" },
      { label: "Lark international", value: "lark" },
    ], options);
  }
  if (!args.mode) {
    args.mode = await choose("Choose an authentication mode:", [
      { label: "QR scan", value: "qr" },
      { label: "Manual input", value: "manual" },
    ], options);
  }
  if (channel === "weixin") return onboardWeixin(args, options);
  return onboardFeishu(args, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  runOnboard().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

export const onboardForTests = {
  configPathFromArgs,
  labelForChannel,
  normalizeChannel,
  normalizeMode,
  normalizePlatform,
  parseArgs,
  usage,
  writeWeixinManualConfig,
};
