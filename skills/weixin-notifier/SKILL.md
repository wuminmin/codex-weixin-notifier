---
name: weixin-notifier
description: Configure and test the CATM 2.0 NAS-hosted MCP service, remote coding-agent clients, and notification-only Weixin or Feishu author channels.
---

# CATM 2.0 NAS notifications

Use this skill for NAS deployment, remote MCP client connection, author-channel pairing, and completion delivery.

## Invariants

- CATM runs only on the NAS in Docker Compose. Never start a CATM daemon in WSL or on a developer laptop.
- Compose maps container port `61937` only to NAS loopback. Tailscale Serve is the private default. A public Cloudflare Tunnel endpoint is allowed only when the author explicitly requests it; keep bearer authentication, expose only `/mcp` and `/health` through a reverse proxy, and never publish the CATM port directly or use Tailscale Funnel.
- Codex, Claude Code, and opencode use their built-in remote Streamable HTTP clients and one shared bearer token. Never print an existing token; initialization and rotation show a new token once.
- Server config is schema v2 and lives in the Docker data volume. Do not migrate v1 state automatically.
- Tenant isolation remains internal. Do not ask MCP callers or normal operators to provide tenant ids.
- A session is the only user-visible unit. Do not introduce tasks, hooks, pollers, tmux-managed sessions, or stdio MCP.
- Phone channels are notification-only after binding. Ignore inbound text without replying and never turn it into a decision or remote instruction.
- CATM does not expose decision or wait tools. Agents ask for input in their active conversation.

## Deployment and client commands

```bash
docker compose build
docker compose run --rm catm init --public-url https://nas.tailnet.ts.net/mcp
docker compose up -d
sudo tailscale serve --bg http://127.0.0.1:61937

# Optional, only for an explicitly requested Cloudflare deployment:
docker compose stop catm
docker compose run --rm catm endpoint add --url https://mcp.example.com/mcp
docker compose -f compose.yaml -f compose.cloudflare.yaml up -d --build

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

The author sends `bind <code>` from the phone channel. This is the only accepted phone command and exists solely to establish the notification target.

After binding, ordinary phone text is silently ignored. The bot sends completion notifications but does not reply to decisions or commands.

## MCP behavior and diagnosis

Agents call `sync_session` at work start, around major stages, after verification, before completion, and about every five minutes. When author input is required, ask in the active agent conversation. Before the final answer, the agent drafts the exact complete user-visible response, calls `notify_work_completed` once per returned `work_cycle_id` with that response unchanged in `summary`, and then sends the same response to the user without edits. CATM prepends an identity header containing the agent type, session id, work-cycle id, workspace, and task label. `verification` remains stored internal metadata and is not rendered in the author notification.

Verify that the remote MCP catalog contains only `sync_session` and `notify_work_completed`, that a completion reaches every enabled target, and that ordinary inbound text produces no reply or stored instruction.

For operations, check `docker compose ps`, `/health`, `docker compose logs`, and `tailscale serve status`. Verify the NAS host publishes CATM itself only on loopback. For an explicitly requested Cloudflare endpoint, also verify the public gateway allows only `/mcp` and `/health`, preserves streaming, requires the CATM bearer token on `/mcp`, and returns 404 for unrelated paths.
