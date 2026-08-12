import assert from "node:assert/strict";
import test from "node:test";
import { TenantStore } from "../scripts/lib/tenant-store.mjs";
import { tempEnvironment } from "./helpers.mjs";

async function sync(store, overrides = {}) {
  return store.syncSession({ agent: "codex", workspace: "/work", label: "Build", status: "working", stage: "Coding", acknowledged_instruction_ids: [], ...overrides });
}

test("sessions isolate inboxes, allow multiple decisions, and rotate work cycles", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const a = await sync(store);
  const b = await sync(store, { agent: "claude", label: "Review" });
  assert.notEqual(a.session_id, b.session_id);
  const ia = await store.enqueueInstruction(a.session_id, "first");
  const ib = await store.enqueueInstruction(b.session_id, "other");
  assert.equal(ia.sequence, 1); assert.equal(ib.sequence, 1);
  const delivered = await sync(store, { session_id: a.session_id });
  assert.deepEqual(delivered.instructions.map((x) => x.text), ["first"]);
  assert.equal((await sync(store, { session_id: b.session_id, agent: "claude", label: "Review" })).instructions[0].text, "other");
  await sync(store, { session_id: a.session_id, acknowledged_instruction_ids: [ia.instructionId] });
  assert.equal(store.inbox(a.session_id)[0].status, "acknowledged");

  const d1 = await store.createDecision({ session_id: a.session_id, question: "One?", idempotency_key: "one" });
  const d2 = await store.createDecision({ session_id: a.session_id, question: "Two?", idempotency_key: "two" });
  assert.notEqual(d1.decisionId, d2.decisionId);
  assert.equal(store.listDecisions(a.session_id).length, 2);
  assert.equal((await store.createDecision({ session_id: a.session_id, question: "retry", idempotency_key: "one" })).deduplicated, true);
  await store.answerDecision(d1.shortCode, "yes");
  assert.equal(store.listDecisions(a.session_id).length, 1);
  await store.answerDecision(d2.shortCode, "yes");

  const completion = await store.completeWork({ session_id: a.session_id, work_cycle_id: "W1", summary: "done" });
  assert.equal(store.getSession(a.session_id).status, "idle");
  assert.equal((await store.completeWork({ session_id: a.session_id, work_cycle_id: "W1", summary: "done" })).deduplicated, true);
  const next = await sync(store, { session_id: a.session_id });
  assert.equal(next.work_cycle_id, "W2");
  assert.equal(completion.workCycleId, "W1");
  await store.completeWork({ session_id: a.session_id, work_cycle_id: "W2", summary: "done again" });
  await store.enqueueInstruction(a.session_id, "new cycle");
  assert.equal((await sync(store, { session_id: a.session_id })).work_cycle_id, "W3");
});

test("different tenant stores cannot resolve each other's identifiers", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const first = new TenantStore({ paths: env.paths, tenantId: "default" });
  const second = new TenantStore({ paths: env.paths, tenantId: "other" });
  const session = await sync(first);
  assert.throws(() => second.getSession(session.session_id), /not found/u);
});

test("each new MCP conversation creates an independent session without public tenant fields", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const first = await sync(store);
  const second = await sync(store);
  assert.notEqual(first.session_id, second.session_id);
  assert.equal("tenant_id" in first, false);
  assert.equal(store.listSessions().length, 2);
});

test("closing a session cancels its pending decisions", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const session = await sync(store);
  const decision = await store.createDecision({ session_id: session.session_id, question: "Still proceed?", idempotency_key: "close" });
  await store.closeSession(session.session_id);
  assert.equal(store.getDecision(decision.decisionId).status, "cancelled");
});
