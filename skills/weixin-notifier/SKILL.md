---
name: weixin-notifier
description: Configure and test Codex Weixin or Feishu notifications, multi-account Feishu application bots, and channel-driven task commands.
---

# Weixin & Feishu Notifier

Use this skill when the user wants Codex to pair Weixin, configure one or more Feishu application bots, send completion notifications through either channel, start Codex work from chat, list numbered tasks, or switch the current chat-managed Codex task.

## Design

The plugin separates a shared task/notification core from channel transports:

- `scripts/codex-command-router.mjs` starts all enabled Weixin and Feishu adapters in one process.
- `scripts/notify.mjs` fans completion events out to the configured Weixin destination and all enabled Feishu `notifyTargets`; a per-target failure does not stop the remaining sends, but makes the final exit status nonzero.
- `~/.codex/codex-notifier.json` is the general config. Explicit `--config` / `CODEX_NOTIFIER_CONFIG` wins, followed by the general config, then the legacy Weixin config.
- Legacy `~/.codex/weixin-notifier.json` is mapped in place to `weixin/default/default`; no key or state migration is required.
- Each Feishu `{account, bot}` owns an independent task list, task 0, attachment tree, state namespace, and stable-hash tmux prefix. Conversations inside that bot share its task pool, while the selected current task is stored by `chatId`.
- Feishu uses the official `@larksuiteoapi/node-sdk` Channel for WebSocket reconnect, group `@bot` policy, message normalization, deduplication, per-chat ordering, native Markdown splitting, reply/thread context, and media transfer.

- `scripts/pair-weixin.mjs` starts Tencent iLink QR login directly and saves credentials for Codex.
- `scripts/notify-weixin.mjs` is the Weixin-only compatibility sender. It renders completion notifications as terminal-style long PNG images by default; set `renderMarkdownImages: false` or `CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES=0` to force text replies.
- `scripts/weixin-command-router.mjs` listens for inbound Weixin text, maintains numbered Codex tasks, switches the current task with `task N` / `任务 N`, and forwards ordinary text to the selected task's interactive tmux Codex session.
- `scripts/codex-task-state-hook.mjs` and `scripts/codex-task-monitor.mjs` maintain a model-free local status registry for WSL CLI, VS Code Codex, and Weixin-managed tmux tasks. Exact `任务`, `进度`, and `状态` commands read it directly.
- `scripts/weixin-command-router.mjs` sends a small text heartbeat such as `task N · 处理中` before processing ordinary task messages. In interactive mode this heartbeat is the only dispatch acknowledgement; the router suppresses the redundant `interactive 已发送 / 已进入后台等待` reply. Immediate commands such as `list` / `列表` and `task close ...` / `任务 关闭 ...` reply normally.
- `scripts/weixin-command-router.mjs` starts interactive tasks with `codex --no-alt-screen -C <codexCwd>` plus the configured Codex global args, so Weixin can drive native CLI slash commands such as `/plan` and `/goal`.
- `scripts/weixin-command-router.mjs` maps Weixin `plan ...` / `计划 ...` to `/plan ...`, and `goal ...` / `目标 ...` plus status/pause/resume/clear Chinese aliases to the native `/goal` command family.
- `scripts/weixin-command-router.mjs` detects Codex interactive `Question 1/1` choice prompts in tmux output, sends the full question text and numbered options back to Weixin, and treats the next numeric Weixin reply as the selected option.
- `scripts/weixin-command-router.mjs` accepts inbound Weixin images and files for the current task; files are saved under the task data directory, normally `~/codex/taskN/inbox/`, and images are passed to Codex with `--image` when the interactive session starts, while other files are referenced by local path in the prompt.
- `scripts/weixin-command-router.mjs` also sends local images and file attachments when a Codex task emits a `MEDIA:/absolute/path` directive on its own line.
- `scripts/weixin-command-router.mjs` renders outbound Markdown/text replies as terminal-style long PNG images by default, then sends those PNGs through the existing media path.
- `task snap` / `task screenshot` / `任务 截图` renders the current task's tmux pane as one or more static PNG images and sends them to Weixin.
- Each notification carries a `sessionId`, `source`, `workspace`, `task`, `status`, and completion time.
- Multiple Codex processes are separated by an explicit session id when available; otherwise the sender derives a short id from process and workspace context.
- Secrets are read from `~/.codex/weixin-notifier.json` or environment variables, never from prompts.
- Transport is an HTTP adapter shaped from the Tencent iLink API used by `@tencent-weixin/openclaw-weixin`; it does not require running OpenClaw.

## Feishu Setup

Configure each Feishu China-domain enterprise self-built application bot separately; Lark international tenants are not supported in this release. Manual mode prompts for the App Secret without placing it in shell history:

```bash
node /path/to/codex-weixin-notifier/scripts/setup-feishu.mjs \
  --account company-a --bot codex-main --mode manual
```

QR mode uses the official SDK application registration flow and requests bot identity, private-message receive, group `@bot` receive, send-as-bot, media, and `im.message.receive_v1` capabilities:

```bash
node /path/to/codex-weixin-notifier/scripts/setup-feishu.mjs \
  --account company-a --bot codex-main --mode qr
```

After scanning or entering credentials, ensure the app is published, permissions are approved, long-connection events are enabled, and the bot is added to target groups. Then validate:

```bash
node /path/to/codex-weixin-notifier/scripts/setup-feishu.mjs \
  --account company-a --bot codex-main --check
```

The config file is written with mode `0600`. Repeat setup for more accounts or bots, then start every enabled adapter with:

```bash
/path/to/codex-weixin-notifier/scripts/start-router-tmux.sh --restart
```

Feishu DMs are accepted directly. Group messages must explicitly mention the current bot; when multiple configured bots are in one group, each reacts only to its own mention. Replies are associated with the inbound message, and topic messages remain in the same topic. Feishu text stays native Markdown/rich text; only `task snap` and explicit image media are PNGs.

General notification examples:

```bash
node /path/to/codex-weixin-notifier/scripts/notify.mjs --dry-run \
  --task "Smoke test" --summary "Fan-out formatting test"

node /path/to/codex-weixin-notifier/scripts/notify.mjs \
  --channel feishu --account company-a --bot codex-main --target ops \
  --task "Codex finished"
```

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
- `CODEX_WEIXIN_CODEX_BYPASS_HOOK_TRUST`
- `CODEX_WEIXIN_CODEX_ARGS`
- `CODEX_WEIXIN_RESTART_TASKS_ON_ROUTER_START`
- `CODEX_WEIXIN_INTERACTIVE_RESPONSE_TIMEOUT_MS`
- `CODEX_WEIXIN_INTERACTIVE_WATCH_STATUS_INTERVAL_MS`
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

It is idempotent and only starts `codex-wx-router` when that tmux session is missing. Use `--restart` to stop and relaunch the router; active task sessions are restarted by the router on startup.

Supported inbound Weixin commands:

- `list`, `列表`, `任务列表`: list numbered tasks.
- `任务`: show all numbered Weixin tasks plus recent WSL CLI and VS Code Codex sessions.
- `进度`: show only running, queued, starting, or waiting tasks with current stage and elapsed time.
- `状态`: show Weixin router, tmux, WSL CLI, VS Code app-server, and lifecycle Hook health.
- `task 0`, `task 1`, `task 2`, `任务 0`, `任务 1`, `任务 2`: enter an existing task, or create the next numeric task in order.
- `task close 1`, `task close godot`, `任务 关闭 1`, `任务 关闭 godot`: close one or more non-default tasks by id or alias.
- `task reset 1`, `task reset godot`, `任务 重置 1`, `任务 重置 godot`: clear Codex resume/session state for a non-running task without deleting files, aliases, historical log files, ids, or the task data directory; it also clears the task's previous run-log pointer so old session ids are not restored.
- `task alias 1 godot`, `任务 别名 1 godot`, `task unalias godot`, `任务 取消别名 godot`, `task godot`, `任务 godot`: set, remove, or enter a task alias.
- `task tmux clean`, `任务 tmux 清理`, `清理 tmux`: remove old per-run tmux sessions from before fixed task session names.
- `task snap`, `task screenshot`, `任务 截图`, `截图`: render the current task's tmux pane as one or more terminal-style PNG images and send them to Weixin.
- `pwd`, `当前目录`, `工作目录`, `ls`, `列文件`, `ls /path`, `列文件 /path`, `ls -la /path`, `列文件 -la /path`: run simple WSL directory commands in the current task cwd and return output with line breaks preserved.
- Any other text: forward to the current task.
- Any inbound image/file message: save the attachment under the current task's `inbox` directory and forward it to the current task. Images are also attached to Codex with `--image`.

Important behavior:

- `task 0` is the default Codex assistant and always exists.
- Codex task sessions use `CODEX_WEIXIN_CODEX_CWD` / `codexCwd` as their working directory, defaulting to `$HOME`; every task also has a fixed data directory under `~/codex/taskN` for attachments and state.
- `task 0` / `任务 0` cannot be closed from Weixin; close commands only apply to task 1 and later.
- Task ids are monotonic and must be created one at a time; ids are not deleted or reused.
- `task 0` does not create other tasks. New tasks are created only by explicit `task N` / `任务 N` commands.
- `task reset ...` / `任务 重置 ...` refuses running, starting, or queued tasks; close them first with `task close ...` / `任务 关闭 ...`.
- interactive tmux sessions are fixed by task id, such as `codex-wx-task-0` and `codex-wx-task-1`; they stay open until `task close N` or the Codex CLI exits.
- Router startup restarts active interactive task sessions by default so tmux panes pick up changed router/Codex arguments after every router restart. Set `CODEX_WEIXIN_RESTART_TASKS_ON_ROUTER_START=0`, `restartTasksOnRouterStart: false`, or pass `--no-restart-tasks` to the router to disable it.
- `task tmux clean` only removes legacy per-run sessions named like `codex-wx-task-1-wxrun-...` or `codex-wx-task-1-wxr-...`; it does not remove `codex-wx-router` or fixed task sessions.
- Router startup and ordinary message forwarding refresh stale task runner state. If a task is marked active but its tmux session or pid is gone, the stale runner fields are cleared and pending instructions are resumed instead of leaving future messages stuck in queue.
- Ordinary task messages and attachment messages send a first text heartbeat before Codex processing. In interactive mode, no second long-image acknowledgement is sent after dispatch; completion output and interactive questions still arrive normally. `task snap` / `任务 截图` sends `task N · 截图中` first. Immediate commands such as `list`, `列表`, `task N`, `任务 N`, `task close ...`, `任务 关闭 ...`, and alias commands do not send a separate heartbeat.
- Interactive task replies use a background watcher so the router stays responsive; it sends choice prompts immediately and sends the final Weixin image when Codex returns to the input prompt or prints `Worked`. Watcher state is stored in task metadata so a router restart with `--no-restart-tasks` can resume waiting. `interactiveResponseTimeoutMs` is only an abnormal timeout and defaults to 21600000 ms; status pings default to every 1800000 ms and can be overridden with `interactiveWatchStatusIntervalMs` or `CODEX_WEIXIN_INTERACTIVE_WATCH_STATUS_INTERVAL_MS`.
- Child Codex runs can use `--dangerously-bypass-approvals-and-sandbox` by setting `CODEX_WEIXIN_CODEX_BYPASS_SANDBOX=1` / `codexBypassSandbox: true`. Vetted automation can separately set `CODEX_WEIXIN_CODEX_BYPASS_HOOK_TRUST=1` / `codexBypassHookTrust: true`; existing tmux task sessions must be closed and re-entered before changed Codex arguments take effect.
- When Codex shows an interactive `Question 1/1` prompt, Weixin should receive the full question text and numbered choices, including wrapped prompt and option lines from the terminal. Reply with `1`, `2`, etc. to submit that selection inside the task tmux session.
- `task snap` / `任务 截图` is a static snapshot only; the user still controls the task by sending normal Weixin text replies.
- Normal replies and completion notifications render as long PNG images by default. Set `renderMarkdownImages: false` or `CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES=0` to force text. The renderer uses Chrome from `chromePath`, `CODEX_WEIXIN_CHROME_PATH`, or common system paths such as `/usr/bin/google-chrome`, with optional width/character limits and a per-image output PNG height limit; longer content is sent as multiple images instead of being clipped. If rendering or media upload fails, the sender falls back to the original text.
- The router does not interpret natural language. It handles exact task commands plus the fixed `任务`, `进度`, and `状态` status views, the `pwd`/`当前目录` and `ls`/`列文件` WSL command whitelist, tracks the current task, starts/closes Codex processes, and forwards other messages. Status views never invoke a model.
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
  --message "列表"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "task close 999"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "任务 关闭 999"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "task reset 1"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "任务 重置 1"

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
node /path/to/codex-weixin-notifier/scripts/notify.mjs \
  --source "${CODEX_PRODUCT:-codex}" \
  --status "${CODEX_STATUS:-completed}" \
  --task "${CODEX_TASK:-Codex task}"
```

If the host provides a JSON hook payload, pipe it to stdin:

```bash
printf '%s' "$CODEX_HOOK_PAYLOAD" | \
node /path/to/codex-weixin-notifier/scripts/notify.mjs
```

For Codex Stop hooks, use `scripts/codex-finish-hook.mjs` rather than calling a sender directly. It writes the event to `/tmp/codex-weixin-notifier-hooks/`, starts the general `notify.mjs` fan-out sender in a short-lived background tmux session, and exits immediately so slow rendering or channel APIs do not trip the host hook timeout. Check `/tmp/codex-weixin-notifier-hook.log` for launcher and per-target sender output. Router-launched tasks set both the legacy `CODEX_WEIXIN_ROUTER_TASK=1` and general `CODEX_NOTIFIER_ROUTER_TASK=1` suppressors.

For progress tracking, configure `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PreToolUse`, and `PostToolUse` to call `scripts/codex-task-state-hook.mjs`; keep `Stop` on `codex-finish-hook.mjs`, which also records completion. The repository includes `scripts/codex-task-hooks.example.toml`. Restart CLI sessions and reload VS Code after changing global Hook configuration, then review new command Hooks in `/hooks` unless the invocation explicitly uses Codex's vetted-automation Hook trust bypass.

For VS Code, configure the Codex extension or its launch wrapper to call the same command on completion and set `CODEX_PRODUCT=vscode-codex`. Each VS Code window or terminal should pass its own `CODEX_SESSION_ID`; if it cannot, the sender falls back to a process-derived id.
