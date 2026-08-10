import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { candidatePorts, selectPort } from "../scripts/lib/port-selection.mjs";
import { createClientCredential, hashToken, newConfig, resolveCredential, saveConfig } from "../scripts/lib/catm-config.mjs";
import { tempEnvironment } from "./helpers.mjs";

test("private port candidates prefer outside the live ephemeral range", () => {
  const ports = candidatePorts({ ephemeralRange: { start: 32768, end: 60999 }, randomInt: () => 0 });
  const firstInside = ports.findIndex((port) => port <= 60999);
  assert.equal(firstInside, 4536);
  assert.ok(ports.slice(0, firstInside).every((port) => port >= 61000));
  assert.ok(!ports.includes(3765));
});

test("port selection performs an exclusive real bind", async () => {
  const selected = await selectPort({ ephemeralRange: { start: 49152, end: 65530 }, randomInt: () => 0 });
  assert.ok(selected.port >= 65531);
  await assert.rejects(selectPort({ requestedPort: selected.port }), /EADDRINUSE|address already in use/iu);
  await new Promise((resolve) => selected.reservation.close(resolve));
});

test("config is private and stores only credential hashes", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const config = newConfig({ port: 62001 });
  const credential = createClientCredential(config, "codex");
  saveConfig(config, { paths: env.paths });
  const disk = fs.readFileSync(env.paths.configPath, "utf8");
  assert.equal(fs.statSync(env.paths.configPath).mode & 0o777, 0o600);
  assert.ok(!disk.includes(credential.token));
  assert.ok(disk.includes(hashToken(credential.token)));
  assert.equal(resolveCredential(config, `Bearer ${credential.token}`).credentialId, "codex-local");
  assert.equal(resolveCredential(config, "Bearer wrong"), null);
});
