import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOnboard, onboardForTests } from "../scripts/onboard.mjs";

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-onboard-"));
  return path.join(dir, "codex-notifier.json");
}

function options(overrides = {}) {
  const prompts = [...(overrides.prompts || [])];
  const hidden = [...(overrides.hidden || [])];
  const scripts = [];
  const setup = [];
  let routerStarts = 0;
  return {
    scripts,
    setup,
    get routerStarts() { return routerStarts; },
    prompt: async () => prompts.shift() ?? "",
    hiddenPrompt: async () => hidden.shift() ?? "",
    runScript: async (script, args) => scripts.push({ script, args }),
    runSetupFeishu: async (args) => setup.push(args),
    startRouter: async () => { routerStarts += 1; },
    ...overrides,
  };
}

test("help uses standard channel and platform names", () => {
  const help = onboardForTests.usage();
  assert.match(help, /--channel weixin\|feishu/u);
  assert.match(help, /--platform feishu\|lark/u);
  assert.doesNotMatch(help, /\bfeis\b/u);
  assert.doesNotMatch(help, /\bwx\b/u);
});

test("channel aliases normalize without being primary help text", () => {
  assert.equal(onboardForTests.normalizeChannel("wx"), "weixin");
  assert.equal(onboardForTests.normalizeChannel("feis"), "feishu");
  assert.equal(onboardForTests.normalizeChannel("lark"), "feishu");
});

test("weixin QR onboard calls pair and bind before router verification", async () => {
  const opt = options({ prompts: ["", ""] });
  const result = await runOnboard(["--channel", "weixin", "--mode", "qr"], opt);
  assert.equal(result.channel, "weixin");
  assert.deepEqual(opt.scripts.map((item) => item.script), ["pair-weixin.mjs", "bind-recipient.mjs"]);
  assert.equal(opt.routerStarts, 1);
});

test("weixin manual onboard writes a general config", async () => {
  const configPath = tempConfig();
  const opt = options({
    prompts: ["", "bot-id", "user-id", "recipient", ""],
    hidden: ["token", "context"],
  });
  await runOnboard(["--channel", "weixin", "--mode", "manual", "--config", configPath], opt);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const bot = config.channels.weixin.accounts.default.bots.default;
  assert.equal(bot.token, "token");
  assert.equal(bot.botId, "bot-id");
  assert.equal(bot.contextToken, "context");
  assert.equal(opt.routerStarts, 1);
});

for (const platform of ["feishu", "lark"]) {
  for (const mode of ["qr", "manual"]) {
    test(`${platform} ${mode} onboard runs setup, check, and router verification`, async () => {
      const configPath = tempConfig();
      const opt = options({ prompts: ["", ""] });
      const result = await runOnboard([
        "--channel", "feishu",
        "--platform", platform,
        "--mode", mode,
        "--account", "a",
        "--bot", "main",
        "--config", configPath,
      ], opt);
      assert.equal(result.channel, "feishu");
      assert.equal(result.platform, platform);
      assert.equal(opt.setup.length, 2);
      assert.deepEqual(opt.setup[0], ["--config", configPath, "--account", "a", "--bot", "main", "--platform", platform, "--mode", mode]);
      assert.deepEqual(opt.setup[1], ["--config", configPath, "--account", "a", "--bot", "main", "--platform", platform, "--check"]);
      assert.equal(opt.routerStarts, 1);
    });
  }
}
