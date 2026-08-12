import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { catmPaths } from "./catm-paths.mjs";
import { readJson, writeJson, ensurePrivateDir } from "./atomic-json.mjs";

const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
export const SERVER_HOST = "0.0.0.0";
export const SERVER_PORT = 61937;
export const DEFAULT_CREDENTIAL_ID = "shared-access";

export function validateTenantId(value) {
  if (!TENANT_ID.test(String(value || ""))) throw new Error("tenant_id must be a lowercase slug of at most 64 characters");
  return String(value);
}

export function normalizePublicUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("public URL must be a valid HTTPS URL ending in /mcp"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new Error("public URL must be an HTTPS origin followed by /mcp, without credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/u, "");
}

export function publicUrls(config) {
  const values = Array.isArray(config?.server?.publicUrls) && config.server.publicUrls.length
    ? config.server.publicUrls
    : [config?.server?.publicUrl];
  return [...new Set(values.map(normalizePublicUrl))];
}

export function addPublicUrl(config, value) {
  const normalized = normalizePublicUrl(value);
  const urls = publicUrls(config);
  if (urls.includes(normalized)) return false;
  config.server.publicUrls = [...urls, normalized];
  config.server.publicUrl = config.server.publicUrls[0];
  return true;
}

export function removePublicUrl(config, value) {
  const normalized = normalizePublicUrl(value);
  const urls = publicUrls(config);
  if (!urls.includes(normalized)) return false;
  if (urls.length === 1) throw new Error("CATM must keep at least one public MCP URL");
  config.server.publicUrls = urls.filter((url) => url !== normalized);
  config.server.publicUrl = config.server.publicUrls[0];
  return true;
}

export function newConfig({ tenantId = "default", tenantName = "Default", publicUrl } = {}) {
  const id = validateTenantId(tenantId);
  return {
    version: 2,
    server: {
      host: SERVER_HOST,
      port: SERVER_PORT,
      publicUrl: normalizePublicUrl(publicUrl),
      publicUrls: [normalizePublicUrl(publicUrl)],
      maxBodyBytes: 262_144,
      maxConnections: 128,
    },
    defaultTenantId: id,
    tenants: {
      [id]: {
        tenantId: id,
        displayName: String(tenantName || "Default"),
        enabled: true,
        createdAt: new Date().toISOString(),
        authors: {},
        channels: {},
        clientCredentials: {},
      },
    },
  };
}

export function validateConfig(config) {
  if (!config || config.version !== 2) throw new Error("CATM 2.0 requires config schema version 2; initialize a fresh NAS deployment with `catm init`");
  if (config.server?.host !== SERVER_HOST || config.server?.port !== SERVER_PORT) {
    throw new Error(`CATM server must listen on ${SERVER_HOST}:${SERVER_PORT}`);
  }
  config.server.publicUrls = publicUrls(config);
  config.server.publicUrl = config.server.publicUrls[0];
  const ids = Object.keys(config.tenants || {});
  if (ids.length < 1) throw new Error("CATM config requires at least one tenant");
  const id = validateTenantId(config.defaultTenantId);
  if (!config.tenants[id] || config.tenants[id].tenantId !== id) throw new Error("default tenant is inconsistent");
  for (const [tenantId, tenant] of Object.entries(config.tenants)) {
    validateTenantId(tenantId);
    if (tenant.tenantId !== tenantId) throw new Error(`tenant is inconsistent: ${tenantId}`);
  }
  return config;
}

export function loadConfig(options = {}) {
  const paths = options.paths || catmPaths(options);
  const config = readJson(options.configPath || paths.configPath);
  if (!config) throw new Error(`CATM is not initialized: ${options.configPath || paths.configPath}`);
  return { config: validateConfig(config), paths };
}

export function saveConfig(config, options = {}) {
  const paths = options.paths || catmPaths(options);
  ensurePrivateDir(paths.configDir);
  return writeJson(options.configPath || paths.configPath, validateConfig(config), 0o600);
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function createAccessToken(config, tenantId = config.defaultTenantId, credentialId = DEFAULT_CREDENTIAL_ID) {
  validateTenantId(tenantId);
  const tenant = config.tenants[tenantId];
  if (!tenant?.enabled) throw new Error(`tenant not found: ${tenantId}`);
  const token = crypto.randomBytes(32).toString("base64url");
  tenant.clientCredentials ||= {};
  tenant.clientCredentials[credentialId] = {
    credentialId,
    tenantId,
    tokenHash: hashToken(token),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  return { credentialId, tenantId, token };
}

export function resolveCredential(config, authorization) {
  const match = /^Bearer\s+(.+)$/iu.exec(String(authorization || ""));
  if (!match) return null;
  const candidate = Buffer.from(hashToken(match[1]));
  for (const tenant of Object.values(config.tenants)) {
    for (const credential of Object.values(tenant.clientCredentials || {})) {
      if (!credential.enabled) continue;
      const expected = Buffer.from(String(credential.tokenHash || ""));
      if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) return credential;
    }
  }
  return null;
}

export function tenantStateDir(paths, tenantId) {
  return path.join(paths.tenantRoot, validateTenantId(tenantId));
}

export function assertPrivateConfig(filePath) {
  const mode = fs.statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`CATM config must not be group/world accessible: ${filePath}`);
}
