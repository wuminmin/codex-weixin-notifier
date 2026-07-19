#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { recordHookPayload } from "./codex-task-monitor.mjs";

const NOTIFY = fileURLToPath(new URL("./notify.mjs", import.meta.url));
const LOG = "/tmp/codex-weixin-notifier-hook.log";
const HOOK_DIR = path.join(os.tmpdir(), "codex-weixin-notifier-hooks");

if (process.env.CODEX_WEIXIN_ROUTER_TASK === "1" || process.env.CODEX_NOTIFIER_ROUTER_TASK === "1") {
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

function safeFilePart(value) {
  return String(value || "codex")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "codex";
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function hookEnvAssignments() {
  const keep = /^(?:CODEX_|WEIXIN_|HTTP_|HTTPS_|ALL_PROXY$|NO_PROXY$|http_proxy$|https_proxy$|all_proxy$|no_proxy$|NODE_|PATH$|HOME$|USER$|SHELL$)/u;
  return Object.entries(process.env)
    .filter(([key, value]) => keep.test(key) && value !== undefined)
    .map(([key, value]) => `${key}=${shQuote(value)}`);
}

function appendHookLog(entry) {
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
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

function writeEventFile(event) {
  fs.mkdirSync(HOOK_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(HOOK_DIR, `${Date.now()}-${safeFilePart(event.sessionId)}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return filePath;
}

function launchNotifyDetached(eventFile, event) {
  const stdout = fs.openSync(LOG, "a");
  const stderr = fs.openSync(LOG, "a");
  try {
    const child = spawn(process.execPath, [NOTIFY, "--event-file", eventFile], {
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: process.env,
    });
    child.unref();
    appendHookLog({
      code: "spawned",
      pid: child.pid,
      sessionId: event.sessionId,
      eventFile,
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

function launchNotifyTmux(eventFile, event) {
  const sessionName = `codex-wx-hook-${Date.now()}-${process.pid}`;
  const command = [
    ...hookEnvAssignments(),
    shQuote(process.execPath),
    shQuote(NOTIFY),
    "--event-file",
    shQuote(eventFile),
    ">>",
    shQuote(LOG),
    "2>&1",
  ].join(" ");
  const tmux = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "/bin/bash", "-lc", command], {
    encoding: "utf8",
  });
  if (tmux.status !== 0) {
    throw new Error(`tmux hook launcher failed: ${tmux.stderr || tmux.stdout || `exit ${tmux.status}`}`);
  }
  appendHookLog({
    code: "tmux-spawned",
    tmuxSession: sessionName,
    sessionId: event.sessionId,
    eventFile,
  });
}

function launchNotify(event) {
  const eventFile = writeEventFile(event);
  try {
    launchNotifyTmux(eventFile, event);
  } catch (error) {
    appendHookLog({
      code: "tmux-launch-failed",
      sessionId: event.sessionId,
      eventFile,
      error: error.message,
    });
    launchNotifyDetached(eventFile, event);
  }
}

try {
  const payload = await readStdinJson();
  try {
    recordHookPayload({ ...payload, hook_event_name: payload.hook_event_name || "Stop" });
  } catch (error) {
    appendHookLog({
      code: "task-state-write-failed",
      error: error.stack || error.message,
    });
  }
  launchNotify(normalizeStopPayload(payload));
} catch (error) {
  appendHookLog({
    code: "launch-failed",
    error: error.stack || error.message,
  });
}
