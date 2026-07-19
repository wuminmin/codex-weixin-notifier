#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { formatMessage, normalizeEvent, sendWeixinNotification } from "./notify-weixin.mjs";
import { listBotConfigs, loadNotifierConfig, runtimeConfigForBot } from "./lib/notifier-config.mjs";
import { sendFeishuMarkdown } from "./lib/feishu-channel.mjs";

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

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (String(value || "").startsWith("~/")) return path.join(os.homedir(), String(value).slice(2));
  return value;
}

async function readEvent(args) {
  if (args["event-file"]) {
    const raw = fs.readFileSync(expandHome(args["event-file"]), "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  }
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function matchesTarget(target, selector) {
  if (!selector) return true;
  return String(target.id || "") === String(selector)
    || String(target.chatId || target.toUser || "") === String(selector);
}

export function notificationTargets(loaded, selectors = {}) {
  const targets = [];
  const bots = listBotConfigs(loaded, {
    channel: selectors.channel,
    account: selectors.account,
    bot: selectors.bot,
  });
  for (const bot of bots) {
    const config = runtimeConfigForBot(bot, { home: loaded.home });
    if (bot.channel === "weixin") {
      const target = {
        id: bot.notifyTargetId || "default",
        toUser: bot.toUser || bot.userId,
      };
      if (matchesTarget(target, selectors.target)) targets.push({ ...config, target });
      continue;
    }
    if (bot.channel !== "feishu") continue;
    for (const target of Array.isArray(bot.notifyTargets) ? bot.notifyTargets : []) {
      if (target?.enabled === false || !target?.chatId || !matchesTarget(target, selectors.target)) continue;
      targets.push({ ...config, target: { ...target } });
    }
  }
  return targets;
}

export async function fanOutNotification(event, targets, options = {}) {
  const sendWeixin = options.sendWeixin || sendWeixinNotification;
  const sendFeishu = options.sendFeishu || (async (normalizedEvent, config) => {
    const message = formatMessage(normalizedEvent, config);
    return sendFeishuMarkdown(message, {
      ...config,
      toChat: config.target.chatId,
      chatId: config.target.chatId,
    }, { dryRun: config.dryRun });
  });
  return Promise.all(targets.map(async (config) => {
    const label = `${config.channel}/${config.account}/${config.bot}/${config.target.id || config.target.chatId || "default"}`;
    try {
      if (config.channel === "weixin") await sendWeixin(event, config, options.args || {});
      else if (config.channel === "feishu") await sendFeishu(event, config, options.args || {});
      else throw new Error(`Unsupported notification channel: ${config.channel}`);
      return { ok: true, label };
    } catch (error) {
      return { ok: false, label, error: error.message };
    }
  }));
}

export async function runNotifier(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const loaded = loadNotifierConfig({
    configPath: args.config || process.env.CODEX_NOTIFIER_CONFIG || process.env.CODEX_WEIXIN_CONFIG,
  });
  const targets = notificationTargets(loaded, {
    channel: args.channel,
    account: args.account,
    bot: args.bot,
    target: args.target,
  }).map((config) => ({
    ...config,
    dryRun: args["dry-run"] === "true" || process.env.CODEX_NOTIFIER_DRY_RUN === "1" || process.env.CODEX_WEIXIN_DRY_RUN === "1",
  }));
  if (targets.length === 0) throw new Error("No enabled notification targets matched the requested selectors.");
  const event = normalizeEvent(await readEvent(args), args);
  const results = await fanOutNotification(event, targets, { args });
  for (const result of results) {
    process.stdout.write(`${result.ok ? "ok" : "failed"} ${result.label}${result.error ? `: ${result.error}` : ""}\n`);
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
  return results;
}

const scriptPath = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (invokedDirectly) {
  runNotifier().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
