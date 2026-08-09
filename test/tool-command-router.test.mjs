import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withRuntimeConfig, taskCoreForTests } from "../scripts/weixin-command-router.mjs";
import { toolRouterForTests } from "../scripts/tool-command-router.mjs";

function runtime(home) {
  return {
    channel: "weixin",
    account: "default",
    bot: "default",
    namespace: "weixin/default/default",
    stateDir: path.join(home, "state"),
    taskRoot: path.join(home, "tasks"),
    codexCwd: home,
    dryRun: true,
  };
}

test("tool commands parse into isolated runner sessions", () => {
  assert.deepEqual(toolRouterForTests.parseToolCommand("claude 1 review this"), {
    type: "select", runner: "claude", target: "1", text: "review this",
  });
  assert.deepEqual(toolRouterForTests.parseToolCommand("opencode 2"), {
    type: "select", runner: "opencode", target: "2", text: "",
  });
  assert.deepEqual(toolRouterForTests.parseToolCommand("tool close claude 1"), {
    type: "close", runner: "claude", target: "1",
  });
  assert.deepEqual(toolRouterForTests.parseToolCommand("工具退出"), { type: "off" });
});

test("Claude and opencode tool tasks do not create or reuse Codex tasks", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tool-router-"));
  const config = runtime(home);
  await withRuntimeConfig(config, async () => {
    const claude = await taskCoreForTests.handleText("claude 1 review", "chat-a", config);
    const opencode = await taskCoreForTests.handleText("opencode 1 inspect", "chat-a", config);
    const followup = await taskCoreForTests.handleText("继续", "chat-a", config);

    assert.match(claude, /tool claude 1 · 将发送/u);
    assert.match(opencode, /tool opencode 1 · 将发送/u);
    assert.match(followup, /tool opencode 1 · 将发送/u);
  });

  const toolState = JSON.parse(fs.readFileSync(path.join(home, "state", "tool-tasks.json"), "utf8"));
  assert.deepEqual(Object.keys(toolState.tasks).sort(), ["claude:1", "opencode:1"]);
  assert.equal(fs.existsSync(path.join(home, "state", "tasks.json")), false);

  const backToCodex = await withRuntimeConfig(config, () => taskCoreForTests.handleText("task 0", "chat-a", config));
  assert.match(backToCodex, /task 0/u);
});
