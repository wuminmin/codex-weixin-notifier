import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GENERAL_CONFIG_PATH = "~/.codex/codex-notifier.json";
export const LEGACY_WEIXIN_CONFIG_PATH = "~/.codex/weixin-notifier.json";
export const COMPAT_WEIXIN_ACCOUNT_PATH = "~/.codex/channels/wechat/account.json";
export const LEGACY_WEIXIN_STATE_DIR = "~/.codex/weixin-notifier";
export const LEGACY_WEIXIN_TASK_ROOT = "~/codex";
export const GENERAL_STATE_ROOT = "~/.codex/codex-notifier/state";

export function expandHome(value, home = os.homedir()) {
  if (!value) return value;
  if (value === "~") return home;
  if (String(value).startsWith("~/")) return path.join(home, String(value).slice(2));
  return String(value);
}

export function readJsonFile(filePath, fallback = {}, options = {}) {
  const resolved = expandHome(filePath, options.home);
  try {
    if (!resolved || !fs.existsSync(resolved)) return fallback;
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    if (options.strict) throw error;
    return fallback;
  }
}

export function writeSecureJson(filePath, value, options = {}) {
  const resolved = expandHome(filePath, options.home);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(resolved, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return resolved;
}

function nonEmptyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeCompatWeixinAccount(account) {
  const value = nonEmptyObject(account);
  if (Object.keys(value).length === 0) return {};
  return {
    transport: "ilink-login",
    baseUrl: value.baseUrl,
    token: value.token,
    botId: value.accountId,
    userId: value.userId,
    toUser: value.userId,
  };
}

export function legacyWeixinAsGeneral(legacy, compatAccount = {}) {
  const bot = {
    ...normalizeCompatWeixinAccount(compatAccount),
    ...nonEmptyObject(legacy),
    enabled: legacy?.enabled !== false,
  };
  if (Object.keys(bot).filter((key) => key !== "enabled").length === 0) return null;
  return {
    version: 1,
    defaults: {},
    channels: {
      weixin: {
        accounts: {
          default: {
            displayName: "Weixin",
            bots: { default: bot },
          },
        },
      },
    },
  };
}

function mergeLegacyWeixin(general, legacyGeneral) {
  if (!legacyGeneral) return general;
  const channels = nonEmptyObject(general.channels);
  if (channels.weixin) return general;
  return {
    ...general,
    channels: {
      ...channels,
      weixin: legacyGeneral.channels.weixin,
    },
  };
}

export function resolveNotifierConfigPath(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const explicit = options.configPath || env.CODEX_NOTIFIER_CONFIG || env.CODEX_WEIXIN_CONFIG;
  if (explicit) return { path: expandHome(explicit, home), explicit: true };
  const generalPath = expandHome(options.generalPath || GENERAL_CONFIG_PATH, home);
  if (fs.existsSync(generalPath)) return { path: generalPath, explicit: false };
  return {
    path: expandHome(options.legacyPath || LEGACY_WEIXIN_CONFIG_PATH, home),
    explicit: false,
  };
}

export function loadNotifierConfig(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const resolved = resolveNotifierConfigPath({ ...options, home, env });
  const raw = readJsonFile(resolved.path, {}, { home, strict: Boolean(options.strict && resolved.explicit) });
  const isGeneral = raw?.channels && typeof raw.channels === "object";
  const legacyPath = expandHome(options.legacyPath || LEGACY_WEIXIN_CONFIG_PATH, home);
  const compatPath = expandHome(options.compatPath || COMPAT_WEIXIN_ACCOUNT_PATH, home);
  const legacyRaw = resolved.path === legacyPath ? raw : readJsonFile(legacyPath, {}, { home });
  const legacyGeneral = legacyWeixinAsGeneral(legacyRaw, readJsonFile(compatPath, {}, { home }));
  let config = isGeneral
    ? mergeLegacyWeixin({ version: 1, defaults: {}, ...raw }, legacyGeneral)
    : legacyGeneral || { version: 1, defaults: {}, channels: {} };

  config = {
    ...config,
    version: Number(config.version || 1),
    defaults: nonEmptyObject(config.defaults),
    channels: nonEmptyObject(config.channels),
  };
  return {
    config,
    configPath: resolved.path,
    legacyPath,
    sourceFormat: isGeneral ? "general" : "legacy-weixin",
    home,
  };
}

function selectorMatches(actual, expected) {
  return !expected || String(actual) === String(expected);
}

export function listBotConfigs(loaded, selectors = {}) {
  const general = loaded?.config || loaded || {};
  const results = [];
  for (const [channelName, channelValue] of Object.entries(nonEmptyObject(general.channels))) {
    if (!selectorMatches(channelName, selectors.channel)) continue;
    for (const [accountName, accountValue] of Object.entries(nonEmptyObject(channelValue?.accounts))) {
      if (!selectorMatches(accountName, selectors.account)) continue;
      for (const [botName, botValue] of Object.entries(nonEmptyObject(accountValue?.bots))) {
        if (!selectorMatches(botName, selectors.bot)) continue;
        if (!selectors.includeDisabled && botValue?.enabled === false) continue;
        results.push({
          ...nonEmptyObject(general.defaults),
          ...nonEmptyObject(channelValue?.defaults),
          ...nonEmptyObject(accountValue?.defaults),
          ...nonEmptyObject(botValue),
          enabled: botValue?.enabled !== false,
          channel: channelName,
          account: accountName,
          bot: botName,
          accountDisplayName: accountValue?.displayName || accountName,
          configPath: loaded?.configPath || "",
          configSourceFormat: loaded?.sourceFormat || "general",
          notifierHome: loaded?.home || os.homedir(),
        });
      }
    }
  }
  return results;
}

function safePart(value) {
  const part = String(value || "default")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return part || "default";
}

export function stableContextHash(context, length = 10) {
  const key = [context.channel, context.account, context.bot].map((value) => String(value || "default")).join("\0");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, length);
}

export function contextNamespace(context) {
  return [context.channel || "unknown", context.account || "default", context.bot || "default"].join("/");
}

export function runtimeConfigForBot(botConfig, options = {}) {
  const home = options.home || botConfig.notifierHome || os.homedir();
  const legacyDefault = botConfig.channel === "weixin"
    && botConfig.account === "default"
    && botConfig.bot === "default";
  const hash = stableContextHash(botConfig);
  const namespacedState = path.join(
    expandHome(options.stateRoot || GENERAL_STATE_ROOT, home),
    safePart(botConfig.channel),
    `${safePart(botConfig.account)}-${hash.slice(0, 6)}`,
    `${safePart(botConfig.bot)}-${hash.slice(6)}`,
  );
  const stateDir = expandHome(
    botConfig.stateDir || (legacyDefault ? LEGACY_WEIXIN_STATE_DIR : namespacedState),
    home,
  );
  const taskRoot = expandHome(
    botConfig.taskRoot || (legacyDefault ? LEGACY_WEIXIN_TASK_ROOT : path.join(stateDir, "tasks")),
    home,
  );
  return {
    ...botConfig,
    stateDir,
    taskRoot,
    namespace: contextNamespace(botConfig),
    namespaceHash: hash,
    legacyStateCompat: legacyDefault,
    tmuxPrefix: legacyDefault ? "codex-wx" : `codex-${botConfig.channel === "feishu" ? "fs" : "nt"}-${hash}`,
  };
}

export function selectBotConfig(loaded, selectors = {}) {
  const matches = listBotConfigs(loaded, selectors);
  if (matches.length === 0) {
    throw new Error(`No enabled notifier bot matched channel=${selectors.channel || "*"} account=${selectors.account || "*"} bot=${selectors.bot || "*"}`);
  }
  if (matches.length > 1) {
    throw new Error("More than one notifier bot matched; specify --channel, --account, and --bot.");
  }
  return runtimeConfigForBot(matches[0], { home: loaded.home });
}

export function updateBotConfig(loaded, selectors, updater) {
  if (loaded.sourceFormat !== "general") {
    if (selectors.channel !== "weixin" || selectors.account !== "default" || selectors.bot !== "default") {
      throw new Error("Legacy configuration can only update weixin/default/default.");
    }
    const current = readJsonFile(loaded.configPath, {}, { home: loaded.home });
    return writeSecureJson(loaded.configPath, updater({ ...current }), { home: loaded.home });
  }
  const current = readJsonFile(loaded.configPath, { version: 1, defaults: {}, channels: {} }, { home: loaded.home });
  const account = current.channels?.[selectors.channel]?.accounts?.[selectors.account];
  const bot = account?.bots?.[selectors.bot];
  if (!bot && selectors.channel === "weixin" && selectors.account === "default" && selectors.bot === "default" && loaded.legacyPath) {
    const legacyCurrent = readJsonFile(loaded.legacyPath, {}, { home: loaded.home });
    return writeSecureJson(loaded.legacyPath, updater({ ...legacyCurrent }), { home: loaded.home });
  }
  if (!bot) throw new Error(`Bot config not found: ${selectors.channel}/${selectors.account}/${selectors.bot}`);
  account.bots[selectors.bot] = updater({ ...bot });
  return writeSecureJson(loaded.configPath, current, { home: loaded.home });
}

export function upsertFeishuBotConfig(loaded, accountName, botName, botValue) {
  const configPath = loaded.sourceFormat === "general"
    ? loaded.configPath
    : expandHome(GENERAL_CONFIG_PATH, loaded.home);
  const current = readJsonFile(configPath, { version: 1, defaults: {}, channels: {} }, { home: loaded.home });
  current.version = Number(current.version || 1);
  current.defaults = nonEmptyObject(current.defaults);
  current.channels = nonEmptyObject(current.channels);
  current.channels.feishu = nonEmptyObject(current.channels.feishu);
  current.channels.feishu.accounts = nonEmptyObject(current.channels.feishu.accounts);
  current.channels.feishu.accounts[accountName] = nonEmptyObject(current.channels.feishu.accounts[accountName]);
  const account = current.channels.feishu.accounts[accountName];
  account.displayName ||= accountName;
  account.bots = nonEmptyObject(account.bots);
  const nextBot = {
    ...nonEmptyObject(account.bots[botName]),
    ...botValue,
  };
  if (!Array.isArray(nextBot.notifyTargets)) nextBot.notifyTargets = [];
  account.bots[botName] = nextBot;
  writeSecureJson(configPath, current, { home: loaded.home });
  return configPath;
}
