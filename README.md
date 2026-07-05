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
list
new add tests for codex-weixin-notifier
confirm req-20260705041249-ac9cde
dir req-20260705041249-ac9cde /path/to/codex-weixin-notifier
append task-20260705041249-ac9cde also update the README
cancel req-20260705041249-ac9cde
```

Chinese aliases are also supported:

```text
列表
开始任务 给 codex-weixin-notifier 增加一个 smoke test
确认 req-20260705041249-ac9cde
目录 req-20260705041249-ac9cde /path/to/codex-weixin-notifier
追加 task-20260705041249-ac9cde 顺手更新 README
取消 req-20260705041249-ac9cde
```

Every new task first becomes a pending request. The router chooses a suggested working directory from the task intent and local project metadata, then waits for `confirm` or `dir` before it starts `codex exec`.

`list` shows registered active tasks, pending confirmations, and visible Codex processes. `append` can target a registered task id, an id prefix, a registered task pid, or an external Codex pid. If the target task is currently running, the instruction is queued and automatically sent with `codex exec resume` after the current turn exits. For an external Codex pid, the router starts a registered follow-up in that process cwd with `codex exec resume --last`. Arbitrary terminal injection is not attempted; start tasks through this router when you want exact task-level append tracking.

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
  "workspaceRoot": "/home/user/plugins:~/codex",
  "codexCommand": "codex",
  "codexArgs": ["--json", "--skip-git-repo-check", "--ask-for-approval", "never"]
}
```

`CODEX_WEIXIN_WORKSPACE_ROOT`, `CODEX_WEIXIN_CODEX_COMMAND`, and `CODEX_WEIXIN_CODEX_ARGS` can override those fields.

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
