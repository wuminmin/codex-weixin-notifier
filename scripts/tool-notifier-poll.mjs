#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localSessionViews } from "./codex-task-monitor.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const STATE_DIR = process.env.CODEX_WEIXIN_STATE_DIR || path.join(os.homedir(), ".codex", "weixin-notifier");
const STATE_PATH = path.join(STATE_DIR, "tool-notifier-state.json");
const LOG_PATH = path.join(STATE_DIR, "logs", "tool-notifier.log");
const POLL_INTERVAL_MS = Number(process.env.CODEX_TOOL_NOTIFIER_INTERVAL_MS) || 60_000;
const DRY_RUN = process.env.CODEX_TOOL_NOTIFIER_DRY_RUN === "1" || process.argv.includes("--dry-run");
const NOTIFY_SCRIPT = path.join(SCRIPT_DIR, "notify.mjs");
const NOTIFY_SOURCES = new Set(
  (process.env.CODEX_TOOL_NOTIFIER_SOURCES || "claude,opencode")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const SOURCE_LABELS = { claude: "Claude Code", opencode: "opencode" };

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // best-effort logging
  }
  if (process.env.CODEX_TOOL_NOTIFIER_VERBOSE === "1" || DRY_RUN) {
    process.stderr.write(line);
  }
}

function stateKey(view) {
  return `${view.source}:${view.sessionId}`;
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

function spawnNotify(event) {
  if (!fs.existsSync(NOTIFY_SCRIPT)) {
    log(`notify script not found: ${NOTIFY_SCRIPT}`);
    return;
  }
  const child = spawn(process.execPath, [NOTIFY_SCRIPT], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, CODEX_NOTIFIER_ROUTER_TASK: "" },
  });
  child.on("error", (err) => log(`notify spawn error: ${err.message}`));
  try {
    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  } catch (err) {
    log(`notify stdin write error: ${err.message}`);
  }
  child.unref();
}

function buildEvent(view) {
  const promptText = String(view.prompt || "").slice(0, 80) || "(无任务描述)";
  const summaryText = String(view.summary || "");
  const cwdText = String(view.cwd || "");
  const summaryParts = [];
  if (summaryText) summaryParts.push(summaryText);
  summaryParts.push(`目录：${cwdText || "(未知)"}`);
  summaryParts.push(`来源：${sourceLabel(view.source)}`);
  return {
    sessionId: view.sessionId,
    source: view.source === "claude" ? "claude-code" : view.source,
    status: "completed",
    workspace: cwdText,
    task: `[${sourceLabel(view.source)}] ${promptText}`,
    summary: summaryParts.join("\n"),
    startedAt: view.startedAt || view.createdAt || "",
    finishedAt: view.completedAt || view.updatedAt || new Date().toISOString(),
  };
}

function poll() {
  const views = localSessionViews();
  const relevant = views.filter((view) => NOTIFY_SOURCES.has(String(view.source).toLowerCase()));
  const state = readJson(STATE_PATH, { sessions: {} });
  if (!state.sessions || typeof state.sessions !== "object") state.sessions = {};
  const now = new Date().toISOString();
  let changed = false;
  let notifications = 0;

  for (const view of relevant) {
    const key = stateKey(view);
    const prev = state.sessions[key] || {};
    if (!prev.firstSeenAt) {
      state.sessions[key] = {
        source: view.source,
        sessionId: view.sessionId,
        status: view.status,
        cwd: view.cwd,
        prompt: view.prompt,
        summary: view.summary,
        firstSeenAt: now,
        lastActiveAt: view.updatedAt,
      };
      changed = true;
      log(`discovered ${key}: status=${view.status}`);
      continue;
    }
    if (prev.status !== view.status) {
      log(`${key}: ${prev.status} -> ${view.status}`);
      if (prev.status === "running" && view.status === "completed" && !prev.notifiedAt) {
        const event = buildEvent(view);
        log(`notify ${key}: ${event.task}`);
        if (!DRY_RUN) spawnNotify(event);
        else log(`[dry-run] would notify: ${JSON.stringify(event)}`);
        prev.notifiedAt = now;
        notifications += 1;
      }
      prev.status = view.status;
      prev.lastActiveAt = view.updatedAt;
      changed = true;
    }
    if (view.summary && view.summary !== prev.summary) {
      prev.summary = view.summary;
      changed = true;
    }
    if (view.cwd && view.cwd !== prev.cwd) {
      prev.cwd = view.cwd;
      changed = true;
    }
    state.sessions[key] = prev;
  }

  const purgeCutoff = Date.now() - PURGE_AFTER_MS;
  for (const [key, entry] of Object.entries(state.sessions)) {
    const lastMs = Date.parse(entry.lastActiveAt || entry.firstSeenAt || "");
    if (Number.isFinite(lastMs) && lastMs < purgeCutoff) {
      delete state.sessions[key];
      changed = true;
      log(`purged stale ${key}`);
    }
  }

  if (changed) {
    state.updatedAt = now;
    try {
      atomicWriteJson(STATE_PATH, state);
    } catch (err) {
      log(`state write error: ${err.message}`);
    }
  }
  return { views: relevant.length, notifications };
}

async function main() {
  log(`tool-notifier started: interval=${POLL_INTERVAL_MS}ms sources=[${[...NOTIFY_SOURCES].join(",")}] dryRun=${DRY_RUN}`);
  try {
    const result = poll();
    log(`initial poll: ${result.views} sessions, ${result.notifications} notifications`);
  } catch (err) {
    log(`initial poll error: ${err.stack || err.message}`);
  }
  setInterval(() => {
    try {
      const result = poll();
      if (result.notifications > 0) {
        log(`poll: ${result.views} sessions, ${result.notifications} notifications`);
      }
    } catch (err) {
      log(`poll error: ${err.stack || err.message}`);
    }
  }, POLL_INTERVAL_MS);
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

export { poll, buildEvent, spawnNotify };
