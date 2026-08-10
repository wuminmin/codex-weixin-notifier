import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { onboard } from "../scripts/catm.mjs";
import { selectPort } from "../scripts/lib/port-selection.mjs";
import { tempEnvironment } from "./helpers.mjs";

test("onboard verifies the requested port before persisting one tenant and three clients", async (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const selected = await selectPort(); await new Promise((resolve) => selected.reservation.close(resolve));
  const result = await onboard({ port: String(selected.port), agents: "all" }, { paths: env.paths, home: env.home, skipCleanup: true, startBackground: false });
  const config = JSON.parse(fs.readFileSync(env.paths.configPath, "utf8"));
  assert.equal(config.version, 1);
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.server.port, selected.port);
  assert.equal(config.defaultTenantId, "default");
  assert.equal(config.tenants.default.displayName, "Default");
  assert.deepEqual(Object.keys(config.tenants.default.clientCredentials).sort(), ["claude-local", "codex-local", "opencode-local"]);
  assert.deepEqual(result.types, ["codex", "claude", "opencode"]);
  assert.ok(!fs.readFileSync(env.paths.configPath, "utf8").includes("Bearer "));
});
