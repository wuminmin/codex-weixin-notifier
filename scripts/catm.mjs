#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { catmPaths } from "./lib/catm-paths.mjs";
import { addPublicUrl, createAccessToken, loadConfig, newConfig, normalizePublicUrl, publicUrls, removePublicUrl, saveConfig } from "./lib/catm-config.mjs";
import { configureClient, detectedAgents, disconnectClient } from "./lib/client-config.mjs";
import { startDaemon } from "./catm-daemon.mjs";
import { TenantStore } from "./lib/tenant-store.mjs";

const TYPES = ["codex", "claude", "opencode"];

function argsOf(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) result._.push(value);
    else if (!argv[i + 1] || argv[i + 1].startsWith("--")) result[value.slice(2)] = true;
    else result[value.slice(2)] = argv[++i];
  }
  return result;
}

function usage() {
  return `CATM 2.0

Server (NAS / Docker):
  catm init --public-url https://nas.example.ts.net/mcp
  catm server
  catm endpoint list
  catm endpoint add --url https://mcp.example.com/mcp
  catm endpoint remove --url https://mcp.example.com/mcp
  catm token rotate
  catm channel weixin
  catm channel feishu [--mode manual|qr]
  catm bind-code

Client (WSL / developer machine):
  catm connect --url https://nas.example.ts.net/mcp [--agents detected|all|codex,claude,opencode]
  catm disconnect [--agents detected|all|codex,claude,opencode]`;
}

function selectedTypes(value, options = {}) {
  if (!value || value === "detected") return detectedAgents(options);
  if (value === "all") return [...TYPES];
  const items = String(value).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!items.length || items.some((x) => !TYPES.includes(x))) throw new Error("agents must be detected, all, or a comma-separated list of codex,claude,opencode");
  return [...new Set(items)];
}

function lockPid(paths) {
  try { return Number(fs.readFileSync(paths.lockPath, "utf8").trim()); } catch { return 0; }
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function daemonPidIsCatm(pid) {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return /^node(?:js)?(?:\.exe)?$/iu.test(path.basename(argv[0] || ""))
      && path.basename(argv[1] || "") === "catm-daemon.mjs";
  } catch { return false; }
}

function stopLegacyDaemon(paths) {
  const pid = lockPid(paths);
  if (!pid || !processAlive(pid)) return false;
  if (!daemonPidIsCatm(pid)) throw new Error("Refusing to stop an unverified process from the legacy CATM lock");
  process.kill(pid, "SIGTERM");
  return true;
}

async function hidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); };
    const onData = (data) => { for (const char of data) {
      if (char === "\r" || char === "\n") { finish(); resolve(value.trim()); return; }
      if (char === "\u0003") { finish(); reject(new Error("Cancelled")); return; }
      if (char === "\u007f") value = value.slice(0, -1); else value += char;
    } };
    process.stdin.on("data", onData);
  });
}

async function verifyRemote(url, token, options = {}) {
  if (options.verifyRemote) return options.verifyRemote(url, token);
  const client = new Client({ name: "catm-connect", version: "2.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const required of ["sync_session", "notify_author", "notify_work_completed"]) {
      if (!names.has(required)) throw new Error(`remote CATM is missing ${required}`);
    }
    for (const removed of ["request_author_decision", "wait_author_decision"]) {
      if (names.has(removed)) throw new Error(`remote CATM still exposes deprecated ${removed}`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

async function initialize(args, options = {}) {
  const paths = options.paths || catmPaths(options);
  if (fs.existsSync(paths.configPath)) throw new Error(`CATM is already initialized: ${paths.configPath}`);
  const config = newConfig({ publicUrl: args["public-url"] });
  const credential = createAccessToken(config);
  saveConfig(config, { paths });
  process.stdout.write(`CATM 2.0 initialized.\nEndpoint: ${config.server.publicUrl}\nAccess token (shown once): ${credential.token}\n`);
  return { config, token: credential.token };
}

async function connect(args, options = {}) {
  const url = normalizePublicUrl(args.url);
  const token = options.token || await hidden("CATM access token (hidden): ");
  if (!token) throw new Error("access token is required");
  await verifyRemote(url, token, options);
  const types = selectedTypes(args.agents || "detected", options);
  if (!types.length) throw new Error("no supported agents detected; pass --agents explicitly");
  stopLegacyDaemon(options.paths || catmPaths(options));
  const files = types.map((type) => configureClient(type, url, token, options));
  process.stdout.write(`Connected ${types.join(", ")} to ${url}\n`);
  files.forEach((file) => process.stdout.write(`Updated ${file}\n`));
  return { url, types, files };
}

function disconnect(args, options = {}) {
  const types = selectedTypes(args.agents || "all", options);
  const files = types.map((type) => disconnectClient(type, options)).filter(Boolean);
  process.stdout.write(`Disconnected CATM from ${types.join(", ")}.\n`);
  return { types, files };
}

function rotateToken(options = {}) {
  const paths = options.paths || catmPaths(options);
  const pid = lockPid(paths);
  if (pid && processAlive(pid)) throw new Error("Stop the CATM service before rotating its access token");
  const loaded = loadConfig({ paths });
  const credential = createAccessToken(loaded.config);
  saveConfig(loaded.config, { paths });
  process.stdout.write(`Access token rotated (shown once): ${credential.token}\nRestart CATM and reconnect every client.\n`);
  return credential;
}

function endpoint(command, args, options = {}) {
  const paths = options.paths || catmPaths(options);
  const loaded = loadConfig({ paths });
  if (command === "list") {
    publicUrls(loaded.config).forEach((url) => process.stdout.write(`${url}\n`));
    return publicUrls(loaded.config);
  }
  const pid = lockPid(paths);
  if (pid && processAlive(pid)) throw new Error("Stop the CATM service before changing public endpoints");
  if (command === "add") {
    const changed = addPublicUrl(loaded.config, args.url);
    if (changed) saveConfig(loaded.config, { paths });
    process.stdout.write(changed ? `Added ${normalizePublicUrl(args.url)}. Restart CATM.\n` : `Endpoint already exists: ${normalizePublicUrl(args.url)}\n`);
    return { changed, urls: publicUrls(loaded.config) };
  }
  if (command === "remove") {
    const changed = removePublicUrl(loaded.config, args.url);
    if (changed) saveConfig(loaded.config, { paths });
    process.stdout.write(changed ? `Removed ${normalizePublicUrl(args.url)}. Restart CATM.\n` : `Endpoint not found: ${normalizePublicUrl(args.url)}\n`);
    return { changed, urls: publicUrls(loaded.config) };
  }
  throw new Error("endpoint command must be list, add, or remove");
}

async function main(argv = process.argv.slice(2), options = {}) {
  const args = argsOf(argv);
  const [command, subcommand] = args._;
  const paths = options.paths || catmPaths(options);
  if (!command || command === "help" || args.help) return process.stdout.write(`${usage()}\n`);
  if (command === "init") return initialize(args, { ...options, paths });
  if (command === "server" && !subcommand) return startDaemon({ paths });
  if (command === "connect") return connect(args, { ...options, paths });
  if (command === "disconnect") return disconnect(args, { ...options, paths });
  if (command === "endpoint") return endpoint(subcommand, args, { ...options, paths });
  if (command === "token" && subcommand === "rotate") return rotateToken({ ...options, paths });
  if (command === "bind-code") {
    const { config } = loadConfig({ paths });
    const code = await new TenantStore({ paths, tenantId: config.defaultTenantId }).createBindingCode();
    process.stdout.write(`Binding code: ${code.code}\nExpires: ${code.expiresAt}\n`);
    return code;
  }
  if (command === "channel" && subcommand === "weixin") return (await import("./pair-weixin.mjs")).runPairWeixin(argv.slice(2), { paths });
  if (command === "channel" && subcommand === "feishu") return (await import("./setup-feishu.mjs")).runSetupFeishu(argv.slice(2), { paths });
  throw new Error(`Unknown command.\n${usage()}`);
}

export { daemonPidIsCatm, endpoint, initialize, connect, disconnect, main, rotateToken, selectedTypes, stopLegacyDaemon };

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isMainModule()) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
