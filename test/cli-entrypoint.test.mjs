import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tempEnvironment } from "./helpers.mjs";
import { daemonPidIsCatm } from "../scripts/catm.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("catm executes when invoked through the installed extensionless symlink", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const link = path.join(env.root, "catm");
  fs.symlinkSync(path.join(ROOT, "scripts", "catm.mjs"), link);

  const result = spawnSync(link, ["help"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CATM 1\.0$/mu);
  assert.match(result.stdout, /^catm onboard /mu);
});

test("CATM recognizes its daemon when Node uses an absolute executable path", (t) => {
  const env = tempEnvironment(); t.after(env.cleanup);
  const daemon = path.join(env.root, "catm-daemon.mjs");
  fs.writeFileSync(daemon, "setInterval(() => {}, 60_000);\n");
  const child = spawn(process.execPath, [daemon], { stdio: "ignore" });
  t.after(() => child.kill("SIGTERM"));

  assert.equal(daemonPidIsCatm(child.pid), true);
  assert.equal(daemonPidIsCatm(process.pid), false);
});
