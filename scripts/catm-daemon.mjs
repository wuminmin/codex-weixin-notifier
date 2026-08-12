#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { catmPaths } from "./lib/catm-paths.mjs";
import { assertPrivateConfig, loadConfig, publicUrls, resolveCredential } from "./lib/catm-config.mjs";
import { ensurePrivateDir } from "./lib/atomic-json.mjs";
import { createToolContext, MCP_INSTRUCTIONS } from "./lib/mcp-tools.mjs";
import { startChannelServices } from "./lib/channel-service.mjs";
import { DecisionWaitRegistry } from "./lib/decision-waits.mjs";

function jsonRpcError(res, status, message) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

function allowedHosts(config) {
  const values = [
    `127.0.0.1:${config.server.port}`,
    `localhost:${config.server.port}`,
  ];
  for (const value of publicUrls(config)) {
    const publicUrl = new URL(value);
    values.push(publicUrl.host);
    if (!publicUrl.port) values.push(`${publicUrl.hostname}:443`);
  }
  return new Set(values.map((value) => value.toLowerCase()));
}

function validOrigin(origin, config) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const direct = ["127.0.0.1", "localhost"].includes(url.hostname);
    return direct || publicUrls(config).some((value) => url.origin === new URL(value).origin);
  } catch { return false; }
}

function validHost(value, config) {
  const host = String(value || "").toLowerCase();
  return allowedHosts(config).has(host) || /^(?:127\.0\.0\.1|localhost):\d+$/u.test(host);
}

function requestIdentity(req, config) {
  const host = String(req.headers.host || "").toLowerCase();
  const isPublicEndpoint = publicUrls(config).some((value) => new URL(value).host.toLowerCase() === host);
  const cloudflareAddress = String(req.headers["cf-connecting-ip"] || "").trim();
  if (isPublicEndpoint && net.isIP(cloudflareAddress)) return cloudflareAddress;
  return String(req.socket.remoteAddress || "unknown");
}

function acquireInstanceLock(lockPath) {
  ensurePrivateDir(path.dirname(lockPath));
  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    let alive = false;
    if (pid > 1) try { process.kill(pid, 0); alive = true; } catch {}
    if (!alive) fs.unlinkSync(lockPath);
  }
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`);
    return () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    };
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`CATM daemon already owns ${lockPath}`);
    throw error;
  }
}

export function createCatmApp({ config, paths, notifier, waitRegistry = new DecisionWaitRegistry(), waitHeartbeatMs, waitPollMs } = {}) {
  const app = express();
  const transports = new Map();
  const authFailures = new Map();
  let activeRequests = 0;

  app.use((req, res, next) => validHost(req.headers.host, config) ? next() : res.status(403).json({ error: "forbidden host" }));
  app.get("/health", (_req, res) => res.set("Cache-Control", "no-store").json({ status: "ready", version: "2.0.0" }));

  app.use("/mcp", (req, res, next) => {
    if (!validOrigin(req.headers.origin, config)) return res.status(403).json({ error: "forbidden origin" });
    const remote = requestIdentity(req, config);
    const recent = (authFailures.get(remote) || []).filter((at) => Date.now() - at < 60_000);
    if (recent.length >= 20) return res.status(429).json({ error: "too many authentication failures" });
    const credential = resolveCredential(config, req.headers.authorization);
    if (!credential) {
      recent.push(Date.now());
      authFailures.set(remote, recent);
      return res.status(401).json({ error: "unauthorized" });
    }
    if (activeRequests >= Number(config.server.maxConnections || 128)) return res.status(503).json({ error: "server busy" });
    req.catmCredential = credential;
    activeRequests += 1;
    res.once("finish", () => { activeRequests -= 1; });
    res.once("close", () => { if (!res.writableEnded) activeRequests -= 1; });
    return next();
  });
  app.use("/mcp", express.json({ limit: Number(config.server.maxBodyBytes || 262_144), strict: true }));

  async function post(req, res) {
    const mcpSessionId = req.headers["mcp-session-id"];
    let entry = mcpSessionId ? transports.get(String(mcpSessionId)) : null;
    if (entry && entry.credentialId !== req.catmCredential.credentialId) return jsonRpcError(res, 404, "MCP session not found");
    if (!entry && !mcpSessionId && isInitializeRequest(req.body)) {
      let transport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          entry.sessionId = id;
          transports.set(id, entry);
        },
      });
      const server = new McpServer({ name: "catm", version: "2.0.0" }, { capabilities: { logging: {} }, instructions: MCP_INSTRUCTIONS });
      createToolContext({ mcpServer: server, config, paths, credential: req.catmCredential, notifier, waitRegistry, waitHeartbeatMs, waitPollMs });
      entry = { transport, server, credentialId: req.catmCredential.credentialId, sessionId: "" };
      transport.onclose = () => { if (entry.sessionId) transports.delete(entry.sessionId); };
      await server.connect(transport);
    }
    if (!entry) return jsonRpcError(res, 400, "invalid or missing MCP session");
    try { return await entry.transport.handleRequest(req, res, req.body); }
    catch (error) {
      process.stderr.write(`[catm] MCP request failed: ${error.message}\n`);
      if (!res.headersSent) return jsonRpcError(res, 500, "internal server error");
    }
  }

  async function continuation(req, res) {
    const id = String(req.headers["mcp-session-id"] || "");
    const entry = transports.get(id);
    if (!entry || entry.credentialId !== req.catmCredential.credentialId) return jsonRpcError(res, 404, "MCP session not found");
    return entry.transport.handleRequest(req, res);
  }

  app.post("/mcp", post);
  app.get("/mcp", continuation);
  app.delete("/mcp", continuation);
  app.use((error, _req, res, next) => {
    if (error?.type === "entity.too.large" || error?.status === 413) return res.status(413).json({ error: "request body too large" });
    return next(error);
  });
  return { app, transports, waitRegistry };
}

export async function startDaemon(options = {}) {
  const paths = options.paths || catmPaths(options);
  const loaded = options.config ? { config: options.config, paths } : loadConfig({ paths });
  if (!options.config) assertPrivateConfig(paths.configPath);
  const releaseLock = acquireInstanceLock(paths.lockPath);
  const waitRegistry = options.waitRegistry || new DecisionWaitRegistry();
  const { app, transports } = createCatmApp({
    config: loaded.config,
    paths,
    notifier: options.notifier,
    waitRegistry,
    waitHeartbeatMs: options.waitHeartbeatMs,
    waitPollMs: options.waitPollMs,
  });
  const { host, port } = loaded.config.server;
  const listenHost = options.listenHost || host;
  const listenPort = options.listenPort ?? port;
  const httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(listenPort, listenHost, (error) => error ? reject(error) : resolve(server));
    server.once("error", reject);
  }).catch((error) => {
    releaseLock();
    throw error;
  });
  const channels = options.channels === false ? { close: async () => {} } : await startChannelServices({ config: loaded.config, paths, waitRegistry }).catch((error) => {
    process.stderr.write(`[catm] channel startup failed: ${error.message}\n`);
    return { close: async () => {} };
  });
  let closePromise = null;
  const onSignal = () => close().finally(() => process.exit(0));
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await channels.close();
      await Promise.allSettled([...transports.values()].map((entry) => entry.transport.close()));
      await new Promise((resolve) => {
        httpServer.close(resolve);
        httpServer.closeAllConnections?.();
      });
      releaseLock();
    })();
    return closePromise;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const actualPort = Number(httpServer.address()?.port || listenPort);
  process.stdout.write(`CATM 2.0 ready internally at http://127.0.0.1:${actualPort}/mcp\nPublic endpoints: ${publicUrls(loaded.config).join(", ")}\n`);
  return { httpServer, close, host: listenHost, port: actualPort, waitRegistry };
}

if (process.argv[1]?.endsWith("catm-daemon.mjs")) {
  startDaemon().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
