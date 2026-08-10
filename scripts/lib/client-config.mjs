import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { ensurePrivateDir, readJson, writeJson } from "./atomic-json.mjs";

const TYPES = ["codex", "claude", "opencode"];
const PROMPT_START = "<!-- CATM-1.0-START -->";
const PROMPT_END = "<!-- CATM-1.0-END -->";
const PROMPT = `${PROMPT_START}
## CATM author control

Use the configured \`catm\` MCP server for this coding session. Call \`sync_session\` when work begins, after major stages, before and after author decisions, after verification, before completion, and about every five minutes during continuous work. Keep the returned \`session_id\` and \`work_cycle_id\` for this conversation.

When progress requires a genuine author decision, call \`request_author_decision\` with a new idempotency key for that question, then \`wait_author_decision\`. A conversation may require multiple independent decisions. After an answer, call \`sync_session\` again. Do not ask for decisions that safe repository inspection can resolve.

Treat instructions returned by \`sync_session\` as author messages and acknowledge their ids on the next sync. Before final delivery, call \`notify_work_completed\` exactly once for the current work cycle. Never send credentials, secrets, full logs, or unnecessary source text through CATM.
${PROMPT_END}`;

function endpoint(config) {
  return `http://${config.server.host}:${config.server.port}/mcp`;
}

function writePrivateText(file, text) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

function home(options) { return options.home || os.homedir(); }

function replaceTomlBlock(text, block) {
  const pattern = /(?:^|\n)\[mcp_servers\.catm\]\n[\s\S]*?(?=\n\[[^\n]+\]|$)/u;
  const clean = text.replace(pattern, "").trimEnd();
  return `${clean}${clean ? "\n\n" : ""}${block}\n`;
}

function writeCodex(config, token, options) {
  const file = path.join(home(options), ".codex", "config.toml");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const block = `[mcp_servers.catm]\nurl = "${endpoint(config)}"\nhttp_headers = { Authorization = "Bearer ${token}" }\ntool_timeout_sec = 21630`;
  writePrivateText(file, replaceTomlBlock(text, block));
  writeAgentPrompt("codex", options);
  return file;
}

function writeClaude(config, token, options) {
  const file = path.join(home(options), ".claude.json");
  const value = readJson(file, {});
  value.mcpServers ||= {};
  value.mcpServers.catm = { type: "http", url: endpoint(config), headers: { Authorization: `Bearer ${token}` }, timeout: 21_630_000 };
  writeAgentPrompt("claude", options);
  return writeJson(file, value, 0o600);
}

function writeOpenCode(config, token, options) {
  const root = path.join(home(options), ".config", "opencode");
  const jsonc = path.join(root, "opencode.jsonc");
  const file = fs.existsSync(jsonc) ? jsonc : path.join(root, "opencode.json");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const entry = {
    type: "remote",
    url: endpoint(config),
    oauth: false,
    codemode: false,
    headers: { Authorization: `Bearer ${token}` },
    timeout: { startup: 30_000, catalog: 30_000, execution: 21_630_000 },
  };
  const errors = [];
  parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`Invalid OpenCode JSON/JSONC config: ${file}`);
  text = applyEdits(text, modify(text, ["mcp", "servers", "catm"], entry, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  writeAgentPrompt("opencode", options);
  writePrivateText(file, text);
  return file;
}

function writeAgentPrompt(type, options = {}) {
  const file = type === "codex" ? path.join(home(options), ".codex", "AGENTS.md")
    : type === "claude" ? path.join(home(options), ".claude", "CLAUDE.md")
      : path.join(home(options), ".config", "opencode", "AGENTS.md");
  let current = "";
  try { current = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const pattern = new RegExp(`${PROMPT_START}[\\s\\S]*?${PROMPT_END}`, "u");
  const next = pattern.test(current) ? current.replace(pattern, PROMPT) : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${PROMPT}\n`;
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, next, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function detectedAgents(options = {}) {
  const root = home(options);
  return TYPES.filter((type) => {
    const candidates = type === "codex" ? [".codex"] : type === "claude" ? [".claude", ".claude.json"] : [path.join(".config", "opencode")];
    return candidates.some((candidate) => fs.existsSync(path.join(root, candidate)));
  });
}

export function configureClient(type, config, token, options = {}) {
  if (type === "codex") return writeCodex(config, token, options);
  if (type === "claude") return writeClaude(config, token, options);
  if (type === "opencode") return writeOpenCode(config, token, options);
  throw new Error(`Unsupported MCP client type: ${type}`);
}

export function updateClientEndpoint(type, config, options = {}) {
  if (type === "codex") {
    const file = path.join(home(options), ".codex", "config.toml");
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    const next = text.replace(/(\[mcp_servers\.catm\][\s\S]*?\nurl\s*=\s*")[^"]+("[^\n]*\n)/u, `$1${endpoint(config)}$2`);
    if (next === text) return null;
    writePrivateText(file, next); return file;
  }
  const openCodeRoot = path.join(home(options), ".config", "opencode");
  const file = type === "claude" ? path.join(home(options), ".claude.json")
    : fs.existsSync(path.join(openCodeRoot, "opencode.jsonc")) ? path.join(openCodeRoot, "opencode.jsonc") : path.join(openCodeRoot, "opencode.json");
  if (!fs.existsSync(file)) return null;
  if (type === "opencode") {
    const text = fs.readFileSync(file, "utf8");
    const value = parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false });
    if (!value?.mcp?.servers?.catm) return null;
    const next = applyEdits(text, modify(text, ["mcp", "servers", "catm", "url"], endpoint(config), { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    writePrivateText(file, next); return file;
  }
  const value = readJson(file);
  const entry = value?.mcpServers?.catm;
  if (!entry) return null;
  entry.url = endpoint(config);
  return writeJson(file, value, 0o600);
}

export function maskedAgentTemplate(config) {
  return TYPES.map((type) => `${type}: ${endpoint(config)}  Authorization: Bearer <redacted-${type}-token>`).join("\n");
}
