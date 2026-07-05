# Codex Weixin Notifier

Local Codex plugin that pairs Weixin by QR code, sends Weixin notifications when Codex work completes, and accepts Weixin commands for starting and extending Codex tasks.

## Architecture

- `scripts/pair-weixin.mjs` starts the Tencent iLink QR login flow, shows a terminal QR code, polls for confirmation, and saves credentials to `~/.codex/weixin-notifier.json`.
- `scripts/notify-weixin.mjs` normalizes the Codex completion event, adds a per-session identity, formats a concise message, and posts it to the Tencent iLink `sendmessage` endpoint.
- `scripts/weixin-command-router.mjs` long-polls inbound Weixin messages, proposes a working directory before starting a task, records task/process state, and appends follow-up instructions to registered tasks.
- Multiple Codex processes are separated by `CODEX_SESSION_ID`, `CODEX_RUN_ID`, or an explicit `--session`; without one, the sender creates a short process-derived id.
- The Weixin transport is based on the official iLink API shape used by `@tencent-weixin/openclaw-weixin`; it does not require the OpenClaw CLI or gateway at runtime.

## Pair Weixin

Run this in your WSL terminal so the QR code is visible:

```bash
node /path/to/codex-weixin-notifier/scripts/pair-weixin.mjs
```

Scan the QR code with Weixin and confirm on the phone. The script writes the notification config:

```text
~/.codex/weixin-notifier.json
```

It also writes a compatibility account file matching `codex-wechat-channel`:

```text
~/.codex/channels/wechat/account.json
```

## Bind Recipient

iLink requires a recent Weixin conversation context for `sendmessage`. After pairing, send any message to the paired Weixin bot, then run:

```bash
node /path/to/codex-weixin-notifier/scripts/bind-recipient.mjs
```

The script captures `toUser` and `contextToken`, then updates:

```text
~/.codex/weixin-notifier.json
~/.codex/channels/wechat/context_tokens.json
```

Secrets can also be supplied through:

- `WEIXIN_ILINK_ENDPOINT`
- `WEIXIN_ILINK_TOKEN`
- `WEIXIN_ILINK_BOT_ID`
- `WEIXIN_TO_USER`
- `WEIXIN_TO_CHAT`

## Test

```bash
node /path/to/codex-weixin-notifier/scripts/notify-weixin.mjs \
  --dry-run \
  --session test-cli-1 \
  --source codex-cli \
  --task "Smoke test" \
  --summary "This is a formatting-only test."
```

Real send after pairing:

```bash
node /path/to/codex-weixin-notifier/scripts/notify-weixin.mjs \
  --session wsl-test \
  --source codex-cli \
  --task "Codex test" \
  --summary "This should arrive in Weixin."
```

## Weixin Commands

Start the command router after pairing and binding:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs
```

The router stores state in:

```text
~/.codex/weixin-notifier/tasks.json
~/.codex/weixin-notifier/pending.json
~/.codex/weixin-notifier/logs/
```

Send these messages to the paired Weixin bot:

```text
add tests for codex-weixin-notifier
yes
continue by updating the README too
yes
no
s
show
```

Chinese aliases are also supported:

```text
给 codex-weixin-notifier 增加一个 smoke test
yes
顺手更新 README
yes
no
状态
列表
```

Every inbound Weixin message first goes to `weixin-command-router.mjs`. The default Weixin protocol is intentionally tiny: normal text becomes a short pending action, `yes` executes it, and `no` cancels it. The router keeps the action vocabulary small internally:

- `create` starts a new tmux-backed Codex task.
- `send` appends a message to an existing task.
- `view` shows task state.
- `ask` requests clarification.

Every new task first becomes a pending action. Each Weixin sender has at most one active pending action; a new proposal replaces that sender's previous pending proposal. The router chooses a suggested working directory from the task intent and local project metadata, then waits for `yes` before it starts `codex exec`. While a pending action exists, ordinary follow-up text revises that pending action instead of creating another one; for example, if the proposed directory is too broad, say the missing folder name and the router updates the proposal. After a task starts, the router automatically focuses that task so the next normal message is proposed as a `send` action to the same task. `s`, `show`, `status`, and `list` show status immediately, and advanced commands such as `append <task-id> ...`, `@<task-id> ...`, `focus <task-id>`, `confirm <req-id>`, and `cancel <req-id>` are still supported for manual control.

`list` shows the focused task, registered active tasks, recent completed/failed tasks, pending confirmations, visible Codex processes, each task's working directory, and tmux session metadata when present. `append` can target a registered task id, an id prefix, a registered task pid, a registered tmux session, or an external Codex pid. If the target task is currently running, the instruction is queued and automatically sent with `codex exec resume` after the current turn exits. For a completed registered task, `append` starts a follow-up run in the same working directory and resumes the recorded Codex session when available. For an external Codex pid, the router starts a registered follow-up in that process cwd with `codex exec resume --last`. Arbitrary terminal injection is not attempted; start tasks through this router when you want exact task-level append tracking.

Local smoke checks:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "new codex-weixin-notifier add smoke test marker"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs --list
```

Optional command-router config fields in `~/.codex/weixin-notifier.json`:

```json
{
  "runner": "tmux",
  "workspaceRoot": "/home/user/plugins:~/codex",
  "codexCommand": "codex",
  "codexGlobalArgs": ["--ask-for-approval", "never"],
  "codexArgs": ["--json", "--skip-git-repo-check"]
}
```

`runner` defaults to `tmux` when tmux is installed, and falls back to direct `spawn` otherwise. tmux tasks keep an attachable session open after Codex exits so you can inspect the terminal:

```bash
tmux attach -t codex-wx-task-...
```

Working directory is chosen before launch from the natural-language request and shown in the pending action. Send `yes` to accept it or `no` to discard it.

`CODEX_WEIXIN_RUNNER`, `CODEX_WEIXIN_WORKSPACE_ROOT`, `CODEX_WEIXIN_CODEX_COMMAND`, `CODEX_WEIXIN_CODEX_GLOBAL_ARGS`, and `CODEX_WEIXIN_CODEX_ARGS` can override those fields.

## Completion Hook Shape

The sender accepts either CLI flags or JSON on stdin:

```json
{
  "sessionId": "codex-vscode-window-1",
  "source": "vscode-codex",
  "status": "completed",
  "workspace": "/path/to/workspace",
  "task": "Implement feature",
  "summary": "Changed files and tests passed."
}
```

For concurrent runs, set a unique `CODEX_SESSION_ID` in each parent process. Examples:

```bash
CODEX_SESSION_ID="cli-$(date +%s)-$$"
CODEX_PRODUCT="codex-cli"
```

```bash
CODEX_SESSION_ID="vscode-${VSCODE_PID:-window}-$$"
CODEX_PRODUCT="vscode-codex"
```
