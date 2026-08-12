import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { connect, endpoint, initialize, rotateToken } from "../scripts/catm.mjs";
import { hashToken } from "../scripts/lib/catm-config.mjs";
import { tempEnvironment } from "./helpers.mjs";

test("init creates a fresh NAS config and prints a token only through the return boundary", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const result = await initialize({ "public-url": "https://catm.example.ts.net/mcp" }, { paths: env.paths });
  const disk = fs.readFileSync(env.paths.configPath, "utf8");
  assert.equal(result.config.version, 2);
  assert.ok(result.token.length >= 40);
  assert.ok(!disk.includes(result.token));
  assert.ok(disk.includes(hashToken(result.token)));
  await assert.rejects(initialize({ "public-url": "https://catm.example.ts.net/mcp" }, { paths: env.paths }), /already initialized/u);
});

test("connect verifies before writing and configures every selected client", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  let verified = false;
  const result = await connect({ url: "https://catm.example.ts.net/mcp", agents: "all" }, {
    paths: env.paths,
    home: env.home,
    token: "shared-token",
    verifyRemote: async (url, token) => { verified = url.endsWith("/mcp") && token === "shared-token"; },
  });
  assert.equal(verified, true);
  assert.deepEqual(result.types, ["codex", "claude", "opencode"]);
  assert.ok(fs.readFileSync(path.join(env.home, ".codex", "config.toml"), "utf8").includes("shared-token"));
});

test("token rotation invalidates the previous shared token hash", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const initialized = await initialize({ "public-url": "https://catm.example.ts.net/mcp" }, { paths: env.paths });
  const rotated = rotateToken({ paths: env.paths });
  const disk = fs.readFileSync(env.paths.configPath, "utf8");
  assert.ok(!disk.includes(hashToken(initialized.token)));
  assert.ok(disk.includes(hashToken(rotated.token)));
});

test("endpoint commands add, list, and remove a public MCP URL", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  await initialize({ "public-url": "https://catm.example.ts.net/mcp" }, { paths: env.paths });
  const added = endpoint("add", { url: "https://mcp.sessionbound.org/mcp" }, { paths: env.paths });
  assert.equal(added.changed, true);
  assert.deepEqual(endpoint("list", {}, { paths: env.paths }), ["https://catm.example.ts.net/mcp", "https://mcp.sessionbound.org/mcp"]);
  const removed = endpoint("remove", { url: "https://mcp.sessionbound.org/mcp" }, { paths: env.paths });
  assert.equal(removed.changed, true);
});
