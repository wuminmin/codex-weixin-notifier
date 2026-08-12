import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { addPublicUrl, createAccessToken, hashToken, newConfig, publicUrls, removePublicUrl, resolveCredential, saveConfig, validateConfig } from "../scripts/lib/catm-config.mjs";
import { tempEnvironment } from "./helpers.mjs";

test("v2 config fixes the NAS listener and stores only a shared token hash", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const config = newConfig({ publicUrl: "https://catm.example.ts.net/mcp" });
  const credential = createAccessToken(config);
  saveConfig(config, { paths: env.paths });
  const disk = fs.readFileSync(env.paths.configPath, "utf8");
  assert.equal(config.version, 2);
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.port, 61937);
  assert.equal(fs.statSync(env.paths.configPath).mode & 0o777, 0o600);
  assert.ok(!disk.includes(credential.token));
  assert.ok(disk.includes(hashToken(credential.token)));
  assert.equal(resolveCredential(config, `Bearer ${credential.token}`).credentialId, "shared-access");
  assert.equal(resolveCredential(config, "Bearer wrong"), null);
});

test("public URL and destructive schema boundary are strict", () => {
  assert.throws(() => newConfig({ publicUrl: "http://catm.example.ts.net/mcp" }), /HTTPS/u);
  assert.throws(() => newConfig({ publicUrl: "https://catm.example.ts.net/other" }), /\/mcp/u);
  assert.throws(() => validateConfig({ version: 1 }), /fresh NAS deployment/u);
});

test("multiple public MCP URLs are normalized and keep one required endpoint", () => {
  const config = newConfig({ publicUrl: "https://catm.example.ts.net/mcp" });
  assert.equal(addPublicUrl(config, "https://mcp.example.com/mcp"), true);
  assert.equal(addPublicUrl(config, "https://mcp.example.com/mcp"), false);
  assert.deepEqual(publicUrls(validateConfig(config)), ["https://catm.example.ts.net/mcp", "https://mcp.example.com/mcp"]);
  assert.equal(removePublicUrl(config, "https://catm.example.ts.net/mcp"), true);
  assert.equal(config.server.publicUrl, "https://mcp.example.com/mcp");
  assert.throws(() => removePublicUrl(config, "https://mcp.example.com/mcp"), /at least one/u);
});

test("multi-tenant credential isolation remains available internally", () => {
  const config = newConfig({ publicUrl: "https://catm.example.ts.net/mcp" });
  config.tenants.other = { tenantId: "other", displayName: "Other", enabled: true, authors: {}, channels: {}, clientCredentials: {} };
  const first = createAccessToken(config, "default");
  const second = createAccessToken(config, "other", "other-access");
  assert.equal(resolveCredential(config, `Bearer ${first.token}`).tenantId, "default");
  assert.equal(resolveCredential(config, `Bearer ${second.token}`).tenantId, "other");
});
