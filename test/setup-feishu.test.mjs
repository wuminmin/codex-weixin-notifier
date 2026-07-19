import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSetupFeishu } from "../scripts/setup-feishu.mjs";

function configFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notifier-setup-"));
  const configPath = path.join(dir, "codex-notifier.json");
  fs.writeFileSync(configPath, '{"version":1,"defaults":{},"channels":{}}\n', { mode: 0o600 });
  return configPath;
}

test("manual setup saves credentials with mode 0600", async () => {
  const configPath = configFixture();
  await runSetupFeishu(["--config", configPath, "--account", "company-a", "--bot", "main", "--mode", "manual"], {
    credentials: { appId: "cli_manual", appSecret: "secret" },
  });
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(config.channels.feishu.accounts["company-a"].bots.main.appId, "cli_manual");
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test("reconfiguring credentials preserves existing notification targets", async () => {
  const configPath = configFixture();
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.channels.feishu = { accounts: { a: { bots: { b: {
    appId: "cli_old",
    appSecret: "old",
    notifyTargets: [{ id: "ops", chatId: "oc_ops" }],
  } } } } };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  await runSetupFeishu(["--config", configPath, "--account", "a", "--bot", "b", "--mode", "manual"], {
    credentials: { appId: "cli_new", appSecret: "new" },
  });
  const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(updated.channels.feishu.accounts.a.bots.b.notifyTargets, [{ id: "ops", chatId: "oc_ops" }]);
});

test("QR setup requests bot messaging, media, and message event capabilities", async () => {
  const configPath = configFixture();
  let registrationOptions;
  await runSetupFeishu(["--config", configPath, "--account", "company-a", "--bot", "qr", "--mode", "qr"], {
    registerApp: async (options) => {
      registrationOptions = options;
      options.onQRCodeReady({ url: "https://example.invalid/qr", expireIn: 600 });
      return { client_id: "cli_qr", client_secret: "secret", user_info: { tenant_brand: "feishu" } };
    },
  });
  assert.equal(registrationOptions.createOnly, true);
  assert.equal(registrationOptions.domain, "accounts.feishu.cn");
  assert.equal(registrationOptions.larkDomain, "accounts.larksuite.com");
  assert.ok(registrationOptions.addons.scopes.tenant.includes("im:message:send_as_bot"));
  assert.ok(registrationOptions.addons.scopes.tenant.includes("im:resource"));
  assert.ok(registrationOptions.addons.scopes.tenant.includes("im:message.group_at_msg:readonly"));
  assert.ok(registrationOptions.addons.scopes.tenant.includes("im:message.p2p_msg:readonly"));
  assert.deepEqual(registrationOptions.addons.events.items.tenant, ["im.message.receive_v1"]);
});

test("QR setup supports Lark tenants and writes platform", async () => {
  const configPath = configFixture();
  let registrationOptions;
  await runSetupFeishu(["--config", configPath, "--account", "global-a", "--bot", "main", "--platform", "lark", "--mode", "qr"], {
    registerApp: async (options) => {
      registrationOptions = options;
      options.onQRCodeReady({ url: "https://example.invalid/lark", expireIn: 600 });
      return { client_id: "cli_lark", client_secret: "secret", user_info: { tenant_brand: "lark" } };
    },
  });
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(registrationOptions.domain, "accounts.larksuite.com");
  assert.equal(config.channels.feishu.accounts["global-a"].bots.main.platform, "lark");
});

test("QR setup refuses mismatched Feishu/Lark tenant brand before writing credentials", async () => {
  const configPath = configFixture();
  await assert.rejects(
    runSetupFeishu(["--config", configPath, "--account", "global-a", "--bot", "main", "--platform", "lark", "--mode", "qr"], {
      registerApp: async (options) => {
        options.onQRCodeReady({ url: "https://example.invalid/feishu", expireIn: 600 });
        return { client_id: "cli_wrong", client_secret: "secret", user_info: { tenant_brand: "feishu" } };
      },
    }),
    /Scanned tenant is Feishu/u,
  );
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(config.channels.feishu, undefined);
});

test("check connects and disconnects the selected bot", async () => {
  const configPath = configFixture();
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.channels.feishu = { accounts: { a: { bots: { b: { appId: "cli_check", appSecret: "s" } } } } };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const channel = {
    botIdentity: { name: "Check Bot", openId: "ou_check" },
    connected: false,
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
  };
  await runSetupFeishu(["--config", configPath, "--account", "a", "--bot", "b", "--check"], { channel });
  assert.equal(channel.connected, false);
});
