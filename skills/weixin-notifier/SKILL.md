---
name: weixin-notifier
description: Configure and test Codex Weixin notifications and Weixin-driven task commands through Tencent iLink/OpenClaw-style bot delivery.
---

# Weixin Notifier

Use this skill when the user wants Codex to pair Weixin by QR code, notify Weixin after a task finishes, start Codex work from Weixin, list numbered tasks, or switch the current Weixin-managed Codex task.

## Design

The plugin separates the completion event from the Weixin transport:

- `scripts/pair-weixin.mjs` starts Tencent iLink QR login directly and saves credentials for Codex.
- `scripts/notify-weixin.mjs` is the single sender for CLI, VS Code, shell wrappers, and future Codex hooks.
- `scripts/weixin-command-router.mjs` listens for inbound Weixin text, maintains numbered Codex tasks, switches the current task with `task N`, and forwards ordinary text to the selected task.
- `scripts/weixin-command-router.mjs` also sends local images and file attachments when a Codex task emits a `MEDIA:/absolute/path` directive on its own line.
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
- `CODEX_WEIXIN_MEDIA_ROOTS`
- `CODEX_WEIXIN_MAX_MEDIA_BYTES`
- `WEIXIN_CDN_BASE_URL`

## Weixin Commands

Start the command router after pairing and binding:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs
```

Supported inbound Weixin commands:

- `list`: list numbered tasks.
- `task 0`, `task 1`, `task 2`: enter an existing task, or create the next numeric task in order.
- `task close 1`, `task close godot`: close one or more non-default tasks by id or alias.
- `task reset 1`, `task reset godot`: clear Codex resume/session state for a non-running task without deleting files, aliases, logs, ids, or the fixed task directory.
- `task alias 1 godot`, `task unalias godot`, `task godot`: set, remove, or enter a task alias.
- `task tmux clean`: remove old per-run tmux sessions from before fixed task session names.
- `pwd`, `ls`, `ls /path`, `ls -la /path`: run simple WSL directory commands in the current task cwd and return output with line breaks preserved.
- Any other text: forward to the current task.

Important behavior:

- `task 0` is the default Codex assistant and always exists.
- `task 0` uses `~/codex/task0`; `task 1` uses `~/codex/task1`; every task has a fixed directory under `~/codex/taskN`.
- `task 0` cannot be closed from Weixin; close commands only apply to task 1 and later.
- Task ids are monotonic and must be created one at a time; ids are not deleted or reused.
- `task 0` does not create other tasks. New tasks are created only by explicit `task N` commands.
- `task reset ...` refuses running, starting, or queued tasks; close them first with `task close ...`.
- tmux runner sessions are fixed by task id, such as `codex-wx-task-0` and `codex-wx-task-1`; completed runs close by default unless `CODEX_WEIXIN_KEEP_TMUX_OPEN=1` or `keepTmuxOpen: true` is set.
- `task tmux clean` only removes legacy per-run sessions named like `codex-wx-task-1-wxrun-...` or `codex-wx-task-1-wxr-...`; it does not remove `codex-wx-router` or fixed task sessions.
- The router does not interpret natural language. It only handles exact `list`, `task N`, `task close ...`, and alias commands, the `pwd`/`ls` WSL command whitelist, tracks the current task, starts/closes Codex processes, and forwards messages.
- Weixin replies are prefixed with `task N:` so the user can see which Codex process answered.
- To send a local image or file back to Weixin, the Codex task should put `MEDIA:/absolute/path/to/file` on its own line. Images are sent as image messages; other supported files are sent as file attachments.
- Media files must be under `~` or `/tmp` by default and are limited to 20 MB unless `mediaRoots` / `CODEX_WEIXIN_MEDIA_ROOTS` and `maxMediaBytes` / `CODEX_WEIXIN_MAX_MEDIA_BYTES` are configured.
Local command-router smoke checks:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "list"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "task close 999"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "task reset 1"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "task tmux clean"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs --list
```

Dry-run a media send without uploading:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --dry-run \
  --send-media /tmp/screenshot.png \
  --message "screenshot test"
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
