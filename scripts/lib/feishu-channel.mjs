import fs from "node:fs";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";

const channelCache = new Map();

function cacheKey(config) {
  return `${config.appId || ""}\0${config.namespace || `${config.account || "default"}/${config.bot || "default"}`}`;
}

function loggerLevel(config, sdk = lark) {
  const requested = String(config.feishuLoggerLevel || config.loggerLevel || "info").toLowerCase();
  return sdk.LoggerLevel?.[requested] ?? sdk.LoggerLevel?.info;
}

export function createFeishuChannel(config, options = {}) {
  const sdk = options.sdk || lark;
  if (!config.appId) throw new Error(`Missing Feishu appId for ${config.account}/${config.bot}`);
  if (!config.appSecret) throw new Error(`Missing Feishu appSecret for ${config.account}/${config.bot}`);
  const mediaRoots = Array.isArray(config.mediaRoots) && config.mediaRoots.length
    ? config.mediaRoots
    : [config.notifierHome, "/tmp"].filter(Boolean);
  return sdk.createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: sdk.Domain?.Feishu,
    loggerLevel: loggerLevel(config, sdk),
    source: "codex-notifier",
    includeRawEvent: false,
    handshakeTimeoutMs: Number(config.feishuHandshakeTimeoutMs || 15000),
    policy: {
      dmMode: "open",
      requireMention: true,
      respondToMentionAll: false,
      ...(config.policy || {}),
    },
    safety: {
      dedup: { ttl: 10 * 60 * 1000, maxEntries: 10000 },
      chatQueue: { enabled: true },
      staleMessageWindowMs: Number(config.staleMessageWindowMs || 5 * 60 * 1000),
      ...(config.safety || {}),
    },
    outbound: {
      textChunkLimit: Number(config.textChunkLimit || 12000),
      allowedFileDirs: mediaRoots,
      retry: { maxAttempts: 3, baseDelayMs: 500 },
      ...(config.outbound || {}),
    },
  });
}

export function getFeishuChannel(config, options = {}) {
  if (config.feishuChannel) return config.feishuChannel;
  const key = cacheKey(config);
  if (!channelCache.has(key)) channelCache.set(key, createFeishuChannel(config, options));
  return channelCache.get(key);
}

export function clearFeishuChannelCache() {
  channelCache.clear();
}

export function feishuReplyOptions(config = {}) {
  return {
    ...(config.feishuReplyTo ? { replyTo: config.feishuReplyTo } : {}),
    ...(config.feishuReplyInThread ? { replyInThread: true } : {}),
  };
}

export async function sendFeishuMarkdown(text, config, options = {}) {
  const target = options.chatId || config.toChat || config.chatId;
  if (!target) throw new Error(`Missing Feishu chatId for ${config.account}/${config.bot}`);
  if (config.dryRun || options.dryRun) {
    process.stdout.write(`[dry-run feishu ${config.account}/${config.bot} -> ${target}]\n${text}\n`);
    return { messageId: "dry-run" };
  }
  const channel = getFeishuChannel(config, options);
  return channel.send(target, { markdown: String(text || "") }, {
    ...feishuReplyOptions(config),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    ...(options.replyInThread ? { replyInThread: true } : {}),
  });
}

export async function sendFeishuMedia(filePath, config, options = {}) {
  const target = options.chatId || config.toChat || config.chatId;
  if (!target) throw new Error(`Missing Feishu chatId for ${config.account}/${config.bot}`);
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Feishu media path is not a file: ${resolved}`);
  if (config.dryRun || options.dryRun) {
    process.stdout.write(`[dry-run feishu media ${config.account}/${config.bot} -> ${target}] ${resolved} ${stat.size} bytes\n`);
    return { messageId: "dry-run-media" };
  }
  const channel = getFeishuChannel(config, options);
  const ext = path.extname(resolved).toLowerCase();
  const isImage = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]).has(ext);
  const input = isImage
    ? { image: { source: resolved } }
    : { file: { source: resolved, fileName: path.basename(resolved) } };
  return channel.send(target, input, {
    ...feishuReplyOptions(config),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    ...(options.replyInThread ? { replyInThread: true } : {}),
  });
}

function resourceFileName(resource, index) {
  if (resource.fileName) return path.basename(resource.fileName);
  const extension = resource.type === "image" ? ".png"
    : resource.type === "audio" ? ".opus"
      : resource.type === "video" ? ".mp4"
        : ".bin";
  return `feishu-${resource.type || "file"}-${index + 1}${extension}`;
}

export async function downloadFeishuResources(message, channel) {
  const attachments = [];
  let index = 0;
  for (const resource of message.resources || []) {
    const resourceType = resource.type === "image" ? "image" : "file";
    const buffer = await channel.downloadResource(resource.fileKey, resourceType);
    attachments.push({
      kind: resource.type === "image" ? "image" : "file",
      fileName: resourceFileName(resource, index),
      buffer,
      source: "feishu",
      feishuResourceType: resource.type,
      feishuFileKey: resource.fileKey,
    });
    index += 1;
  }
  return attachments;
}

export class LocalMessageQueue {
  constructor() {
    this.pending = new Map();
  }

  enqueue(key, job) {
    const queueKey = String(key || "default");
    const previous = this.pending.get(queueKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(job);
    this.pending.set(queueKey, current);
    current.finally(() => {
      if (this.pending.get(queueKey) === current) this.pending.delete(queueKey);
    }).catch(() => {});
    return current;
  }

  async drain() {
    await Promise.allSettled([...this.pending.values()]);
  }
}

export class MessageDeduplicator {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs || 10 * 60 * 1000);
    this.maxEntries = Number(options.maxEntries || 10000);
    this.items = new Map();
  }

  accept(messageId, now = Date.now()) {
    const key = String(messageId || "");
    if (!key) return true;
    const seenAt = this.items.get(key);
    if (seenAt && now - seenAt <= this.ttlMs) return false;
    this.items.set(key, now);
    if (this.items.size > this.maxEntries) {
      for (const [id, at] of this.items) {
        if (now - at > this.ttlMs || this.items.size > this.maxEntries) this.items.delete(id);
        if (this.items.size <= this.maxEntries) break;
      }
    }
    return true;
  }
}

export function feishuConversationKey(message) {
  return String(message.chatId || message.senderId || "local");
}

export function feishuReplyConfig(config, message) {
  return {
    ...config,
    toChat: message.chatId,
    chatId: message.chatId,
    feishuReplyTo: message.messageId,
    feishuReplyInThread: Boolean(message.threadId || message.rootId),
  };
}
