import crypto from "node:crypto";
import path from "node:path";
import { TenantStore } from "./tenant-store.mjs";
import { createMobileCommandRouter } from "./mobile-commands.mjs";
import { managedSessionOperations } from "./managed-sessions.mjs";
import { createFeishuChannel, feishuReplyConfig, sendFeishuMarkdown } from "./feishu-channel.mjs";
import { sendWeixinText } from "./channel-notifier.mjs";
import { readJson, writeJson } from "./atomic-json.mjs";
import { saveConfig } from "./catm-config.mjs";

const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);

function headers(token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    AuthorizationType: "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": CLIENT_VERSION,
    "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64"),
  };
}

function messageText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  return items.map((item) => item?.text_item?.text || "").filter(Boolean).join("\n").trim();
}

function baseUrl(channel) { return `${String(channel.baseUrl || "https://ilinkai.weixin.qq.com").replace(/\/?$/u, "/")}`; }

function rememberTarget(config, paths, tenantId, channelId, target) {
  const channel = config.tenants[tenantId].channels[channelId];
  channel.authorTargets ||= {};
  channel.authorTargets.default = { id: "default", enabled: true, ...target };
  saveConfig(config, { paths });
}

async function startWeixin({ config, paths, tenantId, channelId, channel, router, store }) {
  const statePath = path.join(paths.stateDir, "channels", `${tenantId}-${channelId}.json`);
  let syncBuf = readJson(statePath, {})?.syncBuf || "";
  let stopped = false;
  let activeController = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        activeController = new AbortController();
        const timeout = setTimeout(() => activeController?.abort(), 40_000);
        let response;
        try {
          response = await fetch(new URL("ilink/bot/getupdates", baseUrl(channel)), {
            method: "POST",
            headers: headers(channel.token),
            body: JSON.stringify({ get_updates_buf: syncBuf, base_info: { channel_version: "2.4.6" } }),
            signal: activeController.signal,
          });
        } finally {
          clearTimeout(timeout);
          activeController = null;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        syncBuf = payload.get_updates_buf || syncBuf;
        writeJson(statePath, { syncBuf, updatedAt: new Date().toISOString() }, 0o600);
        for (const message of payload.msg_list || payload.message_list || []) {
          if (message.message_type !== 1) continue;
          const text = messageText(message);
          if (!text) continue;
          const senderId = String(message.from_user_id || "");
          const conversationId = String(message.group_id || senderId);
          try {
            const reply = await router({ text, channel: channelId, senderId, conversationId });
            if (reply) await sendWeixinText(reply, { channelConfig: channel, toUser: conversationId, contextToken: message.context_token });
            if (store.authorBinding(channelId, senderId) && senderId && message.context_token) {
              rememberTarget(config, paths, tenantId, channelId, { toUser: conversationId, contextToken: message.context_token, senderId });
            }
          } catch (error) {
            await sendWeixinText(`Error: ${error.message}`, { channelConfig: channel, toUser: conversationId, contextToken: message.context_token }).catch(() => {});
          }
        }
      } catch (error) {
        if (!stopped) {
          process.stderr.write(`[catm] ${channelId} polling error: ${error.message}\n`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
  })();
  return { close: async () => { stopped = true; activeController?.abort(); await loop; } };
}

async function startFeishu({ config, paths, tenantId, channelId, channel, router, store }) {
  const client = createFeishuChannel({ ...channel, account: "default", bot: channelId, notifierHome: paths.stateDir });
  client.on("message", async (message) => {
    const text = String(message.content || "").trim();
    if (!text) return;
    const senderId = String(message.senderId || "");
    const conversationId = String(message.chatId || senderId);
    const replyConfig = feishuReplyConfig({ ...channel, account: "default", bot: channelId, notifierHome: paths.stateDir }, message);
    try {
      const reply = await router({ text, channel: channelId, senderId, conversationId });
      if (reply) await sendFeishuMarkdown(reply, replyConfig);
      if (store.authorBinding(channelId, senderId) && conversationId) rememberTarget(config, paths, tenantId, channelId, { chatId: conversationId, senderId });
    } catch (error) {
      await sendFeishuMarkdown(`Error: ${error.message}`, replyConfig).catch(() => {});
    }
  });
  client.on("error", (error) => process.stderr.write(`[catm] ${channelId} channel error: ${error.message}\n`));
  await client.connect();
  return { close: () => client.disconnect() };
}

export async function startChannelServices({ config, paths }) {
  const handles = [];
  for (const [tenantId, tenant] of Object.entries(config.tenants)) {
    if (!tenant.enabled) continue;
    const store = new TenantStore({ paths, tenantId });
    const ops = managedSessionOperations({ store, workspace: tenant.defaultWorkspace || process.cwd(), health: async () => `CATM ready · tenant ${tenantId} · ${store.listSessions().length} sessions` });
    const router = createMobileCommandRouter({ store, operations: ops });
    for (const [channelId, channel] of Object.entries(tenant.channels || {})) {
      if (channel.enabled === false) continue;
      try {
        if (channel.type === "weixin") handles.push(await startWeixin({ config, paths, tenantId, channelId, channel, router, store }));
        if (channel.type === "feishu" || channel.type === "lark") handles.push(await startFeishu({ config, paths, tenantId, channelId, channel, router, store }));
      } catch (error) {
        process.stderr.write(`[catm] ${channelId} did not start: ${error.message}\n`);
      }
    }
  }
  return { close: async () => Promise.allSettled(handles.map((handle) => handle.close())) };
}
