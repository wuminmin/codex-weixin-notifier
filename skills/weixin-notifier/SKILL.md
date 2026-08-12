---
name: weixin-notifier
description: Configure and test the CATM 2.0 NAS-hosted MCP service, remote coding-agent clients, Weixin or Feishu author channels, direct decision replies, and durable waits.
---

# CATM 2.0 NAS author control

Use this skill for NAS deployment, remote MCP client connection, author-channel pairing, decision delivery, direct phone replies, and completion delivery.

## Invariants

- CATM runs only on the NAS in Docker Compose. Never start a CATM daemon in WSL or on a developer laptop.
- Compose maps container port `61937` only to NAS loopback. Tailscale Serve provides the tailnet-only HTTPS endpoint; never recommend Funnel or public exposure.
- Codex, Claude Code, and opencode use their built-in remote Streamable HTTP clients and one shared bearer token. Never print an existing token; initialization and rotation show a new token once.
- Server config is schema v2 and lives in the Docker data volume. Do not migrate v1 state automatically.
- Tenant isolation remains internal. Do not ask MCP callers or normal operators to provide tenant ids.
- A session is the only user-visible unit. Do not introduce tasks, hooks, pollers, tmux-managed sessions, or stdio MCP.
- Explicit control commands are English. Other text is either a direct decision answer or a remote instruction.
- A stored answer survives disconnects and service restarts, but CATM cannot wake an agent whose MCP wait call has already ended.

## Deployment and client commands

```bash
docker compose build
docker compose run --rm catm init --public-url https://nas.tailnet.ts.net/mcp
docker compose up -d
sudo tailscale serve --bg http://127.0.0.1:61937

catm connect --url https://nas.tailnet.ts.net/mcp --agents all
catm disconnect --agents all
```

Verify remote health before configuring a client. `catm connect` itself validates the MCP tool catalog before writing files.

## Channels and binding

```bash
docker compose exec catm catm channel weixin
docker compose exec catm catm channel feishu --mode manual
docker compose restart catm
docker compose exec catm catm bind-code
```

The author sends `bind <code>` from the phone channel. Phone commands are `sessions`, `use S12`, `send S12 <text>`, `decide ABC <answer>`, `close S12`, `status`, `bind <code>`, and `help`.

When a decision notification is the latest pending decision for that phone conversation, ordinary text answers it directly. The bot must confirm whether an active Claude wait was resumed or whether the agent must be reopened. Use `decide <code> <answer>` to target a decision explicitly.

## MCP behavior and diagnosis

Agents call `sync_session` at work start, around major stages and decisions, after verification, before completion, and about every five minutes. Each author question gets a separate `request_author_decision` and idempotency key, followed by one active `wait_author_decision`. The agent calls `notify_work_completed` once per returned `work_cycle_id`.

An active wait emits a heartbeat every 15 seconds and polls durable state every five seconds. A timeout returns `pending`, not an invented answer. After a phone answer, verify all three layers without exposing content or secrets:

1. The decision status is `answered` in the tenant registry.
2. The phone received either the active-wait or reopen-agent confirmation.
3. If the wait was active, the tool returned `wait_status: answered`.

For operations, check `docker compose ps`, `/health`, `docker compose logs`, and `tailscale serve status`. Verify the NAS host exposes CATM only through loopback and tailnet HTTPS.
