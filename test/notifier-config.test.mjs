import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  contextNamespace,
  listBotConfigs,
  loadNotifierConfig,
  runtimeConfigForBot,
  stableContextHash,
  updateBotConfig,
} from "../scripts/lib/notifier-config.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-notifier-config-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

test("loads general config before legacy config and merges legacy Weixin when absent", () => {
  const home = tempHome();
  const generalPath = path.join(home, ".codex", "codex-notifier.json");
  const legacyPath = path.join(home, ".codex", "weixin-notifier.json");
  writeJson(generalPath, {
    version: 1,
    defaults: { runner: "interactive" },
    channels: { feishu: { accounts: { a: { bots: { one: { appId: "cli_one", appSecret: "s" } } } } } },
  });
  writeJson(legacyPath, { token: "wx-token", toUser: "wx-user" });

  const loaded = loadNotifierConfig({ home });
  assert.equal(loaded.configPath, generalPath);
  assert.equal(loaded.sourceFormat, "general");
  assert.equal(listBotConfigs(loaded, { channel: "feishu" }).length, 1);
  assert.equal(listBotConfigs(loaded, { channel: "weixin" })[0].token, "wx-token");
  updateBotConfig(loaded, { channel: "weixin", account: "default", bot: "default" }, (current) => ({
    ...current,
    contextToken: "updated-context",
  }));
  assert.equal(JSON.parse(fs.readFileSync(legacyPath, "utf8")).contextToken, "updated-context");
  assert.equal(JSON.parse(fs.readFileSync(generalPath, "utf8")).channels.weixin, undefined);
});

test("maps a legacy Weixin config to weixin/default/default without migration", () => {
  const home = tempHome();
  const legacyPath = path.join(home, ".codex", "weixin-notifier.json");
  writeJson(legacyPath, { token: "legacy-token", toUser: "recipient", codexCwd: home });
  const loaded = loadNotifierConfig({ home });
  const [bot] = listBotConfigs(loaded, { channel: "weixin" });
  assert.equal(loaded.sourceFormat, "legacy-weixin");
  assert.equal(bot.account, "default");
  assert.equal(bot.bot, "default");
  assert.equal(bot.token, "legacy-token");
  const runtime = runtimeConfigForBot(bot, { home });
  assert.equal(runtime.stateDir, path.join(home, ".codex", "weixin-notifier"));
  assert.equal(runtime.taskRoot, path.join(home, "codex"));
  assert.equal(runtime.tmuxPrefix, "codex-wx");
});

test("explicit config overrides CODEX_NOTIFIER_CONFIG and default files", () => {
  const home = tempHome();
  const envPath = path.join(home, "env.json");
  const explicitPath = path.join(home, "explicit.json");
  writeJson(envPath, { version: 1, channels: { feishu: { accounts: { env: { bots: { bot: {} } } } } } });
  writeJson(explicitPath, { version: 1, channels: { feishu: { accounts: { explicit: { bots: { bot: {} } } } } } });
  const fromEnv = loadNotifierConfig({ home, env: { CODEX_NOTIFIER_CONFIG: envPath } });
  assert.equal(fromEnv.configPath, envPath);
  const explicit = loadNotifierConfig({ home, env: { CODEX_NOTIFIER_CONFIG: envPath }, configPath: explicitPath });
  assert.equal(explicit.configPath, explicitPath);
  assert.equal(listBotConfigs(explicit, { channel: "feishu" })[0].account, "explicit");
});

test("creates stable and isolated namespaces for multiple Feishu bots", () => {
  const a1 = { channel: "feishu", account: "company-a", bot: "main" };
  const a2 = { channel: "feishu", account: "company-a", bot: "review" };
  const b1 = { channel: "feishu", account: "company-b", bot: "main" };
  assert.equal(stableContextHash(a1), stableContextHash({ ...a1 }));
  assert.notEqual(stableContextHash(a1), stableContextHash(a2));
  assert.notEqual(stableContextHash(a1), stableContextHash(b1));
  assert.equal(contextNamespace(a1), "feishu/company-a/main");
  const home = tempHome();
  const runtimes = [a1, a2, b1].map((item) => runtimeConfigForBot(item, { home }));
  assert.equal(new Set(runtimes.map((item) => item.stateDir)).size, 3);
  assert.equal(new Set(runtimes.map((item) => item.taskRoot)).size, 3);
  assert.equal(new Set(runtimes.map((item) => item.tmuxPrefix)).size, 3);
});

test("filters enabled bots by channel, account, and bot", () => {
  const loaded = {
    home: tempHome(),
    configPath: "/tmp/test.json",
    sourceFormat: "general",
    config: {
      defaults: { runner: "interactive" },
      channels: {
        feishu: {
          accounts: {
            a: { bots: { one: { enabled: true }, two: { enabled: false } } },
            b: { bots: { one: { enabled: true } } },
          },
        },
      },
    },
  };
  assert.equal(listBotConfigs(loaded, { channel: "feishu" }).length, 2);
  assert.deepEqual(listBotConfigs(loaded, { channel: "feishu", account: "a" }).map((item) => item.bot), ["one"]);
  assert.equal(listBotConfigs(loaded, { channel: "feishu", account: "a", includeDisabled: true }).length, 2);
});
