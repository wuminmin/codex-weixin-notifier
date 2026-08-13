import assert from "node:assert/strict";
import test from "node:test";
import { TenantStore } from "../scripts/lib/tenant-store.mjs";
import { tempEnvironment } from "./helpers.mjs";

async function sync(store, overrides = {}) {
  return store.syncSession({ agent: "codex", workspace: "/work", label: "Build", status: "working", stage: "Coding", ...overrides });
}

test("sessions are independent and completion rotates work cycles", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const a = await sync(store);
  const b = await sync(store, { agent: "claude", label: "Review" });
  assert.notEqual(a.session_id, b.session_id);
  assert.deepEqual(Object.keys(a).sort(), ["session_id", "status", "work_cycle_id"]);

  const completion = await store.completeWork({ session_id: a.session_id, work_cycle_id: "W1", summary: "done" });
  assert.equal(store.getSession(a.session_id).status, "idle");
  assert.equal((await store.completeWork({ session_id: a.session_id, work_cycle_id: "W1", summary: "done" })).deduplicated, true);
  const next = await sync(store, { session_id: a.session_id });
  assert.equal(next.work_cycle_id, "W2");
  assert.equal(completion.workCycleId, "W1");
});

test("legacy pending decisions do not affect notification-only session sync or completion", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const session = await sync(store);
  await store.createDecision({ session_id: session.session_id, question: "Legacy", idempotency_key: "legacy" });

  const synced = await sync(store, { session_id: session.session_id });
  assert.equal(synced.status, "working");
  await store.completeWork({ session_id: session.session_id, work_cycle_id: session.work_cycle_id, summary: "done" });
  assert.equal(store.getSession(session.session_id).status, "idle");
});

test("different tenant stores cannot resolve each other's identifiers", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const first = new TenantStore({ paths: env.paths, tenantId: "default" });
  const second = new TenantStore({ paths: env.paths, tenantId: "other" });
  const session = await sync(first);
  assert.throws(() => second.getSession(session.session_id), /not found/u);
});
