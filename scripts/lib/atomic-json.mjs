import fs from "node:fs";
import path from "node:path";

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJson(filePath, value, mode = 0o600) {
  ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, mode); } catch {}
  return filePath;
}

export async function withFileLock(lockPath, fn, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 5000);
  const staleMs = Number(options.staleMs || 30000);
  const started = Date.now();
  ensurePrivateDir(path.dirname(lockPath));
  while (true) {
    let handle;
    try {
      handle = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(handle, `${process.pid}\n${Date.now()}\n`);
      try { return await fn(); }
      finally {
        try { fs.closeSync(handle); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring state lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

