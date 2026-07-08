---
name: weixin-notifier
description: Configure and test Codex Weixin notifications and Weixin-driven task commands through Tencent iLink/OpenClaw-style bot delivery.
---

# Weixin Notifier

Use this skill when the user wants Codex to pair Weixin by QR code, notify Weixin after a task finishes, start Codex work from Weixin, list numbered tasks, or switch the current Weixin-managed Codex task.

## Design

The plugin separates the completion event from the Weixin transport:

- `scripts/pair-weixin.mjs` starts Tencent iLink QR login directly and saves credentials for Codex.
- `scripts/notify-weixin.mjs` is the single sender for CLI, VS Code, shell wrappers, and future Codex hooks. It can render completion notifications as one or more terminal-style PNG images when `renderMarkdownImages` or `CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES=1` is enabled.
- `scripts/weixin-command-router.mjs` listens for inbound Weixin text, maintains numbered Codex tasks, switches the current task with `task N`, and forwards ordinary text to the selected task's interactive tmux Codex session.
- `scripts/weixin-command-router.mjs` sends a small text heartbeat such as `task N · 处理中` before processing ordinary task messages, while immediate commands such as `list` and `task close ...` reply normally.
- `scripts/weixin-command-router.mjs` starts interactive tasks with `codex --no-alt-screen -C <codexCwd>` plus the configured Codex global args, so Weixin can drive native CLI slash commands such as `/plan` and `/goal`.
- `scripts/weixin-command-router.mjs` maps Weixin `plan ...` to `/plan ...`, and `goal ...` / `goal status` / `goal pause` / `goal resume` / `goal clear` to the native `/goal` command family.
- `scripts/weixin-command-router.mjs` detects Codex interactive `Question 1/1` choice prompts in tmux output, sends the numbered options back to Weixin, and treats the next numeric Weixin reply as the selected option.
- `scripts/weixin-command-router.mjs` accepts inbound Weixin images and files for the current task; files are saved under the task data directory, normally `~/codex/taskN/inbox/`, and images are passed to Codex with `--image` when the interactive session starts, while other files are referenced by local path in the prompt.
- `scripts/weixin-command-router.mjs` also sends local images and file attachments when a Codex task emits a `MEDIA:/absolute/path` directive on its own line.
- `scripts/weixin-command-router.mjs` can render outbound Markdown/text replies as terminal-style PNG images when `renderMarkdownImages` or `CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES=1` is enabled, then send those PNGs through the existing media path.
- `task snap` / `task screenshot` renders the current task's tmux pane as one or more static PNG images and sends them to Weixin.
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
- `CODEX_WEIXIN_CODEX_CWD`
- `CODEX_WEIXIN_CODEX_COMMAND`
- `CODEX_WEIXIN_CODEX_SANDBOX`
- `CODEX_WEIXIN_CODEX_BYPASS_SANDBOX`
- `CODEX_WEIXIN_CODEX_ARGS`
- `CODEX_WEIXIN_MEDIA_ROOTS`
- `CODEX_WEIXIN_MAX_MEDIA_BYTES`
- `CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES`
- `CODEX_WEIXIN_CHROME_PATH`
- `CODEX_WEIXIN_MARKDOWN_IMAGE_WIDTH`
- `CODEX_WEIXIN_MARKDOWN_IMAGE_MAX_CHARS`
- `CODEX_WEIXIN_MARKDOWN_IMAGE_MAX_HEIGHT`
- `WEIXIN_CDN_BASE_URL`

## Weixin Commands

Start the command router after pairing and binding:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs
```

Use the fixed tmux startup wrapper for WSL startup or Windows Task Scheduler:

```bash
/path/to/codex-weixin-notifier/scripts/start-router-tmux.sh
```

It is idempotent and only starts `codex-wx-router` when that tmux session is missing.

Supported inbound Weixin commands:

- `list`: list numbered tasks.
- `task 0`, `task 1`, `task 2`: enter an existing task, or create the next numeric task in order.
- `task close 1`, `task close godot`: close one or more non-default tasks by id or alias.
- `task reset 1`, `task reset godot`: clear Codex resume/session state for a non-running task without deleting files, aliases, historical log files, ids, or the task data directory; it also clears the task's previous run-log pointer so old session ids are not restored.
- `task alias 1 godot`, `task unalias godot`, `task godot`: set, remove, or enter a task alias.
- `task tmux clean`: remove old per-run tmux sessions from before fixed task session names.
- `task snap`, `task screenshot`: render the current task's tmux pane as one or more terminal-style PNG images and send them to Weixin.
- `pwd`, `ls`, `ls /path`, `ls -la /path`: run simple WSL directory commands in the current task cwd and return output with line breaks preserved.
- Any other text: forward to the current task.
- Any inbound image/file message: save the attachment under the current task's `inbox` directory and forward it to the current task. Images are also attached to Codex with `--image`.

Important behavior:

- `task 0` is the default Codex assistant and always exists.
- Codex task sessions use `CODEX_WEIXIN_CODEX_CWD` / `codexCwd` as their working directory, defaulting to `$HOME`; every task also has a fixed data directory under `~/codex/taskN` for attachments and state.
- `task 0` cannot be closed from Weixin; close commands only apply to task 1 and later.
- Task ids are monotonic and must be created one at a time; ids are not deleted or reused.
- `task 0` does not create other tasks. New tasks are created only by explicit `task N` commands.
- `task reset ...` refuses running, starting, or queued tasks; close them first with `task close ...`.
- interactive tmux sessions are fixed by task id, such as `codex-wx-task-0` and `codex-wx-task-1`; they stay open until `task close N` or the Codex CLI exits.
- `task tmux clean` only removes legacy per-run sessions named like `codex-wx-task-1-wxrun-...` or `codex-wx-task-1-wxr-...`; it does not remove `codex-wx-router` or fixed task sessions.
- Router startup and ordinary message forwarding refresh stale task runner state. If a task is marked active but its tmux session or pid is gone, the stale runner fields are cleared and pending instructions are resumed instead of leaving future messages stuck in queue.
- Ordinary task messages and attachment messages send a first text heartbeat before Codex processing. `task snap` sends `task N · 截图中` first. Immediate commands such as `list`, `task N`, `task close ...`, and alias commands do not send a separate heartbeat.
- Child Codex runs can use `--dangerously-bypass-approvals-and-sandbox` by setting `CODEX_WEIXIN_CODEX_BYPASS_SANDBOX=1` / `codexBypassSandbox: true`; existing tmux task sessions must be closed and re-entered before changed Codex arguments take effect.
- When Codex shows an interactive `Question 1/1` prompt, Weixin should receive the question and numbered choices. Reply with `1`, `2`, etc. to submit that selection inside the task tmux session.
- `task snap` is a static snapshot only; the user still controls the task by sending normal Weixin text replies.
- Normal replies and completion notifications render as PNG images only when explicitly enabled with `renderMarkdownImages` or `CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES=1`. The renderer uses Chrome from `chromePath`, `CODEX_WEIXIN_CHROME_PATH`, or common system paths such as `/usr/bin/google-chrome`, with optional width/character limits and a per-image output PNG height limit; longer content is sent as multiple images instead of being clipped. If rendering or media upload fails, the sender falls back to the original text.
- The router does not interpret natural language. It only handles exact `list`, `task N`, `task close ...`, and alias commands, the `pwd`/`ls` WSL command whitelist, tracks the current task, starts/closes Codex processes, and forwards messages.
- Weixin replies are prefixed with `task N:` so the user can see which Codex process answered.
- Weixin image/file messages go to the current task. Images use Codex `--image`; ordinary files are referenced by saved local path because Codex CLI does not provide a generic `--file` option.
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

For Codex Stop hooks, use `scripts/codex-finish-hook.mjs` rather than calling `notify-weixin.mjs` directly. It writes the event to `/tmp/codex-weixin-notifier-hooks/`, starts `notify-weixin.mjs` in a short-lived background tmux session, and exits immediately so slow Weixin rendering or upload does not trip the host hook timeout. Check `/tmp/codex-weixin-notifier-hook.log` for launcher and sender output.

For VS Code, configure the Codex extension or its launch wrapper to call the same command on completion and set `CODEX_PRODUCT=vscode-codex`. Each VS Code window or terminal should pass its own `CODEX_SESSION_ID`; if it cannot, the sender falls back to a process-derived id.
