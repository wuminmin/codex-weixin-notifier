import assert from "node:assert/strict";
import test from "node:test";
import { DecisionWaitRegistry } from "../scripts/lib/decision-waits.mjs";
import { TenantStore } from "../scripts/lib/tenant-store.mjs";
import { createMobileCommandRouter, parseCommand } from "../scripts/lib/mobile-commands.mjs";
import { tempEnvironment } from "./helpers.mjs";

async function boundRouter(env) {
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const session = await store.syncSession({ agent: "claude", workspace: "/work", label: "Build", status: "working", stage: "Coding", acknowledged_instruction_ids: [] });
  await store.bindAuthor({ channel: "weixin", senderId: "author", conversationId: "dm" });
  const waitRegistry = new DecisionWaitRegistry();
  return { store, session, waitRegistry, route: createMobileCommandRouter({ store, waitRegistry }) };
}

test("direct text answers the latest decision delivered to that conversation", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const { store, session, route } = await boundRouter(env);
  const decision = await store.createDecision({ session_id: session.session_id, question: "Continue?", idempotency_key: "one" });
  await store.recordDecisionDelivery(decision.decisionId, [{ ok: true, channel: "weixin", conversationId: "dm" }]);
  assert.equal(parseCommand("继续"), null);
  const result = await route({ channel: "weixin", senderId: "author", conversationId: "dm", text: "继续" });
  assert.match(result, /Decision 001 recorded/u);
  assert.match(result, /No active Claude wait/u);
  assert.equal(store.getDecision(decision.decisionId).answer.text, "继续");
});

test("explicit decide remains a fallback and invalid closed choices stay pending", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const { store, session, route } = await boundRouter(env);
  const source = { channel: "weixin", senderId: "author", conversationId: "dm" };
  const decision = await store.createDecision({
    session_id: session.session_id, question: "Choose", idempotency_key: "choice", allow_free_text: false,
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  });
  await assert.rejects(route({ ...source, text: `decide ${decision.shortCode} invalid` }), /must select/u);
  assert.equal(store.getDecision(decision.decisionId).status, "pending");
  assert.match(await route({ ...source, text: `decide ${decision.shortCode} 2` }), /recorded/u);
  assert.equal(store.getDecision(decision.decisionId).answer.optionId, "b");
});

test("with multiple pending decisions direct text answers the most recently delivered one", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const { store, session, route } = await boundRouter(env);
  const source = { channel: "weixin", senderId: "author", conversationId: "dm" };
  const older = await store.createDecision({ session_id: session.session_id, question: "Older?", idempotency_key: "older" });
  await store.recordDecisionDelivery(older.decisionId, [{ ok: true, channel: "weixin", conversationId: "dm" }]);
  const latest = await store.createDecision({ session_id: session.session_id, question: "Latest?", idempotency_key: "latest" });
  await store.recordDecisionDelivery(latest.decisionId, [{ ok: true, channel: "weixin", conversationId: "dm" }]);
  const reply = await route({ ...source, text: "latest answer" });
  assert.match(reply, new RegExp(`Decision ${latest.shortCode} recorded`, "u"));
  assert.equal(store.getDecision(latest.decisionId).status, "answered");
  assert.equal(store.getDecision(older.decisionId).status, "pending");
  assert.match(await route({ ...source, text: `decide ${older.shortCode} older answer` }), new RegExp(`Decision ${older.shortCode} recorded`, "u"));
});

test("decision context is isolated by channel conversation before remote instructions", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const { store, session, route } = await boundRouter(env);
  await store.bindAuthor({ channel: "weixin", senderId: "other", conversationId: "other-dm" });
  const decision = await store.createDecision({ session_id: session.session_id, question: "Continue?", idempotency_key: "isolated" });
  await store.recordDecisionDelivery(decision.decisionId, [{ ok: true, channel: "weixin", conversationId: "dm" }]);
  assert.equal(await route({ channel: "weixin", senderId: "other", conversationId: "other-dm", text: "继续" }), 'No decision or session selected. Use "sessions" and "use S12".');
  assert.equal(store.getDecision(decision.decisionId).status, "pending");
  assert.match(await route({ channel: "weixin", senderId: "other", conversationId: "other-dm", text: `use ${session.session_id}` }), /Selected/u);
  assert.match(await route({ channel: "weixin", senderId: "other", conversationId: "other-dm", text: "普通指令" }), /queued/u);
  assert.equal(store.inbox(session.session_id)[0].text, "普通指令");
});

test("removed local-management commands are no longer recognized", () => {
  for (const command of ["new", "snap S1", "active", "current", "inbox S1", "decisions S1"]) assert.equal(parseCommand(command), null);
});
