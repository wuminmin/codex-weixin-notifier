# CATM 1.0

CATM is a shared, tenant-scoped MCP server for author control of coding-agent sessions. Codex, Claude Code, and opencode connect through their built-in HTTP MCP clients. The author receives decisions and completion messages in Weixin, Feishu, or Lark and can control sessions from a phone.

CATM 1.0 is a destructive upgrade. It has no hooks, completion poller, stdio transport, numbered tasks, Chinese control commands, legacy environment variables, or compatibility reads.

## Install and onboard

Requirements: Linux, Node.js 20+, and optionally tmux for phone-created managed sessions.

```bash
curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh | bash
catm onboard --agents all
```

To choose the port explicitly:

```bash
catm onboard --port 61937 --agents codex,claude
```

Without `--port`, CATM reads Linux `net.ipv4.ip_local_port_range`, randomly prefers an available IANA private port outside that range, verifies it with an exclusive bind, starts the daemon successfully, and only then persists it. The selected endpoint is written to every configured MCP client. There is no fixed or fallback port.

Configuration and state use only these paths:

```text
~/.local/share/catm/
~/.config/catm/config.json
~/.local/state/catm/
~/.local/bin/catm
```

The config is mode `0600`. CATM binds only `127.0.0.1`, validates Host and Origin, rate-limits failed authentication, limits request size and concurrency, and gives each MCP client a different 256-bit bearer token. Only token hashes are stored by CATM.

## Daemon and clients

```bash
catm server start
catm server stop
catm server rebind --port 62001
catm agents configure all
catm agents --print
curl http://127.0.0.1:<selected-port>/health
```

`rebind` requires the daemon to be stopped. A normal restart always reuses the persisted port and fails visibly if another process owns it. `agents --print` never prints credentials.

The installed MCP prompt requires agents to:

- call `sync_session` at work start, major stage boundaries, around decisions, after verification, before completion, and about every five minutes during continuous work;
- use `request_author_decision` for each distinct author decision and then `wait_author_decision`;
- call `notify_work_completed` once for the current work cycle.

A session can have any number of decisions and work cycles. Completion makes it idle; later work starts a new internal cycle.

## Author channels

```bash
catm channel weixin
catm channel feishu --platform feishu --mode manual
catm channel feishu --platform lark --mode qr
catm bind-code
```

After channel setup, restart CATM. Send `bind <code>` from the author account. Binding codes already belong to the initialized tenant; phones cannot choose or switch tenants.

## Phone commands

Commands are case-insensitive and documented in lowercase. Instruction text may use any language.

| Command | Behavior |
|---|---|
| `sessions` | List sessions |
| `active` | List active or queued sessions |
| `current` | Show selected session |
| `use S12` | Select a session |
| `send S12 <text>` | Add an instruction |
| `inbox S12` | Inspect instruction state |
| `decisions S12` | List pending decisions |
| `decide ABC <answer>` | Answer a decision |
| `new` | Start a managed Codex session |
| `new claude` | Start a managed Claude Code session |
| `new opencode` | Start a managed opencode session |
| `close S12` | Close a session |
| `snap S12` | Capture a managed tmux session |
| `status` | Show tenant-scoped health |
| `bind <code>` | Bind the author account |
| `help` | Show commands |

After `use S12`, ordinary text is queued for that session. Managed tmux sessions receive it immediately. MCP-only sessions receive unacknowledged instructions on every `sync_session`, providing at-least-once delivery until the agent acknowledges each instruction id.

## Tenant model

Onboarding creates one immutable tenant id:

```text
tenant_id: default
display_name: Default
author: author/default
```

Sessions, instructions, decisions, completions, channels, and credentials all carry a tenant id internally. MCP tools cannot accept or override it: bearer credentials resolve the tenant. Author channel bindings resolve the phone tenant. Cross-tenant identifiers are reported as not found.

## Development

```bash
npm ci
npm test
```

The test suite uses temporary homes and loopback ports. It never invokes destructive cleanup against the real user home.
