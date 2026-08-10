import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function loadTmuxBuffer(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", ["load-buffer", "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => { errorText += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(errorText.trim() || `tmux load-buffer exited ${code}`)));
    child.stdin.end(`${text}\n`);
  });
}

function commandFor(agent) {
  if (agent !== "opencode") return agent === "claude" ? "claude" : "codex";
  for (const command of ["opencode2", "opencode"]) {
    const found = String(process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, command)).find((file) => {
      try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
    });
    if (found) return found;
  }
  return "opencode";
}

export function managedSessionOperations({ store, workspace = process.cwd(), health } = {}) {
  return {
    async createSession(agent) {
      const tmuxName = `catm-${crypto.randomBytes(8).toString("hex")}`;
      const cwd = path.resolve(workspace);
      const session = await store.createManagedSession({ agent, workspace: cwd, label: `${agent} · ${path.basename(cwd)}`, tmuxName });
      try {
        await exec("tmux", ["new-session", "-d", "-s", tmuxName, "-c", cwd, commandFor(agent)]);
        return session;
      } catch (error) {
        await store.closeSession(session.sessionId).catch(() => {});
        throw error;
      }
    },
    async inject(session, text) {
      await loadTmuxBuffer(text);
      await exec("tmux", ["paste-buffer", "-d", "-t", session.tmuxName]);
    },
    async close(session) {
      if (session.managed && session.tmuxName) await exec("tmux", ["kill-session", "-t", session.tmuxName]).catch(() => {});
    },
    async snapshot(session) {
      const { stdout } = await exec("tmux", ["capture-pane", "-p", "-S", "-120", "-t", session.tmuxName], { maxBuffer: 256 * 1024 });
      const text = stdout.trim();
      return text.length > 7000 ? text.slice(-7000) : (text || "Session pane is empty.");
    },
    async status() {
      return health ? await health() : "CATM is ready.";
    },
  };
}
