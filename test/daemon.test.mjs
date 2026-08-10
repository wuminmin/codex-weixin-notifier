import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bindAvailablePort, selectPort } from "../scripts/lib/port-selection.mjs";
import { createClientCredential, newConfig, saveConfig } from "../scripts/lib/catm-config.mjs";
import { startDaemon } from "../scripts/catm-daemon.mjs";
import { TenantStore } from "../scripts/lib/tenant-store.mjs";
import { tempEnvironment } from "./helpers.mjs";

async function connect(url, token, name) {
  const client = new Client({ name, version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

test("daemon enforces loopback HTTP security and supports three MCP clients", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const picked = await selectPort(); await new Promise((resolve) => picked.reservation.close(resolve));
  const config = newConfig({ port: picked.port });
  const credentials = Object.fromEntries(["codex", "claude", "opencode"].map((type) => [type, createClientCredential(config, type).token]));
  saveConfig(config, { paths: env.paths });
  const notices = [];
  const daemon = await startDaemon({ config, paths: env.paths, channels: false, notifier: async (_tenant, text) => { notices.push(text); return [{ ok: true, label: "test" }]; } });
  let clients = [];
  t.after(async () => { await Promise.allSettled(clients.map((client) => client.close())); await daemon.close(); });
  const base = `http://127.0.0.1:${picked.port}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(Object.keys(health).sort(), ["endpoint", "status", "version"]);
  assert.ok(!JSON.stringify(health).includes("tenant"));
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${credentials.codex}`, origin: "http://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.ok([400, 403].includes((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${credentials.codex}`, host: "evil.example", "content-type": "application/json" }, body: "{}" })).status));
  const oversized = JSON.stringify({ value: "x".repeat(300_000) });
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: oversized })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${credentials.codex}`, "content-type": "application/json" }, body: oversized })).status, 413);

  clients = await Promise.all(Object.entries(credentials).map(([type, token]) => connect(`${base}/mcp`, token, type)));
  const results = await Promise.all(clients.map((client, index) => client.callTool({ name: "sync_session", arguments: {
    agent: ["codex", "claude", "opencode"][index], workspace: `/work/${index}`, label: `Session ${index}`, status: "working", stage: "Started", acknowledged_instruction_ids: [],
  } })));
  assert.deepEqual(results.map((result) => result.structuredContent.tenant_id), ["default", "default", "default"]);
  assert.equal(new Set(results.map((result) => result.structuredContent.session_id)).size, 3);
  const tools = await clients[0].listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["notify_work_completed", "request_author_decision", "sync_session", "wait_author_decision"]);
  assert.ok(!JSON.stringify(results).includes(credentials.codex));
  const session = results[0].structuredContent;
  const firstDecision = await clients[0].callTool({ name: "request_author_decision", arguments: { session_id: session.session_id, question: "Choose one", idempotency_key: "choice-1", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } });
  const secondDecision = await clients[0].callTool({ name: "request_author_decision", arguments: { session_id: session.session_id, question: "Choose two", idempotency_key: "choice-2" } });
  assert.notEqual(firstDecision.structuredContent.decision_id, secondDecision.structuredContent.decision_id);
  const store = new TenantStore({ paths: env.paths, tenantId: "default" });
  await store.answerDecision(firstDecision.structuredContent.short_code, "1");
  await store.answerDecision(secondDecision.structuredContent.short_code, "yes");
  const waited = await clients[0].callTool({ name: "wait_author_decision", arguments: { decision_id: firstDecision.structuredContent.decision_id, timeout_seconds: 0 } });
  assert.equal(waited.structuredContent.wait_status, "answered");
  await clients[0].callTool({ name: "notify_work_completed", arguments: { session_id: session.session_id, work_cycle_id: session.work_cycle_id, summary: "Done", verification: "Tests pass" } });
  const duplicate = await clients[0].callTool({ name: "notify_work_completed", arguments: { session_id: session.session_id, work_cycle_id: session.work_cycle_id, summary: "Done", verification: "Tests pass" } });
  assert.equal(duplicate.structuredContent.delivery_status, "deduplicated");
  assert.equal(notices.length, 3);
});

test("daemon restart reuses the persisted port and conflicts fail without changing it", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const picked = await selectPort(); await new Promise((resolve) => picked.reservation.close(resolve));
  const config = newConfig({ port: picked.port }); createClientCredential(config, "codex"); saveConfig(config, { paths: env.paths });
  const first = await startDaemon({ paths: env.paths, channels: false }); await first.close();
  const second = await startDaemon({ paths: env.paths, channels: false }); await second.close();
  const blocker = await bindAvailablePort(picked.port);
  await assert.rejects(startDaemon({ paths: env.paths, channels: false }), /EADDRINUSE|address already in use/iu);
  await new Promise((resolve) => blocker.close(resolve));
  assert.equal(JSON.parse(fs.readFileSync(env.paths.configPath, "utf8")).server.port, picked.port);
});

test("bearer credentials resolve tenants and isolate identical session ids", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const picked = await selectPort(); await new Promise((resolve) => picked.reservation.close(resolve));
  const config = newConfig({ port: picked.port });
  config.tenants.other = { tenantId: "other", displayName: "Other", enabled: true, authors: {}, channels: {}, clientCredentials: {} };
  const defaultToken = createClientCredential(config, "codex", "default").token;
  const otherToken = createClientCredential(config, "claude", "other").token;
  saveConfig(config, { paths: env.paths });
  const daemon = await startDaemon({ config, paths: env.paths, channels: false });
  const clients = await Promise.all([connect(`http://127.0.0.1:${picked.port}/mcp`, defaultToken, "default"), connect(`http://127.0.0.1:${picked.port}/mcp`, otherToken, "other")]);
  t.after(async () => { await Promise.allSettled(clients.map((client) => client.close())); await daemon.close(); });
  const [defaultSession, otherSession] = await Promise.all([
    clients[0].callTool({ name: "sync_session", arguments: { agent: "codex", workspace: "/same", label: "Default", status: "working", stage: "Start", acknowledged_instruction_ids: [] } }),
    clients[1].callTool({ name: "sync_session", arguments: { agent: "claude", workspace: "/same", label: "Other", status: "working", stage: "Start", acknowledged_instruction_ids: [] } }),
  ]);
  assert.equal(defaultSession.structuredContent.session_id, "S1");
  assert.equal(otherSession.structuredContent.session_id, "S1");
  assert.equal(defaultSession.structuredContent.tenant_id, "default");
  assert.equal(otherSession.structuredContent.tenant_id, "other");
  await new TenantStore({ paths: env.paths, tenantId: "default" }).enqueueInstruction("S1", "default only");
  const otherSync = await clients[1].callTool({ name: "sync_session", arguments: { session_id: "S1", agent: "claude", workspace: "/same", label: "Other", status: "working", stage: "Continue", acknowledged_instruction_ids: [] } });
  assert.deepEqual(otherSync.structuredContent.instructions, []);
  const schemas = (await clients[0].listTools()).tools.map((tool) => JSON.stringify(tool.inputSchema));
  assert.ok(schemas.every((schema) => !schema.includes("tenant")));
});
