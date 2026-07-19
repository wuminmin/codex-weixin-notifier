import assert from "node:assert/strict";
import test from "node:test";
import { fanOutNotification, notificationTargets } from "../scripts/notify.mjs";

const loaded = {
  home: "/tmp",
  configPath: "/tmp/config.json",
  sourceFormat: "general",
  config: {
    defaults: { renderMarkdownImages: false },
    channels: {
      weixin: { accounts: { default: { bots: { default: { token: "t", toUser: "u" } } } } },
      feishu: {
        accounts: {
          a: { bots: {
            one: { appId: "cli_one", appSecret: "s", notifyTargets: [
              { id: "ops", chatId: "oc_ops", enabled: true },
              { id: "off", chatId: "oc_off", enabled: false },
            ] },
            two: { appId: "cli_two", appSecret: "s", notifyTargets: [{ id: "dev", chatId: "oc_dev" }] },
          } },
        },
      },
    },
  },
};

test("notification target selection honors all selectors", () => {
  assert.equal(notificationTargets(loaded).length, 3);
  assert.deepEqual(notificationTargets(loaded, { channel: "feishu", account: "a", bot: "one" }).map((item) => item.target.id), ["ops"]);
  assert.deepEqual(notificationTargets(loaded, { target: "oc_dev" }).map((item) => item.target.id), ["dev"]);
});

test("fan-out is best effort and reports partial failure", async () => {
  const targets = notificationTargets(loaded);
  const sent = [];
  const results = await fanOutNotification({ sessionId: "s" }, targets, {
    sendWeixin: async (_event, config) => sent.push(`wx:${config.target.id}`),
    sendFeishu: async (_event, config) => {
      sent.push(`fs:${config.target.id}`);
      if (config.target.id === "ops") throw new Error("permission denied");
    },
  });
  assert.equal(sent.length, 3);
  assert.equal(results.filter((item) => item.ok).length, 2);
  assert.equal(results.filter((item) => !item.ok)[0].label, "feishu/a/one/ops");
});
