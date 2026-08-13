import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAccessToken, newConfig } from "../scripts/lib/catm-config.mjs";
import { startDaemon } from "../scripts/catm-daemon.mjs";
import { tempEnvironment } from "./helpers.mjs";

async function connect(url, token, name) {
  const client = new Client({ name, version: "2" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
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

test("NAS daemon secures HTTP and exposes only notification tools", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const config = newConfig({ publicUrl: "https://catm.example.ts.net/mcp" });
  config.server.publicUrls.push("https://mcp.sessionbound.org/mcp");
  const token = createAccessToken(config).token;
  const notices = [];
  const daemon = await startDaemon({
    config, paths: env.paths, listenHost: "127.0.0.1", listenPort: 0, channels: false,
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
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["notify_work_completed", "sync_session"]);

  const sessions = await Promise.all(clients.map((client, index) => client.callTool({ name: "sync_session", arguments: {
    agent: ["claude", "codex", "opencode"][index], workspace: `/work/${index}`, label: `Session ${index}`, status: "working", stage: "Started",
  } })));
  assert.equal(new Set(sessions.map((item) => item.structuredContent.session_id)).size, 3);
  assert.ok(sessions.every((item) => !("tenant_id" in item.structuredContent)));
  assert.ok(sessions.every((item) => !("instructions" in item.structuredContent)));
  assert.ok(sessions.every((item) => !("pending_decisions" in item.structuredContent)));

  const session = sessions[0].structuredContent;
  await clients[0].callTool({ name: "notify_work_completed", arguments: { session_id: session.session_id, work_cycle_id: session.work_cycle_id, summary: "Done", verification: "Passed" } });
  assert.match(notices.at(-1), /Agent: claude · Session: S1 · Work cycle: W1/u);
  assert.match(notices.at(-1), /Workspace: \/work\/0/u);
  assert.ok(notices.at(-1).endsWith("Done"));
  assert.doesNotMatch(notices.at(-1), /Passed|Verification:/u);
  const duplicate = await clients[0].callTool({ name: "notify_work_completed", arguments: { session_id: session.session_id, work_cycle_id: session.work_cycle_id, summary: "Done", verification: "Passed" } });
  assert.equal(duplicate.structuredContent.delivery_status, "deduplicated");
  assert.ok(!JSON.stringify(duplicate.structuredContent).includes("tenant"));
});
