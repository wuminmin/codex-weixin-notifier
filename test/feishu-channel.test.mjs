import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFeishuChannel, LocalMessageQueue, MessageDeduplicator } from "../scripts/lib/feishu-channel.mjs";
import { startFeishuBot } from "../scripts/weixin-command-router.mjs";

class MockChannel {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.handlers = {};
    this.sent = [];
    this.connected = false;
    this.botIdentity = { name, openId: `ou_${name}` };
  }
  on(name, handler) { this.handlers[name] = handler; }
  async connect() {
    if (this.options.failConnect) throw new Error("bad credentials");
    this.connected = true;
  }
  async disconnect() { this.connected = false; }
  async send(chatId, input, options) {
    this.sent.push({ chatId, input, options });
    return { messageId: `sent-${this.sent.length}` };
  }
  async downloadResource() { return Buffer.from("resource"); }
}

test("local queue preserves order per conversation while allowing quick enqueue", async () => {
  const queue = new LocalMessageQueue();
  const order = [];
  queue.enqueue("chat", async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    order.push(1);
  });
  queue.enqueue("chat", async () => order.push(2));
  assert.deepEqual(order, []);
  await queue.drain();
  assert.deepEqual(order, [1, 2]);
});

test("message deduplicator drops repeated message ids", () => {
  const dedup = new MessageDeduplicator({ ttlMs: 1000 });
  assert.equal(dedup.accept("m1", 100), true);
  assert.equal(dedup.accept("m1", 200), false);
  assert.equal(dedup.accept("m1", 1200), true);
});

test("Channel policy accepts DMs and requires the current bot mention in groups", () => {
  let options;
  const channel = createFeishuChannel({
    account: "a",
    bot: "one",
    appId: "cli_test",
    appSecret: "secret",
    notifierHome: "/tmp",
  }, {
    sdk: {
      Domain: { Feishu: "feishu" },
      LoggerLevel: { info: "info" },
      createLarkChannel(value) { options = value; return { value }; },
    },
  });
  assert.ok(channel);
  assert.equal(options.domain, "feishu");
  assert.equal(options.policy.dmMode, "open");
  assert.equal(options.policy.requireMention, true);
  assert.equal(options.policy.respondToMentionAll, false);
  assert.equal(options.safety.chatQueue.enabled, true);
});

test("inbound duplicate is queued once and topic reply keeps message context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-inbound-"));
  const config = {
    channel: "feishu",
    account: "a",
    bot: "one",
    namespace: "feishu/a/one",
    namespaceHash: "abc123",
    tmuxPrefix: "codex-fs-abc123",
    appId: "cli_1",
    appSecret: "s",
    stateDir: path.join(root, "state"),
    taskRoot: path.join(root, "tasks"),
    codexCwd: root,
    runner: "spawn",
  };
  const channel = new MockChannel("topic-bot");
  const runtime = await startFeishuBot(config, {}, { channel });
  const message = {
    messageId: "om_once",
    chatId: "oc_topic",
    chatType: "group",
    senderId: "ou_sender",
    content: "list",
    resources: [],
    threadId: "omt_thread",
  };
  channel.handlers.message(message);
  channel.handlers.message(message);
  await runtime.queue.drain();
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].chatId, "oc_topic");
  assert.equal(channel.sent[0].options.replyTo, "om_once");
  assert.equal(channel.sent[0].options.replyInThread, true);
});

test("three bot configs create independent connections and one failure is isolated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-connections-"));
  const configs = [
    { channel: "feishu", account: "a", bot: "one", namespace: "feishu/a/one", appId: "cli_1", appSecret: "s", stateDir: path.join(root, "a1"), taskRoot: path.join(root, "a1/tasks") },
    { channel: "feishu", account: "a", bot: "two", namespace: "feishu/a/two", appId: "cli_2", appSecret: "bad", stateDir: path.join(root, "a2"), taskRoot: path.join(root, "a2/tasks") },
    { channel: "feishu", account: "b", bot: "one", namespace: "feishu/b/one", appId: "cli_3", appSecret: "s", stateDir: path.join(root, "b1"), taskRoot: path.join(root, "b1/tasks") },
  ];
  const channels = [new MockChannel("a-one"), new MockChannel("a-two", { failConnect: true }), new MockChannel("b-one")];
  const results = await Promise.allSettled(configs.map((config, index) => startFeishuBot(config, {}, { channel: channels[index] })));
  assert.deepEqual(results.map((item) => item.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(channels[0].connected, true);
  assert.equal(channels[2].connected, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configs[0].stateDir, "channel-status.json"), "utf8")).status, "connected");
  assert.equal(JSON.parse(fs.readFileSync(path.join(configs[1].stateDir, "channel-status.json"), "utf8")).status, "startup-failed");
});
