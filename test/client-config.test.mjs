import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { configureClient, disconnectClient } from "../scripts/lib/client-config.mjs";
import { tempEnvironment } from "./helpers.mjs";

const URL = "https://catm.example.ts.net/mcp";

test("all clients share one remote URL and notification-only instructions", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  for (const type of ["codex", "claude", "opencode"]) configureClient(type, URL, "shared-token", { home: env.home });
  const codex = fs.readFileSync(path.join(env.home, ".codex", "config.toml"), "utf8");
  const claude = JSON.parse(fs.readFileSync(path.join(env.home, ".claude.json"), "utf8"));
  const opencode = JSON.parse(fs.readFileSync(path.join(env.home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.match(codex, /tool_timeout_sec = 60/u);
  assert.equal(claude.mcpServers.catm.timeout, 60_000);
  assert.equal(opencode.mcp.servers.catm.timeout.execution, 60_000);
  assert.ok([codex, JSON.stringify(claude), JSON.stringify(opencode)].every((text) => text.includes(URL) && text.includes("shared-token")));
  const prompt = fs.readFileSync(path.join(env.home, ".claude", "CLAUDE.md"), "utf8");
  assert.match(prompt, /CATM is notification-only/u);
  assert.doesNotMatch(prompt, /request_author_decision|wait_author_decision/u);
  assert.match(prompt, /notify_author/u);
  assert.match(prompt, /any number of times/u);
  assert.doesNotMatch(prompt, /exactly once/u);
  assert.match(prompt, /exact complete user-visible final response/u);
  assert.match(prompt, /same response to the user without edits/u);
});

test("disconnect removes only CATM-managed config and prompts", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  fs.mkdirSync(path.join(env.home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(env.home, ".codex", "config.toml"), '[mcp_servers.keep]\nurl = "https://keep.example/mcp"\n');
  for (const type of ["codex", "claude", "opencode"]) configureClient(type, URL, "shared-token", { home: env.home });
  for (const type of ["codex", "claude", "opencode"]) disconnectClient(type, { home: env.home });
  const codex = fs.readFileSync(path.join(env.home, ".codex", "config.toml"), "utf8");
  const claude = JSON.parse(fs.readFileSync(path.join(env.home, ".claude.json"), "utf8"));
  const opencode = JSON.parse(fs.readFileSync(path.join(env.home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.match(codex, /mcp_servers\.keep/u);
  assert.doesNotMatch(codex, /mcp_servers\.catm/u);
  assert.equal(claude.mcpServers.catm, undefined);
  assert.equal(opencode.mcp?.servers?.catm, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(env.home, ".codex", "AGENTS.md"), "utf8"), /CATM-2\.0/u);
});

test("OpenCode JSONC comments survive connect and disconnect", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const root = path.join(env.home, ".config", "opencode"); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "opencode.jsonc"); fs.writeFileSync(file, '{\n  // author config\n  "model": "provider/model",\n}\n');
  configureClient("opencode", URL, "shared-token", { home: env.home });
  disconnectClient("opencode", { home: env.home });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\/\/ author config/u);
  assert.doesNotMatch(text, /"catm"/u);
});
