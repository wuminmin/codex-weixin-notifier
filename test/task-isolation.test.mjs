import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeConfigForBot } from "../scripts/lib/notifier-config.mjs";
import { taskCoreForTests, withRuntimeConfig } from "../scripts/weixin-command-router.mjs";

function runtime(home, account, bot) {
  return {
    ...runtimeConfigForBot({
      channel: "feishu",
      account,
      bot,
      codexCwd: home,
      runner: "spawn",
      dryRun: true,
      notifierHome: home,
    }, { home }),
    dryRun: true,
  };
}

test("same conversation, task id, and chat id do not cross bot state or tmux sessions", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notifier-tasks-"));
  const configs = [runtime(home, "a", "one"), runtime(home, "a", "two"), runtime(home, "b", "one")];
  const sessions = [];
  for (const [index, config] of configs.entries()) {
    await withRuntimeConfig(config, async () => {
      taskCoreForTests.saveTasks(taskCoreForTests.loadTasks());
      const response = taskCoreForTests.enterTask("1", "oc_same_chat");
      assert.match(response, /已创建并进入/u);
      taskCoreForTests.setCurrentTask("oc_other_chat", "0");
      const task = taskCoreForTests.getCurrentTask("oc_same_chat");
      assert.equal(task.id, "1");
      taskCoreForTests.saveTasks({
        ...taskCoreForTests.loadTasks(),
        marker: index,
      });
      sessions.push(taskCoreForTests.makeTmuxSessionName(task));
    });
  }
  assert.equal(new Set(sessions).size, 3);
  assert.equal(new Set(configs.map((item) => item.stateDir)).size, 3);
  for (const config of configs) {
    assert.equal(fs.existsSync(path.join(config.stateDir, "tasks.json")), true);
    assert.equal(fs.existsSync(path.join(config.taskRoot, "task1")), true);
  }
});

test("current task is isolated by conversation within one bot", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notifier-conversations-"));
  const config = runtime(home, "a", "one");
  await withRuntimeConfig(config, async () => {
    taskCoreForTests.saveTasks(taskCoreForTests.loadTasks());
    taskCoreForTests.enterTask("1", "oc_chat_a");
    assert.equal(taskCoreForTests.getCurrentTask("oc_chat_a").id, "1");
    assert.equal(taskCoreForTests.getCurrentTask("oc_chat_b").id, "0");
  });
});

test("queued task completion reply context remains serializable and conversation-scoped", () => {
  const context = taskCoreForTests.serializableReplyContext({
    chatId: "oc_chat",
    feishuReplyTo: "om_message",
    feishuReplyInThread: true,
    feishuChannel: { shouldNotPersist: true },
  });
  assert.deepEqual(context, {
    toUser: "",
    contextToken: "",
    chatId: "oc_chat",
    replyTo: "om_message",
    replyInThread: true,
  });
  assert.doesNotThrow(() => JSON.stringify(context));
  const config = taskCoreForTests.configWithReplyContext({ channel: "feishu", account: "a", bot: "one" }, context);
  assert.equal(config.toChat, "oc_chat");
  assert.equal(config.feishuReplyTo, "om_message");
  assert.equal(config.feishuReplyInThread, true);
});

test("chat help and onboard commands describe the current Lark bot", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notifier-help-"));
  const config = runtime(home, "global", "main");
  config.platform = "lark";
  config.configPath = path.join(home, ".codex", "codex-notifier.json");
  await withRuntimeConfig(config, async () => {
    const help = await taskCoreForTests.handleText("help", "oc_chat", config);
    assert.match(help, /Lark 国际版/u);
    assert.match(help, /list/u);
    assert.match(help, /node scripts\/onboard\.mjs/u);
    const onboard = await taskCoreForTests.handleText("onboard", "oc_chat", config);
    assert.match(onboard, /--channel feishu --platform lark/u);
    assert.match(onboard, /global/u);
  });
});
