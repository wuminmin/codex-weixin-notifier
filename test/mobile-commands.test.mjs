import assert from "node:assert/strict";
import test from "node:test";
import { TenantStore } from "../scripts/lib/tenant-store.mjs";
import { createMobileCommandRouter, parseCommand } from "../scripts/lib/mobile-commands.mjs";
import { tempEnvironment } from "./helpers.mjs";

test("only bind is recognized as an inbound phone command", () => {
  assert.deepEqual(parseCommand("bind ABC123"), { command: "bind", rest: "ABC123" });
  for (const text of ["decide 002 已阅", "sessions", "status", "help", "普通指令"]) {
    assert.equal(parseCommand(text), null);
  }
});

test("bound phone text is silently ignored and never changes a pending decision", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const session = await store.syncSession({ agent: "claude", workspace: "/work", label: "Build", status: "working", stage: "Coding" });
  await store.bindAuthor({ channel: "weixin", senderId: "author", conversationId: "dm" });
  const decision = await store.createDecision({ session_id: session.session_id, question: "Legacy pending decision", idempotency_key: "legacy" });
  const route = createMobileCommandRouter({ store });

  assert.equal(await route({ channel: "weixin", senderId: "author", conversationId: "dm", text: "decide 002 已阅" }), null);
  assert.equal(await route({ channel: "weixin", senderId: "author", conversationId: "dm", text: "普通指令" }), null);
  assert.equal(store.getDecision(decision.decisionId).status, "pending");
  assert.deepEqual(store.inbox(session.session_id), []);
});

test("bind remains available to establish the notification target", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const binding = await store.createBindingCode();
  const route = createMobileCommandRouter({ store });
  const result = await route({ channel: "weixin", senderId: "author", conversationId: "dm", text: `bind ${binding.code}` });

  assert.match(result, /send notifications/u);
  assert.ok(store.authorBinding("weixin", "author"));
});
