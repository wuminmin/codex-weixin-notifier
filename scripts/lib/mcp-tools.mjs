import * as z from "zod/v4";
import { TenantStore } from "./tenant-store.mjs";
import { fanOutAuthorMessage, formatCompletionMessage, formatDecisionMessage } from "./channel-notifier.mjs";

const INSTRUCTIONS = `CATM manages author communication for coding-agent sessions. Call sync_session before substantive work, after each major stage, about every five minutes during continuous work, before and after an author decision, and before completion. Exhaust safe repository exploration before asking the author. Use request_author_decision only for true author choices, then keep wait_author_decision active until it returns answered. A mobile answer resumes an active wait immediately; if the wait disconnects, the answer remains durable but cannot wake a stopped agent. Never send secrets, full logs, or unnecessary source code. Before final delivery, draft the exact complete user-visible final response, call notify_work_completed exactly once for the current work cycle with that response unchanged in summary, then send the same response to the user without edits. CATM adds the agent identity header; verification is internal metadata and is not rendered in the author notification.`;

function result(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function publicDecision(decision) {
  return {
    decision_id: decision.decisionId,
    short_code: decision.shortCode,
    session_id: decision.sessionId,
    status: decision.status,
    answer: decision.answer ? {
      text: decision.answer.text,
      option_id: decision.answer.optionId,
      channel: decision.answer.channel,
      answered_at: decision.answer.answeredAt,
    } : null,
    delivery: (decision.delivery || []).map(({ ok, label, messageId, error }) => ({ ok, label, messageId, error })),
    deduplicated: Boolean(decision.deduplicated),
  };
}

function publicCompletion(completion) {
  return {
    session_id: completion.sessionId,
    work_cycle_id: completion.workCycleId,
    status: "idle",
    delivery: completion.delivery || [],
    deduplicated: Boolean(completion.deduplicated),
  };
}

export function createToolContext({
  mcpServer,
  config,
  paths,
  credential,
  notifier = fanOutAuthorMessage,
  waitRegistry,
  waitHeartbeatMs = 15_000,
  waitPollMs = 5_000,
}) {
  const tenantId = credential.tenantId;
  const tenant = config.tenants[tenantId];
  const store = new TenantStore({ paths, tenantId });

  mcpServer.registerTool("sync_session", {
    title: "Synchronize coding-agent session",
    description: "Register or update one coding-agent session, acknowledge prior mobile instructions, and receive all unacknowledged author instructions.",
    inputSchema: {
      session_id: z.string().regex(/^S\d+$/iu).optional(),
      agent: z.enum(["codex", "claude", "opencode"]),
      workspace: z.string().min(1).max(4096),
      label: z.string().min(1).max(160),
      status: z.enum(["working", "verifying", "waiting_author", "queued", "idle", "stale"]),
      stage: z.string().min(1).max(500),
      acknowledged_instruction_ids: z.array(z.string().regex(/^I\d+$/u)).max(500).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => result(await store.syncSession(input)));

  mcpServer.registerTool("request_author_decision", {
    title: "Request an author decision",
    description: "Create and notify one independent author decision for a registered session. New questions need new idempotency keys.",
    inputSchema: {
      session_id: z.string().regex(/^S\d+$/iu),
      question: z.string().min(1).max(2000),
      context: z.string().max(4000).default(""),
      options: z.array(z.object({
        id: z.string().min(1).max(32),
        label: z.string().min(1).max(200),
        description: z.string().max(500).default(""),
      })).min(2).max(5).optional(),
      recommendation: z.string().max(1000).default(""),
      allow_free_text: z.boolean().default(true),
      idempotency_key: z.string().min(1).max(200),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const decision = await store.createDecision(input);
    if (decision.deduplicated && decision.delivery?.length) return result(publicDecision(decision));
    const session = store.getSession(decision.sessionId);
    const delivery = await notifier(tenant, formatDecisionMessage(decision, session), { stateDir: paths.stateDir });
    await store.recordDecisionDelivery(decision.decisionId, delivery);
    const updated = store.getDecision(decision.decisionId);
    const success = delivery.filter((item) => item.ok).length;
    return result({ ...publicDecision(updated), delivery_status: success === 0 ? "failed" : success === delivery.length ? "sent" : "partial" }, success === 0);
  });

  mcpServer.registerTool("wait_author_decision", {
    title: "Wait for an author decision",
    description: "Wait for a previously requested author decision. The durable decision survives timeout, cancellation, and reconnects.",
    inputSchema: {
      decision_id: z.string().regex(/^D\d+$/iu),
      timeout_seconds: z.number().int().min(0).max(21600).default(21600),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ decision_id, timeout_seconds }, extra) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    const registration = waitRegistry?.register(tenantId, decision_id);
    let nextHeartbeat = Date.now() + waitHeartbeatMs;
    let heartbeats = 0;
    try {
      while (true) {
        const decision = store.getDecision(decision_id);
        if (decision.status !== "pending") {
          return result({ ...publicDecision(decision), wait_status: decision.status === "answered" ? "answered" : "cancelled" });
        }
        if (extra.signal.aborted) return result({ ...publicDecision(decision), wait_status: "cancelled" });
        if (timeout_seconds === 0 || Date.now() >= deadline) return result({ ...publicDecision(decision), wait_status: "pending" });

        const waitMs = Math.min(waitPollMs, Math.max(1, deadline - Date.now()));
        if (registration) await registration.wait(waitMs, extra.signal);
        else await new Promise((resolve) => setTimeout(resolve, waitMs));

        if (Date.now() >= nextHeartbeat) {
          heartbeats += 1;
          nextHeartbeat = Date.now() + waitHeartbeatMs;
          const message = `Waiting for author decision ${decision.shortCode} (${heartbeats})`;
          if (extra._meta?.progressToken !== undefined) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: extra._meta.progressToken,
                progress: Math.min(Date.now() - (deadline - timeout_seconds * 1000), timeout_seconds * 1000),
                total: timeout_seconds * 1000,
                message,
              },
            }).catch(() => {});
          } else {
            await mcpServer.sendLoggingMessage({ level: "debug", logger: "catm", data: message }).catch(() => {});
          }
        }
      }
    } finally {
      registration?.close();
    }
  });

  mcpServer.registerTool("notify_work_completed", {
    title: "Notify work-cycle completion",
    description: "Send one idempotent completion notification for the current session work cycle. Pass the exact complete user-visible final response unchanged in summary; CATM prepends agent identity, while verification remains internal and is not rendered.",
    inputSchema: {
      session_id: z.string().regex(/^S\d+$/iu),
      work_cycle_id: z.string().regex(/^W\d+$/iu),
      summary: z.string().min(1).max(12000),
      verification: z.string().max(4000).default(""),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const completion = await store.completeWork(input);
    if (completion.deduplicated && completion.delivery?.some((item) => item.ok)) return result({ ...publicCompletion(completion), delivery_status: "deduplicated" });
    const session = store.getSession(input.session_id);
    const delivery = await notifier(tenant, formatCompletionMessage(completion, session), { stateDir: paths.stateDir });
    await store.recordCompletionDelivery(input.session_id, input.work_cycle_id, delivery);
    const success = delivery.filter((item) => item.ok).length;
    return result({
      session_id: input.session_id.toUpperCase(),
      work_cycle_id: input.work_cycle_id.toUpperCase(),
      status: "idle",
      delivery,
      delivery_status: success === 0 ? "failed" : success === delivery.length ? "sent" : "partial",
      deduplicated: Boolean(completion.deduplicated),
    }, success === 0);
  });

  return { store, instructions: INSTRUCTIONS };
}

export { INSTRUCTIONS as MCP_INSTRUCTIONS };
