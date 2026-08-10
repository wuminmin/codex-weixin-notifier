---
name: weixin-notifier
description: Configure and test the CATM 1.0 shared MCP server, Weixin, Feishu/Lark author channels, tenant bindings, and phone session commands.
---

# CATM 1.0 author control

Use this skill for CATM onboarding, MCP client configuration, author-channel pairing, binding, session control, decision delivery, and completion delivery.

## Invariants

- CATM is one Streamable HTTP MCP daemon on `127.0.0.1` with an installation-selected private port.
- Never suggest port 3765 or any fixed default.
- Codex, Claude Code, and opencode use built-in MCP clients and independent bearer credentials.
- Never print or log bearer tokens, channel tokens, or app secrets.
- Server config is only `~/.config/catm/config.json`; do not read legacy notifier paths or environment variables.
- The initialized tenant is `default`, with `author/default`; tools cannot choose a tenant.
- A session is the only user-visible management unit. Do not introduce tasks, task numbers, hooks, pollers, or stdio MCP.
- Mobile control commands are English only. Chinese and other languages are valid instruction text, not control aliases.

## Commands

Onboard and daemon:

```bash
catm onboard --agents all
catm onboard --port 61937 --agents codex
catm server start
catm server stop
catm server rebind --port 62001
catm agents configure all
catm agents --print
```

Channels and binding:

```bash
catm channel weixin
catm channel feishu --platform feishu --mode manual
catm channel feishu --platform lark --mode qr
catm bind-code
```

After channel setup, restart the daemon. The author sends `bind <code>` from the phone channel.

Phone commands: `sessions`, `active`, `current`, `use S12`, `send S12 <text>`, `inbox S12`, `decisions S12`, `decide ABC <answer>`, `new`, `new claude`, `new opencode`, `close S12`, `snap S12`, `status`, `bind <code>`, and `help`.

## MCP behavior

Agents call `sync_session` at work start, around major stages and decisions, after verification, before completion, and about every five minutes. Each author question gets a separate `request_author_decision` call and idempotency key, followed by `wait_author_decision`. The agent calls `notify_work_completed` once per returned `work_cycle_id`.

When diagnosing, use `/health`, check mode `0600` on the config, verify the daemon listens only on the configured loopback port, and inspect tenant-scoped state without exposing secrets. Never silently change the port after a conflict; use `catm server rebind`.
