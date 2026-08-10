import os from "node:os";
import path from "node:path";

function xdg(name, fallback) {
  const value = process.env[name];
  return value ? path.resolve(value) : path.join(os.homedir(), fallback);
}

export function catmPaths(overrides = {}) {
  const configHome = overrides.configHome || xdg("XDG_CONFIG_HOME", ".config");
  const dataHome = overrides.dataHome || xdg("XDG_DATA_HOME", ".local/share");
  const stateHome = overrides.stateHome || xdg("XDG_STATE_HOME", ".local/state");
  const configDir = path.join(configHome, "catm");
  const dataDir = path.join(dataHome, "catm");
  const stateDir = path.join(stateHome, "catm");
  return {
    configHome,
    dataHome,
    stateHome,
    configDir,
    configPath: path.join(configDir, "config.json"),
    dataDir,
    stateDir,
    tenantRoot: path.join(stateDir, "tenants"),
    runtimeDir: path.join(stateDir, "runtime"),
    lockPath: path.join(stateDir, "runtime", "daemon.lock"),
    logPath: path.join(stateDir, "catm.log"),
  };
}

