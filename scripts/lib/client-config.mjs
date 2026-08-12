import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { ensurePrivateDir, readJson, writeJson } from "./atomic-json.mjs";
import { normalizePublicUrl } from "./catm-config.mjs";

const TYPES = ["codex", "claude", "opencode"];
const PROMPT_START = "<!-- CATM-2.0-START -->";
const PROMPT_END = "<!-- CATM-2.0-END -->";
const PROMPT = `${PROMPT_START}
## CATM author control

Use the configured \`catm\` MCP server for this coding session. Call \`sync_session\` when work begins, after major stages, before and after author decisions, after verification, before completion, and about every five minutes during continuous work. Keep the returned \`session_id\` and \`work_cycle_id\` for this conversation.

When progress requires a genuine author decision, call \`request_author_decision\` with a new idempotency key, then keep one \`wait_author_decision\` call active until it returns an answer. After an answer, call \`sync_session\` again. If the wait connection ends while still pending, tell the author that reopening the agent is required; the answer remains durable on CATM.

Treat instructions returned by \`sync_session\` as author messages and acknowledge their ids on the next sync. Before final delivery, draft the exact complete user-visible final response, call \`notify_work_completed\` exactly once for the current work cycle with that response unchanged in \`summary\`, then send the same response to the user without edits. The server adds the agent, session, work-cycle, workspace, and task identity header; do not add that header to \`summary\`. The optional \`verification\` field is internal metadata and is not rendered in the author notification. Never send credentials, secrets, full logs, or unnecessary source text through CATM.
${PROMPT_END}`;

function writePrivateText(file, text) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

function home(options) { return options.home || os.homedir(); }

function replaceTomlBlock(text, block = "") {
  const pattern = /(?:^|\n)\[mcp_servers\.catm\]\n[\s\S]*?(?=\n\[[^\n]+\]|$)/u;
  const clean = text.replace(pattern, "").trimEnd();
  return `${clean}${clean && block ? "\n\n" : ""}${block}${block ? "\n" : clean ? "\n" : ""}`;
}

function writeCodex(url, token, options) {
  const file = path.join(home(options), ".codex", "config.toml");
  let existing = "";
  try { existing = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const block = `[mcp_servers.catm]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }\ntool_timeout_sec = 21630`;
  writePrivateText(file, replaceTomlBlock(existing, block));
  writeAgentPrompt("codex", options);
  return file;
}

function writeClaude(url, token, options) {
  const file = path.join(home(options), ".claude.json");
  const value = readJson(file, {});
  value.mcpServers ||= {};
  value.mcpServers.catm = { type: "http", url, headers: { Authorization: `Bearer ${token}` }, timeout: 21_630_000 };
  writeAgentPrompt("claude", options);
  return writeJson(file, value, 0o600);
}

function openCodeFile(options) {
  const root = path.join(home(options), ".config", "opencode");
  const jsonc = path.join(root, "opencode.jsonc");
  return fs.existsSync(jsonc) ? jsonc : path.join(root, "opencode.json");
}

function writeOpenCode(url, token, options) {
  const file = openCodeFile(options);
  let source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const errors = [];
  parseJsonc(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`Invalid OpenCode JSON/JSONC config: ${file}`);
  const entry = {
    type: "remote", url, oauth: false, codemode: false,
    headers: { Authorization: `Bearer ${token}` },
    timeout: { startup: 30_000, catalog: 30_000, execution: 21_630_000 },
  };
  source = applyEdits(source, modify(source, ["mcp", "servers", "catm"], entry, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  writeAgentPrompt("opencode", options);
  return writePrivateText(file, source);
}

function promptFile(type, options = {}) {
  return type === "codex" ? path.join(home(options), ".codex", "AGENTS.md")
    : type === "claude" ? path.join(home(options), ".claude", "CLAUDE.md")
      : path.join(home(options), ".config", "opencode", "AGENTS.md");
}

function writeAgentPrompt(type, options = {}) {
  const file = promptFile(type, options);
  let current = "";
  try { current = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const oldPattern = /<!-- CATM-(?:1\.0|2\.0)-START -->[\s\S]*?<!-- CATM-(?:1\.0|2\.0)-END -->/u;
  const next = oldPattern.test(current) ? current.replace(oldPattern, PROMPT) : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${PROMPT}\n`;
  return writePrivateText(file, next);
}

function removeAgentPrompt(type, options = {}) {
  const file = promptFile(type, options);
  if (!fs.existsSync(file)) return null;
  const current = fs.readFileSync(file, "utf8");
  const next = current.replace(/(?:^|\n)<!-- CATM-(?:1\.0|2\.0)-START -->[\s\S]*?<!-- CATM-(?:1\.0|2\.0)-END -->\n?/u, "\n").trim();
  writePrivateText(file, next ? `${next}\n` : "");
  return file;
}

export function detectedAgents(options = {}) {
  const root = home(options);
  return TYPES.filter((type) => {
    const candidates = type === "codex" ? [".codex"] : type === "claude" ? [".claude", ".claude.json"] : [path.join(".config", "opencode")];
    return candidates.some((candidate) => fs.existsSync(path.join(root, candidate)));
  });
}

export function configureClient(type, publicUrl, token, options = {}) {
  const url = normalizePublicUrl(publicUrl);
  if (!token) throw new Error("access token is required");
  if (type === "codex") return writeCodex(url, token, options);
  if (type === "claude") return writeClaude(url, token, options);
  if (type === "opencode") return writeOpenCode(url, token, options);
  throw new Error(`Unsupported MCP client type: ${type}`);
}

export function disconnectClient(type, options = {}) {
  let file = null;
  if (type === "codex") {
    file = path.join(home(options), ".codex", "config.toml");
    if (fs.existsSync(file)) writePrivateText(file, replaceTomlBlock(fs.readFileSync(file, "utf8")));
  } else if (type === "claude") {
    file = path.join(home(options), ".claude.json");
    if (fs.existsSync(file)) {
      const value = readJson(file, {});
      if (value.mcpServers) delete value.mcpServers.catm;
      writeJson(file, value, 0o600);
    }
  } else if (type === "opencode") {
    file = openCodeFile(options);
    if (fs.existsSync(file)) {
      const source = fs.readFileSync(file, "utf8");
      const next = applyEdits(source, modify(source, ["mcp", "servers", "catm"], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      writePrivateText(file, next);
    }
  } else throw new Error(`Unsupported MCP client type: ${type}`);
  removeAgentPrompt(type, options);
  return fs.existsSync(file || "") ? file : null;
}

export { PROMPT as CATM_AGENT_PROMPT };
