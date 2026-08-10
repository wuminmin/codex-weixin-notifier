#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catmPaths } from "./lib/catm-paths.mjs";
import { createClientCredential, loadConfig, newConfig, saveConfig } from "./lib/catm-config.mjs";
import { configureClient, detectedAgents, maskedAgentTemplate, updateClientEndpoint } from "./lib/client-config.mjs";
import { selectPort } from "./lib/port-selection.mjs";
import { startDaemon } from "./catm-daemon.mjs";
import { TenantStore } from "./lib/tenant-store.mjs";
import { destructiveLegacyCleanup } from "./lib/destructive-cleanup.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
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
  return `CATM 1.0

catm onboard [--port PORT] [--agents detected|all|codex,claude,opencode]
catm server start
catm server stop
catm server rebind --port PORT
catm agents configure [detected|all|codex,claude,opencode]
catm agents --print
catm bind-code
catm tenant list
catm channel weixin
catm channel feishu [--platform feishu|lark]`;
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

function daemonRunning(paths) {
  const pid = lockPid(paths);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function daemonPidIsCatm(pid) {
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/gu, " ");
    return /(?:^|\s)(?:[^\s/]+\/)?node(?:\s|$)/u.test(command) && /catm-daemon\.mjs/u.test(command);
  } catch { return false; }
}

async function configureAgents(config, types, options = {}) {
  const tenant = config.tenants[config.defaultTenantId];
  const files = [];
  for (const type of types) {
    const { token } = createClientCredential(config, type);
    files.push(configureClient(type, config, token, options));
  }
  return files;
}

async function onboard(args, options = {}) {
  const paths = options.paths || catmPaths(options);
  if (fs.existsSync(paths.configPath)) throw new Error(`CATM is already initialized: ${paths.configPath}`);
  if (!options.skipCleanup) destructiveLegacyCleanup({ home: options.home, tmpRoot: options.tmpRoot });
  const selected = await selectPort({ requestedPort: args.port });
  await new Promise((resolve) => selected.reservation.close(resolve));
  const config = newConfig({ port: selected.port });
  const verified = await startDaemon({ config, paths, channels: false });
  await verified.close();
  const types = selectedTypes(args.agents || "detected", options);
  const files = await configureAgents(config, types, options);
  saveConfig(config, { paths });
  if (options.startBackground !== false) {
    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "catm-daemon.mjs")], { detached: true, stdio: "ignore", env: options.env || process.env });
    child.unref();
  }
  process.stdout.write(`CATM initialized at http://127.0.0.1:${selected.port}/mcp\n`);
  process.stdout.write(`Configured agents: ${types.join(", ") || "none"}\n`);
  files.forEach((file) => process.stdout.write(`Updated ${file}\n`));
  return { config, types, files };
}

async function rebind(args, options = {}) {
  const paths = options.paths || catmPaths(options);
  if (daemonRunning(paths)) throw new Error("Stop CATM before rebinding: catm server stop");
  const { config } = loadConfig({ paths });
  const selected = await selectPort({ requestedPort: args.port });
  await new Promise((resolve) => selected.reservation.close(resolve));
  const previous = config.server.port;
  config.server.port = selected.port;
  const verified = await startDaemon({ config, paths, channels: false });
  await verified.close();
  const clientHome = options.home || os.homedir();
  const candidates = [
    paths.configPath,
    path.join(clientHome, ".codex", "config.toml"),
    path.join(clientHome, ".claude.json"),
    path.join(clientHome, ".config", "opencode", "opencode.json"),
    path.join(clientHome, ".config", "opencode", "opencode.jsonc"),
  ];
  const snapshots = new Map(candidates.filter((file) => fs.existsSync(file)).map((file) => [file, { data: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }]));
  try {
    for (const type of TYPES) updateClientEndpoint(type, config, options);
    saveConfig(config, { paths });
  } catch (error) {
    for (const [file, snapshot] of snapshots) { fs.writeFileSync(file, snapshot.data, { mode: snapshot.mode }); fs.chmodSync(file, snapshot.mode); }
    throw error;
  }
  process.stdout.write(`Rebound CATM from ${previous} to ${selected.port}. Start it with: catm server start\n`);
}

async function main(argv = process.argv.slice(2), options = {}) {
  const args = argsOf(argv);
  const [command, subcommand] = args._;
  const paths = options.paths || catmPaths(options);
  if (!command || command === "help" || args.help) return process.stdout.write(`${usage()}\n`);
  if (command === "onboard") return onboard(args, options);
  if (command === "server" && subcommand === "start") return startDaemon({ paths });
  if (command === "server" && subcommand === "stop") {
    const pid = lockPid(paths);
    if (!pid || !daemonRunning(paths)) throw new Error("CATM daemon is not running");
    if (!daemonPidIsCatm(pid)) throw new Error("Refusing to signal a process that is not CATM");
    process.kill(pid, "SIGTERM");
    process.stdout.write("CATM daemon stopping.\n");
    return;
  }
  if (command === "server" && subcommand === "rebind") return rebind(args, options);
  if (command === "agents" && args.print) {
    const { config } = loadConfig({ paths });
    return process.stdout.write(`${maskedAgentTemplate(config)}\n`);
  }
  if (command === "agents" && subcommand === "configure") {
    if (daemonRunning(paths)) throw new Error("Stop CATM before rotating client credentials");
    const loaded = loadConfig({ paths });
    const types = selectedTypes(args._[2] || "detected", options);
    const files = await configureAgents(loaded.config, types, options);
    saveConfig(loaded.config, { paths });
    files.forEach((file) => process.stdout.write(`Updated ${file}\n`));
    return;
  }
  if (command === "bind-code") {
    const { config } = loadConfig({ paths });
    const code = await new TenantStore({ paths, tenantId: config.defaultTenantId }).createBindingCode();
    process.stdout.write(`Binding code: ${code.code}\nExpires: ${code.expiresAt}\n`);
    return;
  }
  if (command === "tenant" && subcommand === "list") {
    const { config } = loadConfig({ paths });
    Object.values(config.tenants).forEach((tenant) => process.stdout.write(`${tenant.tenantId}\t${tenant.displayName}\t${tenant.enabled ? "enabled" : "disabled"}\n`));
    return;
  }
  if (command === "cleanup-legacy") {
    const result = destructiveLegacyCleanup({ home: options.home, tmpRoot: options.tmpRoot });
    process.stdout.write(`Removed ${result.removed.length} legacy paths${result.hooksRemoved ? " and legacy hooks" : ""}.\n`);
    return result;
  }
  if (command === "channel" && subcommand === "weixin") return (await import("./pair-weixin.mjs")).runPairWeixin(argv.slice(2), { paths });
  if (command === "channel" && subcommand === "feishu") return (await import("./setup-feishu.mjs")).runSetupFeishu(argv.slice(2), { paths });
  throw new Error(`Unknown command.\n${usage()}`);
}

export { main, onboard, rebind, selectedTypes };

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
