import * as z from "zod/v4";
import { TenantStore } from "./tenant-store.mjs";
import { fanOutAuthorMessage, formatAuthorNotification, formatCompletionMessage } from "./channel-notifier.mjs";

const INSTRUCTIONS = `CATM is a notification-only service for coding-agent sessions. Call sync_session when work begins, after major stages, after verification, before completion, and about every five minutes during continuous work. Keep the returned session_id and work_cycle_id for this conversation. Use notify_author whenever a proactive progress update, warning, or other useful message should reach the author. notify_author is non-idempotent and may be called any number of times in one work cycle; every call sends a new message. CATM does not collect author decisions or remote instructions; ask the author in the active agent conversation whenever input is required. Never send credentials, secrets, full logs, or unnecessary source code. Before final delivery, draft the exact complete user-visible final response, call notify_work_completed with that response unchanged in summary, then send the same response to the user without edits. CATM adds the agent identity header; verification is internal metadata and is not rendered in the author notification.`;

function result(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
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
}) {
  const tenantId = credential.tenantId;
  const tenant = config.tenants[tenantId];
  const store = new TenantStore({ paths, tenantId });

  mcpServer.registerTool("sync_session", {
    title: "Synchronize coding-agent session",
    description: "Register or update one coding-agent session and return its notification work-cycle identity.",
    inputSchema: {
      session_id: z.string().regex(/^S\d+$/iu).optional(),
      agent: z.enum(["codex", "claude", "opencode"]),
      workspace: z.string().min(1).max(4096),
      label: z.string().min(1).max(160),
      status: z.enum(["working", "verifying", "waiting_author", "queued", "idle", "stale"]),
      stage: z.string().min(1).max(500),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => result(await store.syncSession(input)));

  mcpServer.registerTool("notify_author", {
    title: "Notify the author",
    description: "Send a new proactive message to the author. This tool is non-idempotent and can be called any number of times in the current work cycle; each call is delivered as a separate notification and does not change session status.",
    inputSchema: {
      session_id: z.string().regex(/^S\d+$/iu),
      work_cycle_id: z.string().regex(/^W\d+$/iu),
      message: z.string().min(1).max(12000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    const notification = await store.createAuthorNotification(input);
    const session = store.getSession(input.session_id);
    const delivery = await notifier(tenant, formatAuthorNotification(notification, session), { stateDir: paths.stateDir });
    await store.recordAuthorNotificationDelivery(notification.notificationId, delivery);
    const success = delivery.filter((item) => item.ok).length;
    return result({
      notification_id: notification.notificationId,
      session_id: notification.sessionId,
      work_cycle_id: notification.workCycleId,
      status: session.status,
      delivery,
      delivery_status: success === 0 ? "failed" : success === delivery.length ? "sent" : "partial",
    }, success === 0);
  });

  mcpServer.registerTool("notify_work_completed", {
    title: "Notify work-cycle completion",
    description: "Send the idempotent final completion notification for the current session work cycle. Use notify_author for any number of additional messages before or after it. Pass the exact complete user-visible final response unchanged in summary; CATM prepends agent identity, while verification remains internal and is not rendered.",
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
