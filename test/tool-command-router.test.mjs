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
  assert.deepEqual(toolRouterForTests.parseToolCommand("tool use claude"), {
    type: "select", runner: "claude", target: "", text: "", deferred: true,
  });
  assert.deepEqual(toolRouterForTests.parseToolCommand("工具 使用 opencode 2"), {
    type: "select", runner: "opencode", target: "2", text: "", deferred: true,
  });
  assert.deepEqual(toolRouterForTests.parseToolCommand("tool doctor"), { type: "doctor" });
  assert.deepEqual(toolRouterForTests.parseToolCommand("工具退出"), { type: "off" });
});

test("agent selection is lazy and doctor works without installed agents", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tool-control-"));
  const config = {
    ...runtime(home),
    dryRun: true,
    codexCommand: "missing-codex",
    claudeCommand: "missing-claude",
    opencodeCommand: "missing-opencode",
  };
  const selected = await withRuntimeConfig(config, () => taskCoreForTests.handleText("tool use claude", "chat-a", config));
  assert.match(selected, /Current agent: Claude Code/u);
  assert.match(selected, /not installed/u);
  const toolState = JSON.parse(fs.readFileSync(path.join(home, "state", "tool-tasks.json"), "utf8"));
  assert.equal(toolState.tasks["claude:1"].status, "ready");
  assert.equal(toolState.tasks["claude:1"].tmuxSession, "");
  const doctor = await withRuntimeConfig(config, () => taskCoreForTests.handleText("tool doctor", "chat-a", config));
  assert.match(doctor, /Codex: missing/u);
  assert.match(doctor, /Claude Code: missing/u);
  assert.match(doctor, /Router: ready/u);
  const blocked = await withRuntimeConfig({ ...config, dryRun: false }, () => taskCoreForTests.handleText("run it", "chat-a", { ...config, dryRun: false }));
  assert.match(blocked, /任务未执行/u);
  assert.match(blocked, /not installed/u);
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
