import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withRuntimeConfig, taskCoreForTests } from "../scripts/weixin-command-router.mjs";
import { parseSessionCommand } from "../scripts/session-router.mjs";

function runtime(home) {
  return {
    channel: "weixin",
    account: "default",
    bot: "default",
    namespace: "weixin/default/default",
    stateDir: path.join(home, "state"),
    codexCwd: home,
    runner: "interactive",
    dryRun: true,
  };
}

test("phone session commands parse for history, takeover, and new tools", () => {
  assert.deepEqual(parseSessionCommand("历史"), { type: "list" });
  assert.deepEqual(parseSessionCommand("接管 2"), { type: "takeover", index: 2 });
  assert.deepEqual(parseSessionCommand("当前会话"), { type: "current" });
  assert.deepEqual(parseSessionCommand("退出接管"), { type: "off" });
  assert.deepEqual(parseSessionCommand("新会话"), { type: "new", runner: "codex" });
  assert.deepEqual(parseSessionCommand("新会话 opencode"), { type: "new", runner: "opencode" });
});

test("new phone sessions are isolated by chat and do not create numbered tasks", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-phone-sessions-"));
  const config = runtime(home);
  await withRuntimeConfig(config, async () => {
    const first = await taskCoreForTests.handleText("新会话", "chat-a", config);
    const second = await taskCoreForTests.handleText("新会话 opencode", "chat-b", config);
    assert.match(first, /Codex 会话 · 将启动/u);
    assert.match(second, /opencode 会话 · 将启动/u);

    const currentA = await taskCoreForTests.handleText("当前会话", "chat-a", config);
    const currentB = await taskCoreForTests.handleText("当前会话", "chat-b", config);
    assert.match(currentA, /当前会话：Codex/u);
    assert.match(currentB, /当前会话：opencode/u);
    assert.equal(fs.existsSync(path.join(home, "state", "tasks.json")), false);
  });
});
