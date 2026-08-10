import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { configureClient, maskedAgentTemplate, updateClientEndpoint } from "../scripts/lib/client-config.mjs";
import { destructiveLegacyCleanup, isLegacyTmuxName } from "../scripts/lib/destructive-cleanup.mjs";
import { newConfig } from "../scripts/lib/catm-config.mjs";
import { tempEnvironment } from "./helpers.mjs";

test("client writers use one endpoint, independent tokens, long timeouts, and managed prompts", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const config = newConfig({ port: 62010 });
  configureClient("codex", config, "token-one", { home: env.home });
  configureClient("claude", config, "token-two", { home: env.home });
  configureClient("opencode", config, "token-three", { home: env.home });
  const codex = fs.readFileSync(path.join(env.home, ".codex", "config.toml"), "utf8");
  const claude = JSON.parse(fs.readFileSync(path.join(env.home, ".claude.json"), "utf8"));
  const opencode = JSON.parse(fs.readFileSync(path.join(env.home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.match(codex, /tool_timeout_sec = 21630/u);
  assert.equal(claude.mcpServers.catm.timeout, 21_630_000);
  assert.equal(opencode.mcp.servers.catm.timeout.execution, 21_630_000);
  assert.equal(opencode.mcp.servers.catm.oauth, false);
  assert.ok([codex, JSON.stringify(claude), JSON.stringify(opencode)].every((text) => text.includes("http://127.0.0.1:62010/mcp")));
  assert.match(fs.readFileSync(path.join(env.home, ".codex", "AGENTS.md"), "utf8"), /request_author_decision/u);
  assert.ok(!maskedAgentTemplate(config).includes("token-one"));
  config.server.port = 62011;
  updateClientEndpoint("codex", config, { home: env.home }); updateClientEndpoint("claude", config, { home: env.home }); updateClientEndpoint("opencode", config, { home: env.home });
  assert.match(fs.readFileSync(path.join(env.home, ".codex", "config.toml"), "utf8"), /62011/u);
});

test("OpenCode V2 JSONC comments survive configuration", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const root = path.join(env.home, ".config", "opencode"); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "opencode.jsonc"); fs.writeFileSync(file, `{\n  // author config\n  "model": "provider/model",\n}\n`);
  configureClient("opencode", newConfig({ port: 62012 }), "private-token", { home: env.home });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\/\/ author config/u);
  assert.match(text, /"servers"/u);
  assert.match(text, /"oauth": false/u);
});

test("destructive cleanup deletes only validated legacy paths and removes legacy hooks", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const old = path.join(env.home, ".codex", "weixin-notifier"); fs.mkdirSync(old, { recursive: true });
  const attachmentDir = path.join(env.home, "codex", "task7"); fs.mkdirSync(path.join(attachmentDir, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(attachmentDir, "inbox", "old.txt"), "old");
  fs.writeFileSync(path.join(old, "tasks.json"), JSON.stringify({ tasks: { 7: { dataDir: attachmentDir } } }));
  const configPath = path.join(env.home, ".codex", "config.toml"); fs.writeFileSync(configPath, `model = "x"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "node /x/codex-finish-hook.mjs"\n\n[mcp_servers.keep]\nurl = "http://127.0.0.1:1"\n`);
  const result = destructiveLegacyCleanup({ home: env.home, tmpRoot: path.join(env.root, "tmp"), stopTmux: false });
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(attachmentDir), false);
  assert.equal(result.hooksRemoved, true);
  const remaining = fs.readFileSync(configPath, "utf8");
  assert.ok(!remaining.includes("codex-finish-hook"));
  assert.ok(remaining.includes("mcp_servers.keep"));
});

test("legacy tmux matching is anchored to old CATM names", () => {
  assert.equal(isLegacyTmuxName("codex-wx-router"), true);
  assert.equal(isLegacyTmuxName("codex-wx-task-12"), true);
  assert.equal(isLegacyTmuxName("codex-fs-a1b2-task-4"), true);
  assert.equal(isLegacyTmuxName("codex-wx-hook-123-456"), true);
  assert.equal(isLegacyTmuxName("my-codex-wx-task-12"), false);
  assert.equal(isLegacyTmuxName("codex-wx-task-project"), false);
});
