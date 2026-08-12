import assert from "node:assert/strict";
import test from "node:test";
import { DecisionWaitRegistry } from "../scripts/lib/decision-waits.mjs";

test("decision wait registry signals active waits and unregisters cleanly", async () => {
  const registry = new DecisionWaitRegistry();
  const registration = registry.register("default", "D1");
  const waiting = registration.wait(1000);
  assert.equal(registry.isActive("default", "D1"), true);
  assert.equal(registry.signal("default", "D1"), 1);
  assert.equal(await waiting, "signalled");
  registration.close();
  assert.equal(registry.isActive("default", "D1"), false);
});

test("decision wait registry responds to client cancellation", async () => {
  const registry = new DecisionWaitRegistry();
  const registration = registry.register("default", "D2");
  const controller = new AbortController();
  const waiting = registration.wait(1000, controller.signal);
  controller.abort();
  assert.equal(await waiting, "cancelled");
  registration.close();
  assert.equal(registry.signal("default", "D2"), 0);
});
