# CATM 2.0

CATM is a NAS-hosted Streamable HTTP MCP server for coding-agent completion notifications over Weixin and Feishu. Codex, Claude Code, and opencode connect to one long-running service through Tailscale or an explicitly configured Cloudflare Tunnel; no CATM server runs in WSL or on developer laptops.

CATM 2.0 is a destructive server-schema upgrade. Initialize it on the NAS as a new deployment. Existing 1.0 state is not imported or deleted automatically.

## 1. Deploy on the NAS

Requirements: Docker Compose and host-level Tailscale with MagicDNS/HTTPS enabled.

Clone this repository, then initialize the persistent Docker volume. Replace the URL with the HTTPS name Tailscale assigns to the NAS:

```bash
docker compose build
docker compose run --rm catm init \
  --public-url https://your-nas.your-tailnet.ts.net/mcp
```

Initialization prints one 256-bit access token exactly once. Save it in a password manager. CATM stores only its SHA-256 hash.

Start the service and expose it only inside the tailnet:

```bash
docker compose up -d
sudo tailscale serve --bg http://127.0.0.1:61937
docker compose ps
curl https://your-nas.your-tailnet.ts.net/health
```

Compose publishes CATM only on NAS loopback (`127.0.0.1:61937`), uses a named data volume, checks `/health`, and restarts the container unless it was explicitly stopped. Do not use Tailscale Funnel for CATM.

### Optional public Cloudflare endpoint

Public exposure is opt-in. Keep the bearer token enabled, route only `/mcp` and `/health`, disable proxy buffering and caching, and do not publish port `61937` on a LAN or WAN address. CATM can accept more than one HTTPS hostname:

```bash
docker compose stop catm
docker compose run --rm catm endpoint add \
  --url https://mcp.example.com/mcp
docker compose -f compose.yaml -f compose.cloudflare.yaml up -d --build
docker compose exec catm catm endpoint list
```

`compose.cloudflare.yaml` joins the existing external Docker network named `nas-public-gateway`; it does not create a tunnel. Configure that gateway's Nginx and Cloudflare Tunnel to forward `mcp.example.com` to `http://catm:61937`, then verify both the public health response and an authenticated MCP initialization. The SessionBound deployment uses `https://mcp.sessionbound.org/mcp` through its existing wildcard tunnel.

Upgrade with:

```bash
git pull
docker compose up -d --build
```

## 2. Connect WSL or another developer machine

Install the client-only configurator:

```bash
curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh | bash
```

Connect the installed agents. The token prompt is hidden, and CATM verifies the remote MCP tool catalog before writing any client file:

```bash
catm connect \
  --url https://your-nas.your-tailnet.ts.net/mcp \
  --agents all
```

Use `--agents detected` or a comma-separated subset of `codex,claude,opencode` when appropriate. `connect` updates only the CATM sections in the clients' existing configuration and installs the CATM agent instructions. It starts no local daemon.

To remove the remote CATM configuration without touching other MCP servers:

```bash
catm disconnect --agents all
```

## 3. Configure an author channel

Run channel administration inside the NAS container:

```bash
docker compose exec catm catm channel weixin
docker compose exec catm catm channel feishu --mode manual
# or: docker compose exec catm catm channel feishu --mode qr
docker compose restart catm
docker compose exec catm catm bind-code
```

Send `bind <code>` to the bot from the author account. Binding codes expire after 15 minutes.

The phone channel is notification-only after binding. Its sole accepted setup command is:

| Command | Behavior |
|---|---|
| `bind <code>` | Bind the author account |

After binding, inbound text is silently ignored. CATM never records a phone reply as a decision or remote instruction. Ask and answer questions in the active Codex, Claude Code, or opencode conversation instead.

## Notification behavior

Agents use three MCP tools:

- `sync_session`
- `notify_author`
- `notify_work_completed`

`sync_session` registers the agent session and maintains its work-cycle identity. CATM does not collect author decisions or deliver remote instructions. When input is required, the agent asks in its active conversation.

`notify_author` sends proactive progress, warning, or informational messages. It is deliberately non-idempotent: agents may call it any number of times in the same work cycle, and every call produces a separate outbound notification without changing the session status.

Completion notifications prepend the agent type, session id, work-cycle id, workspace, and task label so one author bot can distinguish multiple agents and multiple working directories. The remaining notification body is the agent's exact final user-visible response. Agents pass that response unchanged in `notify_work_completed.summary`; `verification` is retained as internal metadata and is not rendered.

## Operations

Check service health and logs:

```bash
docker compose ps
docker compose logs --tail=100 catm
tailscale serve status
docker compose exec catm catm endpoint list
```

Rotate a lost or exposed access token while CATM is stopped:

```bash
docker compose stop catm
docker compose run --rm catm token rotate
docker compose up -d
```

The new token is shown once. Run `catm connect` again on every developer machine; the previous token no longer works.

Persistent server data is stored in the `catm-data` Docker volume. The service config is mode `0600`; channel secrets and only access-token hashes live there. The public `/health` response contains only readiness and version.

## Development

```bash
npm ci
npm test
docker compose config
docker compose -f compose.yaml -f compose.cloudflare.yaml config
docker build -t catm:local .
```

Tests use temporary homes, ephemeral loopback listeners, and synthetic credentials. They do not modify real CATM state or contact Weixin/Feishu.
