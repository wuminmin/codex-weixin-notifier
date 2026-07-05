# Codex Weixin Notifier

Local Codex plugin that pairs Weixin by QR code, sends Weixin notifications when Codex work completes, and accepts Weixin commands for starting and extending Codex tasks.

## Architecture

- `scripts/pair-weixin.mjs` starts the Tencent iLink QR login flow, shows a terminal QR code, polls for confirmation, and saves credentials to `~/.codex/weixin-notifier.json`.
- `scripts/notify-weixin.mjs` normalizes the Codex completion event, adds a per-session identity, formats a concise message, and posts it to the Tencent iLink `sendmessage` endpoint.
- `scripts/weixin-command-router.mjs` long-polls inbound Weixin messages, keeps a numbered task list, switches the current task with `task N`, and forwards ordinary text to the selected Codex task.
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
~/.codex/weixin-notifier/current-task.json
~/.codex/weixin-notifier/logs/
```

Send these messages to the paired Weixin bot:

```text
list
task 0
task 1
add tests for codex-weixin-notifier
continue by updating the README too
```

The command vocabulary is intentionally small:

```text
list
task 0
task 1
task 2
```

`task 0` is the default Codex assistant and always exists. `task 1`, `task 2`, and later tasks are subtasks created by `task 0`. The router only handles exact `list` and `task N` messages; every other Weixin message is forwarded to the current task.

Replies are prefixed with the task id:

```text
task 0: 已开始
task 1: completed
```

Subtasks are created only by `task 0` through an internal protocol emitted by the Codex process:

```json
{"type":"create_task","cwd":"/absolute/workdir","prompt":"the full task instruction"}
```

`list` shows the numbered task list with current/default markers:

```text
task 0 [default,current] cwd=/home/user 默认 Codex 助理
task 1 [running] cwd=/path/to/codex-weixin-notifier 修改微信路由
```

Local smoke checks:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --message "list"

node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs --list
```

Optional command-router config fields in `~/.codex/weixin-notifier.json`:

```json
{
  "codexCommand": "codex",
  "codexGlobalArgs": ["--ask-for-approval", "never"],
  "codexArgs": ["--json", "--skip-git-repo-check"]
}
```

`runner` defaults to `tmux` when tmux is installed, and falls back to direct `spawn` otherwise. tmux tasks keep an attachable session open after Codex exits so you can inspect the terminal:

```bash
tmux attach -t codex-wx-task-...
```

`CODEX_WEIXIN_RUNNER`, `CODEX_WEIXIN_DEFAULT_CWD`, `CODEX_WEIXIN_CODEX_COMMAND`, `CODEX_WEIXIN_CODEX_GLOBAL_ARGS`, and `CODEX_WEIXIN_CODEX_ARGS` can override those fields.

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
