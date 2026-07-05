---
name: weixin-notifier
description: Configure and test Codex Weixin notifications and Weixin-driven task commands through Tencent iLink/OpenClaw-style bot delivery.
---

# Weixin Notifier

Use this skill when the user wants Codex to pair Weixin by QR code, notify Weixin after a task finishes, start Codex work from Weixin, list active tasks/processes, or append instructions to a Weixin-managed Codex task.

## Design

The plugin separates the completion event from the Weixin transport:

- `scripts/pair-weixin.mjs` starts Tencent iLink QR login directly and saves credentials for Codex.
- `scripts/notify-weixin.mjs` is the single sender for CLI, VS Code, shell wrappers, and future Codex hooks.
- `scripts/weixin-command-router.mjs` listens for inbound Weixin text commands, proposes a working directory before starting a task, records task state, lists tasks/processes, and appends follow-up instructions to registered tasks.
- Each notification carries a `sessionId`, `source`, `workspace`, `task`, `status`, and completion time.
- Multiple Codex processes are separated by an explicit session id when available; otherwise the sender derives a short id from process and workspace context.
- Secrets are read from `~/.codex/weixin-notifier.json` or environment variables, never from prompts.
- Transport is an HTTP adapter shaped from the Tencent iLink API used by `@tencent-weixin/openclaw-weixin`; it does not require running OpenClaw.

## Pair

Run this in the user's own WSL terminal so they can see and scan the QR code:

```bash
node /path/to/codex-weixin-notifier/scripts/pair-weixin.mjs
```

The script writes `~/.codex/weixin-notifier.json` with token, bot id, user id, and recipient id. It also writes `~/.codex/channels/wechat/account.json` in the same shape used by `codex-wechat-channel`, and the sender can read that compatibility file when the notifier config is absent.

## Bind Recipient

After QR pairing, the user must send any message to the paired Weixin bot and run:

```bash
node /path/to/codex-weixin-notifier/scripts/bind-recipient.mjs
```

iLink `sendmessage` needs the recipient plus a `context_token` captured from an inbound Weixin message. Without that context the API can return `ret=-2`.

Environment variables override missing config values:

- `CODEX_WEIXIN_CONFIG`
- `WEIXIN_ILINK_ENDPOINT`
- `WEIXIN_ILINK_TOKEN`
- `WEIXIN_ILINK_BOT_ID`
- `WEIXIN_TO_USER`
- `WEIXIN_TO_CHAT`
- `CODEX_SESSION_ID`
- `CODEX_RUN_ID`
- `CODEX_PRODUCT`
- `CODEX_WEIXIN_WORKSPACE_ROOT`
- `CODEX_WEIXIN_CODEX_COMMAND`
- `CODEX_WEIXIN_CODEX_ARGS`

## Weixin Commands

Start the command router after pairing and binding:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs
```

Supported inbound Weixin commands:

- `list`, `任务`, `列表`, `进程`: list registered active tasks, pending confirmations, and visible Codex processes.
- `new <task>` or `开始任务 <task>`: create a pending task and propose a working directory from the task intent.
- `confirm <request-id>` or `确认 <request-id>`: start the pending task in the proposed working directory.
- `dir <request-id> <path>` or `目录 <request-id> <path>`: start the pending task in an explicit working directory.
- `append <task-id-or-pid> <instruction>` or `追加 <task-id-or-pid> <instruction>`: append an instruction to a registered task or external Codex pid. Running registered tasks queue the instruction and resume after the current turn finishes.
- `cancel <request-id>` or `取消 <request-id>`: discard a pending task.

Important behavior:

- A Weixin-created task must be confirmed before execution. The first response always contains the proposed working directory and confirmation commands.
- Append tracking is most precise for tasks started by `weixin-command-router.mjs`, because those tasks are registered in `~/.codex/weixin-notifier/tasks.json`.
- External Codex pids can be targeted; the router starts a registered follow-up in the process cwd with `codex exec resume --last`. It does not inject text into arbitrary terminals.

Local command-router smoke checks:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "new codex-weixin-notifier add smoke test marker"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs --list
```

## Test

Run a dry test first:

```bash
node /path/to/codex-weixin-notifier/scripts/notify-weixin.mjs \
  --dry-run \
  --session test-cli-1 \
  --source codex-cli \
  --task "Smoke test" \
  --summary "This is a local formatting test."
```

Then run a real send after config is present:

```bash
node /path/to/codex-weixin-notifier/scripts/notify-weixin.mjs \
  --session codex-cli-$(date +%s) \
  --source codex-cli \
  --status completed \
  --task "Codex finished a task"
```

## Hook Integration

Use the sender as the completion command from any Codex or VS Code wrapper that can run a process after a session ends. Pass a stable session id from the parent process:

```bash
CODEX_SESSION_ID="${CODEX_SESSION_ID:-codex-$$}" \
node /path/to/codex-weixin-notifier/scripts/notify-weixin.mjs \
  --source "${CODEX_PRODUCT:-codex}" \
  --status "${CODEX_STATUS:-completed}" \
  --task "${CODEX_TASK:-Codex task}"
```

If the host provides a JSON hook payload, pipe it to stdin:

```bash
printf '%s' "$CODEX_HOOK_PAYLOAD" | \
node /path/to/codex-weixin-notifier/scripts/notify-weixin.mjs
```

For VS Code, configure the Codex extension or its launch wrapper to call the same command on completion and set `CODEX_PRODUCT=vscode-codex`. Each VS Code window or terminal should pass its own `CODEX_SESSION_ID`; if it cannot, the sender falls back to a process-derived id.
