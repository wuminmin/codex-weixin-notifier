# CATM 2.0

CATM is a NAS-hosted Streamable HTTP MCP server for durable coding-agent decisions, remote instructions, and completion notifications over Weixin and Feishu. Codex, Claude Code, and opencode connect to one long-running service through Tailscale; no CATM server runs in WSL or on developer laptops.

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

Phone commands are intentionally small:

| Command | Behavior |
|---|---|
| `sessions` | List sessions, states, inbox counts, and pending-decision counts |
| `use S12` | Select a session for ordinary-text instructions |
| `send S12 <text>` | Queue an instruction for one session |
| `decide 004 <answer>` | Explicitly answer a decision by code |
| `close S12` | Close a session and cancel its pending decisions |
| `status` | Show CATM health |
| `bind <code>` | Bind the author account |
| `help` | Show commands |

When CATM sends a decision, reply with the answer directly. CATM associates the conversation with the most recently delivered pending decision and confirms one of two outcomes:

- `Claude wait is active and will continue`: the active `wait_author_decision` call was signalled immediately.
- `No active Claude wait; reopen Claude to continue`: the answer is safely stored, but MCP cannot wake an agent whose tool call already ended.

`decide <code> <answer>` remains available when you need to identify a decision explicitly. Invalid closed-choice answers leave the decision pending and return an error.

## Decision durability

Agents use four MCP tools:

- `sync_session`
- `request_author_decision`
- `wait_author_decision`
- `notify_work_completed`

An active wait sends a protocol heartbeat every 15 seconds, rechecks persistent state every five seconds, and is signalled immediately after a phone answer is committed. A timeout returns `wait_status: pending`; the decision remains answerable. A server restart preserves decisions and answers but cannot restore the caller's old HTTP request.

Remote instructions use at-least-once delivery. They are returned by `sync_session` until the agent acknowledges their instruction ids on a later sync.

## Operations

Check service health and logs:

```bash
docker compose ps
docker compose logs --tail=100 catm
tailscale serve status
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
docker build -t catm:local .
```

Tests use temporary homes, ephemeral loopback listeners, and synthetic credentials. They do not modify real CATM state or contact Weixin/Feishu.
