import crypto from "node:crypto";
import { sendFeishuMarkdown } from "./feishu-channel.mjs";

function commonHeaders() {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 6),
    "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64"),
  };
}

export async function sendWeixinText(text, target) {
  const channel = target.channelConfig;
  if (!channel.token || !channel.botId || !target.toUser || !target.contextToken) throw new Error("incomplete Weixin target configuration");
  const response = await fetch(new URL("ilink/bot/sendmessage", `${String(channel.baseUrl || "https://ilinkai.weixin.qq.com").replace(/\/?$/u, "/")}`), {
    method: "POST",
    headers: { ...commonHeaders(), authorization: `Bearer ${channel.token}` },
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: target.toUser,
        client_id: `catm-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: target.contextToken,
      },
      base_info: { channel_version: "2.4.6", bot_agent: "CATM/2.0.0" },
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Weixin HTTP ${response.status}: ${body.slice(0, 300)}`);
  return { messageId: "", raw: body };
}

export function authorTargets(tenant) {
  const targets = [];
  for (const [channelId, channel] of Object.entries(tenant.channels || {})) {
    if (channel?.enabled === false) continue;
    for (const target of Object.values(channel.authorTargets || {})) {
      if (target?.enabled === false) continue;
      if (channel.type === "weixin" && target.toUser) targets.push({ channelId, type: "weixin", channelConfig: channel, ...target });
      if (channel.type === "feishu" && target.chatId) targets.push({ channelId, type: channel.type, channelConfig: channel, ...target });
    }
  }
  return targets;
}

export async function fanOutAuthorMessage(tenant, text, options = {}) {
  const targets = options.targets || authorTargets(tenant);
  const results = [];
  for (const target of targets) {
    const label = `${target.type}/${target.channelId}/${target.id || "author"}`;
    try {
      const response = target.type === "weixin"
        ? await (options.sendWeixin || sendWeixinText)(text, target)
        : await (options.sendFeishu || sendFeishuMarkdown)(text, {
          ...target.channelConfig,
          platform: target.type,
          account: target.channelConfig.account || "default",
          bot: target.channelConfig.bot || target.channelId,
          toChat: target.chatId,
          chatId: target.chatId,
          notifierHome: options.stateDir,
        });
      results.push({
        ok: true,
        label,
        messageId: response?.messageId || "",
        channel: target.channelId,
        conversationId: String(target.type === "weixin" ? target.toUser : target.chatId),
      });
    } catch (error) {
      results.push({ ok: false, label, error: String(error.message || error) });
    }
  }
  return results;
}

export function formatCompletionMessage(completion, session) {
  return [
    `Agent: ${session.agent} · Session: ${session.sessionId} · Work cycle: ${completion.workCycleId}`,
    `Workspace: ${session.workspace}`,
    `Task: ${session.label}`,
    "",
    completion.summary,
  ].join("\n");
}

export function formatAuthorNotification(notification, session) {
  return [
    `Agent: ${session.agent} · Session: ${session.sessionId} · Work cycle: ${notification.workCycleId}`,
    `Workspace: ${session.workspace}`,
    `Task: ${session.label}`,
    "",
    notification.message,
  ].join("\n");
}
