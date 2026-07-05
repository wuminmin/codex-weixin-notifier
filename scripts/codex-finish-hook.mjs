#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const NOTIFY = "/path/to/codex-weixin-notifier/scripts/notify-weixin.mjs";
const LOG = "/tmp/codex-weixin-notifier-hook.log";

if (process.env.CODEX_WEIXIN_ROUTER_TASK === "1") {
  process.exit(0);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function compact(value, max = 1200) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function normalizeStopPayload(payload) {
  const session = firstString(
    payload.session_id,
    payload.sessionId,
    payload.thread_id,
    payload.threadId,
    process.env.CODEX_SESSION_ID,
    process.env.VSCODE_PID ? `vscode-${process.env.VSCODE_PID}` : "",
  );

  const task = firstString(
    payload.last_user_message,
    payload.user_prompt,
    payload.prompt,
    payload.cwd,
    "Codex task completed",
  );

  const summary = firstString(
    payload.last_assistant_message,
    payload.final_message,
    payload.message,
    payload.stop_reason,
    "Codex finished a task.",
  );

  return {
    sessionId: session || `codex-${process.pid}`,
    source: process.env.CODEX_NOTIFY_SOURCE || process.env.CODEX_PRODUCT || "codex",
    status: firstString(payload.stop_reason, payload.status, "completed"),
    workspace: firstString(payload.cwd, process.env.PWD, process.cwd()),
    task: compact(task, 240),
    summary: compact(summary),
    finishedAt: new Date().toISOString(),
  };
}

function runNotify(event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NOTIFY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(JSON.stringify(event));
    child.on("error", reject);
    child.on("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      const line = JSON.stringify({
        at: new Date().toISOString(),
        code,
        sessionId: event.sessionId,
        stdout: out,
        stderr: err,
      });
      fs.appendFileSync(LOG, `${line}\n`);
      if (code === 0) resolve();
      else reject(new Error(`notify exited with code ${code}; see ${LOG}`));
    });
  });
}

const payload = await readStdinJson();
await runNotify(normalizeStopPayload(payload));
