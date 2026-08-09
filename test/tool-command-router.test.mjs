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

test("agent doctor remains available while phone sessions replace tool slots", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tool-control-"));
  const config = {
    ...runtime(home),
    dryRun: true,
    codexCommand: "missing-codex",
    claudeCommand: "missing-claude",
    opencodeCommand: "missing-opencode",
  };
  const doctor = await withRuntimeConfig(config, () => taskCoreForTests.handleText("tool doctor", "chat-a", config));
  assert.match(doctor, /Codex: missing/u);
  assert.match(doctor, /Claude Code: missing/u);
  assert.match(doctor, /Router: ready/u);
  const selected = await withRuntimeConfig(config, () => taskCoreForTests.handleText("新会话 claude", "chat-a", config));
  assert.match(selected, /Claude Code 会话 · 将启动/u);
});

test("new Claude and opencode sessions do not create numbered Codex tasks", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tool-router-"));
  const config = runtime(home);
  await withRuntimeConfig(config, async () => {
    const claude = await taskCoreForTests.handleText("新会话 claude", "chat-a", config);
    const opencode = await taskCoreForTests.handleText("新会话 opencode", "chat-a", config);
    const followup = await taskCoreForTests.handleText("继续", "chat-a", config);

    assert.match(claude, /Claude Code 会话 · 将启动/u);
    assert.match(opencode, /opencode 会话 · 将启动/u);
    assert.match(followup, /opencode 会话 · 将发送/u);
  });

  assert.equal(fs.existsSync(path.join(home, "state", "tasks.json")), false);

  const backToLegacy = await withRuntimeConfig(config, () => taskCoreForTests.handleText("task 0", "chat-a", config));
  assert.match(backToLegacy, /编号 task 模式已停用/u);
});
