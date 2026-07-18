#!/usr/bin/env node

import process from "node:process";
import { recordHookPayload } from "./codex-task-monitor.mjs";

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

try {
  recordHookPayload(await readStdinJson());
} catch (error) {
  process.stderr.write(`[codex-task-state-hook] ${error.stack || error.message}\n`);
}
