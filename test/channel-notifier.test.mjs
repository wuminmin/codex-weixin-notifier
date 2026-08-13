import assert from "node:assert/strict";
import test from "node:test";
import { formatCompletionMessage } from "../scripts/lib/channel-notifier.mjs";

const session = {
  agent: "codex",
  sessionId: "S7",
  workCycle: 3,
  workspace: "/work/one",
  label: "Fix notifier",
};

test("completion notifications prepend identity and preserve the final response verbatim", () => {
  const finalResponse = "已完成。\n\n- 第一项\n- 第二项";
  const message = formatCompletionMessage({
    workCycleId: "W3",
    summary: finalResponse,
    verification: "internal only",
  }, session);

  assert.equal(message, [
    "Agent: codex · Session: S7 · Work cycle: W3",
    "Workspace: /work/one",
    "Task: Fix notifier",
    "",
    finalResponse,
  ].join("\n"));
  assert.doesNotMatch(message, /internal only|Verification:|Work completed/u);
  assert.ok(message.endsWith(finalResponse));
});
