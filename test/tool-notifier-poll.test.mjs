import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pollViews } from "../scripts/tool-notifier-poll.mjs";

test("tool notifier only emits once for running to completed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-notifier-poll-"));
  const statePath = path.join(dir, "tool-notifier-state.json");
  const sent = [];
  const base = {
    source: "opencode",
    sessionId: "ses_test",
    cwd: "/tmp/project",
    prompt: "finish the feature",
    summary: "implemented the feature",
    startedAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:10.000Z",
  };

  assert.deepEqual(pollViews([{ ...base, status: "running" }], {
    statePath,
    nowMs: Date.parse("2026-08-09T00:00:10.000Z"),
    notify: (event) => sent.push(event),
  }), { views: 1, notifications: 0 });
  assert.deepEqual(pollViews([{ ...base, status: "completed", updatedAt: "2026-08-09T00:00:20.000Z" }], {
    statePath,
    nowMs: Date.parse("2026-08-09T00:00:20.000Z"),
    notify: (event) => sent.push(event),
  }), { views: 1, notifications: 1 });
  assert.deepEqual(pollViews([{ ...base, status: "completed", updatedAt: "2026-08-09T00:00:30.000Z" }], {
    statePath,
    nowMs: Date.parse("2026-08-09T00:00:30.000Z"),
    notify: (event) => sent.push(event),
  }), { views: 1, notifications: 0 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].task, /^\[opencode\]/u);
  assert.match(sent[0].summary, /目录：\/tmp\/project/u);
});

test("tool notifier purges sessions inactive for seven days", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-notifier-purge-"));
  const statePath = path.join(dir, "tool-notifier-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ sessions: {
    "claude:old": {
      source: "claude", sessionId: "old", status: "completed",
      firstSeenAt: "2026-07-01T00:00:00.000Z", lastActiveAt: "2026-07-01T00:00:00.000Z",
    },
  } }));
  pollViews([], { statePath, nowMs: Date.parse("2026-08-09T00:00:00.000Z") });
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(state.sessions, {});
});
