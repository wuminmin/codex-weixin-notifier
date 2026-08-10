import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const OLD_TMUX = ["codex-wx-router", "codex-wx-tool-notifier"];

export function isLegacyTmuxName(name) {
  const value = String(name || "");
  return OLD_TMUX.includes(value)
    || /^codex-wx-task-\d+(?:-(?:wxrun|wxr)-[A-Za-z0-9_-]+)?$/u.test(value)
    || /^codex-(?:fs|nt)-[A-Za-z0-9]+-task-\d+(?:-(?:wxrun|wxr)-[A-Za-z0-9_-]+)?$/u.test(value)
    || /^codex-wx-tool-[A-Za-z0-9_-]+-(?:codex|claude|opencode)-\d+$/u.test(value)
    || /^codex-wx-hook-\d+-\d+$/u.test(value);
}

function stopLegacyTmux() {
  const listed = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  const names = listed.status === 0 ? String(listed.stdout || "").split(/\r?\n/u).filter(isLegacyTmuxName) : OLD_TMUX;
  for (const name of names) spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
}

function recordedAttachmentDirs(home) {
  const registry = path.join(home, ".codex", "weixin-notifier", "tasks.json");
  let state;
  try { state = JSON.parse(fs.readFileSync(registry, "utf8")); } catch { return []; }
  const expectedRoot = path.join(home, "codex");
  return Object.values(state.tasks || {}).map((task) => task?.dataDir).filter((value) => {
    if (!value) return false;
    const resolved = path.resolve(String(value).replace(/^~(?=\/)/u, home));
    return path.dirname(resolved) === expectedRoot && /^task\d+$/u.test(path.basename(resolved));
  });
}

function validatedTarget(target, home, tmpRoot) {
  const resolved = path.resolve(target);
  const allowedRoots = [path.resolve(home), path.resolve(tmpRoot)];
  if (!allowedRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))) throw new Error(`Refusing unsafe legacy path: ${resolved}`);
  if (!fs.existsSync(resolved)) return resolved;
  if (fs.lstatSync(resolved).uid !== process.getuid()) throw new Error(`Refusing legacy path not owned by current user: ${resolved}`);
  return resolved;
}

function removeLegacyHooks(configPath) {
  if (!fs.existsSync(configPath)) return false;
  const original = fs.readFileSync(configPath, "utf8");
  const starts = [...original.matchAll(/^\[\[hooks\.[^.\]]+\]\]\s*$/gmu)].map((match) => match.index);
  let cursor = 0;
  let next = "";
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? original.length;
    next += original.slice(cursor, start);
    const group = original.slice(start, end);
    const trailingTable = group.search(/^\[(?!\[hooks\.)[^\n]+\]\s*$/mu);
    const hookPart = trailingTable >= 0 ? group.slice(0, trailingTable) : group;
    const suffix = trailingTable >= 0 ? group.slice(trailingTable) : "";
    if (!/codex-(?:task-state|finish)-hook\.mjs/u.test(hookPart)) next += hookPart;
    next += suffix;
    cursor = end;
  }
  next += original.slice(cursor);
  if (next === original) return false;
  fs.writeFileSync(configPath, next, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return true;
}

export function destructiveLegacyCleanup(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const tmpRoot = path.resolve(options.tmpRoot || os.tmpdir());
  if (options.stopTmux !== false) stopLegacyTmux();
  const attachmentDirs = recordedAttachmentDirs(home);
  const targets = [
    path.join(home, ".codex", "codex-notifier.json"),
    path.join(home, ".codex", "codex-notifier"),
    path.join(home, ".codex", "weixin-notifier.json"),
    path.join(home, ".codex", "weixin-notifier"),
    path.join(home, ".codex", "channels", "wechat"),
    path.join(home, ".codex", "plugins", "coding-agent-task-monitor"),
    path.join(tmpRoot, "codex-weixin-notifier-hook.log"),
    path.join(tmpRoot, "codex-weixin-notifier-hooks"),
    ...attachmentDirs,
  ];
  const removed = [];
  for (const target of targets) {
    const safe = validatedTarget(target, home, tmpRoot);
    if (!fs.existsSync(safe)) continue;
    fs.rmSync(safe, { recursive: true, force: true });
    removed.push(safe);
  }
  const hookConfig = path.join(home, ".codex", "config.toml");
  return { removed, hooksRemoved: removeLegacyHooks(hookConfig) };
}

export { OLD_TMUX };
