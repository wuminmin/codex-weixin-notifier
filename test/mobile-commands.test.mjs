import assert from "node:assert/strict";
import test from "node:test";
import { TenantStore } from "../scripts/lib/tenant-store.mjs";
import { createMobileCommandRouter, parseCommand } from "../scripts/lib/mobile-commands.mjs";
import { tempEnvironment } from "./helpers.mjs";

test("mobile router uses only English control phrases and scopes selection by conversation", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const session = await store.syncSession({ agent: "codex", workspace: "/work", label: "Build", status: "working", stage: "Coding", acknowledged_instruction_ids: [] });
  const binding = await store.createBindingCode();
  const route = createMobileCommandRouter({ store });
  const source = { channel: "weixin", senderId: "author", conversationId: "dm" };
  assert.equal(await route({ ...source, text: "sessions" }), 'Author not bound. Use "bind <code>".');
  assert.match(await route({ ...source, text: `BIND ${binding.code}` }), /Author bound/u);
  assert.match(await route({ ...source, text: "SeSsIoNs" }), new RegExp(session.session_id));
  assert.equal(await route({ ...source, text: "任务" }), 'No session selected. Use "sessions" and "use S12".');
  assert.equal(parseCommand("任务"), null);
  assert.equal(await route({ ...source, text: `use ${session.session_id}` }), `Selected ${session.session_id}.`);
  assert.match(await route({ ...source, text: "请继续实现测试" }), /queued/u);
  assert.equal(store.inbox(session.session_id)[0].text, "请继续实现测试");
});

test("closed sessions reject new instructions", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  const session = await store.syncSession({ agent: "codex", workspace: "/work", label: "Build", status: "working", stage: "Coding", acknowledged_instruction_ids: [] });
  await store.closeSession(session.session_id);
  await assert.rejects(store.enqueueInstruction(session.session_id, "late"), /not found/u);
});
