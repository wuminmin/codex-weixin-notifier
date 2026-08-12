import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAccessToken, newConfig } from "../scripts/lib/catm-config.mjs";
import { startDaemon } from "../scripts/catm-daemon.mjs";
import { createMobileCommandRouter } from "../scripts/lib/mobile-commands.mjs";
import { TenantStore } from "../scripts/lib/tenant-store.mjs";
import { tempEnvironment } from "./helpers.mjs";

async function connect(url, token, name) {
  const client = new Client({ name, version: "2" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

async function eventually(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rawPost(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

test("NAS daemon secures HTTP and resumes an active Claude wait from a direct phone reply", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const config = newConfig({ publicUrl: "https://catm.example.ts.net/mcp" });
  config.server.publicUrls.push("https://mcp.sessionbound.org/mcp");
  const token = createAccessToken(config).token;
  const notices = [];
  const daemon = await startDaemon({
    config, paths: env.paths, listenHost: "127.0.0.1", listenPort: 0, channels: false,
    waitHeartbeatMs: 25, waitPollMs: 10,
    notifier: async (_tenant, text) => {
      notices.push(text);
      return [{ ok: true, label: "weixin/default/author", channel: "weixin", conversationId: "dm", messageId: "m1" }];
    },
  });
  const base = `http://127.0.0.1:${daemon.port}`;
  const healthResponse = await fetch(`${base}/health`);
  assert.equal(healthResponse.headers.get("cache-control"), "no-store");
  const health = await healthResponse.json();
  assert.deepEqual(health, { status: "ready", version: "2.0.0" });
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.notEqual((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://mcp.sessionbound.org", host: "mcp.sessionbound.org", "content-type": "application/json" }, body: "{}" })).status, 403);
  const publicFailure = (address) => rawPost(`${base}/mcp`, {
    authorization: "Bearer invalid", host: "mcp.sessionbound.org", "cf-connecting-ip": address, "content-type": "application/json",
  });
  for (let index = 0; index < 20; index += 1) assert.equal(await publicFailure("203.0.113.10"), 401);
  assert.equal(await publicFailure("203.0.113.10"), 429);
  assert.equal(await publicFailure("203.0.113.11"), 401);

  const clients = await Promise.all(["claude", "codex", "opencode"].map((name) => connect(`${base}/mcp`, token, name)));
  t.after(async () => { await Promise.allSettled(clients.map((client) => client.close())); await daemon.close(); });
  const tools = await clients[0].listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["notify_work_completed", "request_author_decision", "sync_session", "wait_author_decision"]);

  const sessions = await Promise.all(clients.map((client, index) => client.callTool({ name: "sync_session", arguments: {
    agent: ["claude", "codex", "opencode"][index], workspace: `/work/${index}`, label: `Session ${index}`, status: "working", stage: "Started", acknowledged_instruction_ids: [],
  } })));
  assert.equal(new Set(sessions.map((item) => item.structuredContent.session_id)).size, 3);
  assert.ok(sessions.every((item) => !("tenant_id" in item.structuredContent)));

  const session = sessions[0].structuredContent;
  const requested = await clients[0].callTool({ name: "request_author_decision", arguments: {
    session_id: session.session_id, question: "Continue?", idempotency_key: "continue-1",
  } });
  assert.match(notices[0], /Reply with the answer directly/u);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  await store.bindAuthor({ channel: "weixin", senderId: "author", conversationId: "dm" });
  const route = createMobileCommandRouter({ store, waitRegistry: daemon.waitRegistry });
  const waiting = clients[0].callTool({ name: "wait_author_decision", arguments: { decision_id: requested.structuredContent.decision_id, timeout_seconds: 10 } });
  await eventually(() => daemon.waitRegistry.isActive("default", requested.structuredContent.decision_id));
  const reply = await route({ text: "继续", channel: "weixin", senderId: "author", conversationId: "dm" });
  assert.match(reply, /Claude wait is active/u);
  const waited = await waiting;
  assert.equal(waited.structuredContent.wait_status, "answered");
  assert.equal(waited.structuredContent.answer.text, "继续");

  const inactive = await clients[0].callTool({ name: "request_author_decision", arguments: {
    session_id: session.session_id, question: "Choose", idempotency_key: "continue-2", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  } });
  const inactiveReply = await route({ text: "1", channel: "weixin", senderId: "author", conversationId: "dm" });
  assert.match(inactiveReply, /No active Claude wait/u);
  assert.equal(store.getDecision(inactive.structuredContent.decision_id).answer.optionId, "a");
  await clients[0].callTool({ name: "notify_work_completed", arguments: { session_id: session.session_id, work_cycle_id: session.work_cycle_id, summary: "Done", verification: "Passed" } });
  assert.match(notices.at(-1), /Agent: claude · Session: S1 · Work cycle: W1/u);
  assert.match(notices.at(-1), /Workspace: \/work\/0/u);
  assert.ok(notices.at(-1).endsWith("Done"));
  assert.doesNotMatch(notices.at(-1), /Passed|Verification:/u);
  const duplicate = await clients[0].callTool({ name: "notify_work_completed", arguments: { session_id: session.session_id, work_cycle_id: session.work_cycle_id, summary: "Done", verification: "Passed" } });
  assert.equal(duplicate.structuredContent.delivery_status, "deduplicated");
  assert.ok(!JSON.stringify(duplicate.structuredContent).includes("tenant"));
});

test("wait heartbeat keeps the call alive and timeout remains pending", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const config = newConfig({ publicUrl: "https://catm.example.ts.net/mcp" });
  const token = createAccessToken(config).token;
  const daemon = await startDaemon({ config, paths: env.paths, listenHost: "127.0.0.1", listenPort: 0, channels: false, waitHeartbeatMs: 25, waitPollMs: 10, notifier: async () => [{ ok: true, label: "test" }] });
  const client = await connect(`http://127.0.0.1:${daemon.port}/mcp`, token, "heartbeat");
  t.after(async () => { await client.close(); await daemon.close(); });
  let heartbeats = 0;
  client.setNotificationHandler(LoggingMessageNotificationSchema, () => { heartbeats += 1; });
  const session = (await client.callTool({ name: "sync_session", arguments: { agent: "claude", workspace: "/work", label: "Wait", status: "working", stage: "Start", acknowledged_instruction_ids: [] } })).structuredContent;
  const decision = (await client.callTool({ name: "request_author_decision", arguments: { session_id: session.session_id, question: "Wait", idempotency_key: "heartbeat" } })).structuredContent;
  const waited = await client.callTool({ name: "wait_author_decision", arguments: { decision_id: decision.decision_id, timeout_seconds: 1 } });
  assert.equal(waited.structuredContent.wait_status, "pending");
  assert.ok(heartbeats > 0);
  assert.equal(new TenantStore({ paths: env.paths, tenantId: "default" }).getDecision(decision.decision_id).status, "pending");
});
