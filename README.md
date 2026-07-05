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

Or start it in the fixed tmux router session:

```bash
/path/to/codex-weixin-notifier/scripts/start-router-tmux.sh
```

The start script is idempotent: it starts `codex-wx-router` only when that tmux session is missing. It is safe to call from PowerShell, WSL login startup, or Windows Task Scheduler:

```powershell
wsl.exe -- bash -lc "/path/to/codex-weixin-notifier/scripts/start-router-tmux.sh"
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
task close 1
task reset 1
task alias 1 godot
task godot
task tmux clean
pwd
ls
ls /path/to/project
add tests for codex-weixin-notifier
continue by updating the README too
```

The command vocabulary is intentionally small:

```text
list
task 0
task 1
task 2
task close 1
task reset 1
task alias 1 godot
task godot
task unalias godot
task tmux clean
pwd
ls
```

`task 0` is the default Codex assistant and always exists at `~/codex/task0`. `task 1`, `task 2`, and later tasks are explicit task slots created only by `task N` commands. The router handles exact `list`, `task N`, `task close N`, `task reset N`, `task alias N name`, `task name`, and `task tmux clean` messages, plus a small WSL command whitelist: `pwd`, `ls`, and `ls` with one optional path or common flags such as `-la`. Every other Weixin message is forwarded to the current task.

Task ids are monotonic and are never deleted or reused. If the next id is `3`, `task 3` may create `~/codex/task3`, but `task 5` is rejected until `task 3` and `task 4` exist. `task 0` is protected and cannot be closed.

`task close` accepts one or more task ids or aliases:

```text
task close 1
task close 1 godot
```

`task reset` accepts one or more task ids or aliases. It clears Codex resume state so the next message starts a fresh Codex session in the same fixed task directory. It does not delete files, aliases, task ids, historical log files, or `~/codex/taskN` content; it only clears the task's pointer to the previous run logs so old session ids cannot be restored. Running tasks must be closed first:

```text
task close 1
task reset 1
```

tmux task sessions are fixed by task id:

```text
codex-wx-task-0
codex-wx-task-1
codex-wx-task-2
```

Finished task runs close their tmux session by default. Set `CODEX_WEIXIN_KEEP_TMUX_OPEN=1` or `keepTmuxOpen: true` only when you need a debug shell left open. `task tmux clean` removes old pre-fixed-session names such as `codex-wx-task-1-wxrun-...` and `codex-wx-task-1-wxr-...`.

When the router starts or receives a new ordinary task message, it refreshes the recorded task runner state. If a task is marked `running` or `queued` but the recorded tmux session or pid no longer exists, the router clears the stale runner fields. If that task has pending instructions, the router automatically resumes the queue instead of leaving new messages stuck behind a dead run.

Ordinary Weixin messages use a global approval-first rule before execution. Unless the current message contains an approval phrase or a clear approval intent, the child Codex task should quickly return an intent confirmation or short plan instead of editing files, running shell commands, starting apps, installing packages, launching long-running work, or sending media. Default approval phrases:

```text
同意, 批准, 审批通过, 可以, 执行, 开始, 做吧, 继续, 按计划, ok, yes, go ahead, approve
```

Override them with `CODEX_WEIXIN_EXECUTION_APPROVAL_PHRASES` as a comma-separated list, or `executionApprovalPhrases` in `~/.codex/weixin-notifier.json`.

Replies are prefixed with the task id:

```text
task 0: 已开始
task 1: completed
```

`list` shows the numbered task list with current/default markers:

```text
task 0 [default,current]
状态: default
目录: ~/codex/task0
摘要: 默认 Codex 助理

task 1 [running]
别名: godot
状态: running
目录: ~/codex/task1
摘要: 修改微信路由
```

Local smoke checks:

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

Optional command-router config fields in `~/.codex/weixin-notifier.json`:

```json
{
  "codexCommand": "codex",
  "codexSandbox": "workspace-write",
  "codexGlobalArgs": ["--ask-for-approval", "never", "--sandbox", "workspace-write"],
  "codexArgs": ["--json", "--skip-git-repo-check"]
}
```

By default, Weixin tasks run child Codex with `--sandbox workspace-write`, which can write the fixed task directory `~/codex/taskN` and temporary files while still avoiding full WSL access. To intentionally run child Codex without sandboxing, set `CODEX_WEIXIN_CODEX_BYPASS_SANDBOX=1` or `"codexBypassSandbox": true`; this is dangerous because a Weixin message can then trigger writes anywhere the WSL user can access.

`runner` defaults to `tmux` when tmux is installed, and falls back to direct `spawn` otherwise. tmux tasks keep an attachable session open after Codex exits so you can inspect the terminal:

```bash
tmux attach -t codex-wx-task-...
```

All task working directories are fixed under `~/codex/taskN`. `CODEX_WEIXIN_TASK_ROOT` can override the root for tests or a custom install. `CODEX_WEIXIN_RUNNER`, `CODEX_WEIXIN_CODEX_COMMAND`, `CODEX_WEIXIN_CODEX_SANDBOX`, `CODEX_WEIXIN_CODEX_BYPASS_SANDBOX`, `CODEX_WEIXIN_CODEX_GLOBAL_ARGS`, and `CODEX_WEIXIN_CODEX_ARGS` can override runtime behavior.

## Weixin Attachments

The command router accepts inbound Weixin image and file messages for the current task:

- Inbound images are downloaded into `~/codex/taskN/inbox/` and passed to Codex with `codex exec --image /path/to/image`.
- Inbound files are downloaded into `~/codex/taskN/inbox/` and their local paths are included in the Codex prompt so the task can read them directly.
- If a task is already running, the text plus attachment paths are queued together and started after the current run finishes.
- Attachments use the same 20 MB default size limit as media replies; override it with `CODEX_WEIXIN_MAX_MEDIA_BYTES` or `maxMediaBytes`.

Local dry-run for the attachment path:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --attach-file /tmp/screenshot.png \
  --message "analyze this image"
```

## Media Replies

The command router can send local images and file attachments back to Weixin when a Codex task includes a media directive on its own line:

```text
Here is the screenshot.
MEDIA:/tmp/screenshot.png
```

Supported behavior:

- Image files such as `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.bmp` are sent as Weixin image messages.
- Other allowed files such as `.txt`, `.log`, `.json`, `.pdf`, `.zip`, Office documents, and archives are sent as Weixin file attachments.
- Media is uploaded through the official iLink `getuploadurl` plus Weixin CDN flow before `sendmessage`.
- If upload or send fails, the router sends a text fallback describing the failed path and error.

Safety limits:

- Files must be under `~` or `/tmp` by default.
- Override allowed roots with `CODEX_WEIXIN_MEDIA_ROOTS` or `mediaRoots` in `~/.codex/weixin-notifier.json`.
- Files are limited to 20 MB by default.
- Override the limit with `CODEX_WEIXIN_MAX_MEDIA_BYTES` or `maxMediaBytes`.
- If your account uses a non-default CDN URL, set `WEIXIN_CDN_BASE_URL` or `cdnBaseUrl`.

Dry-run a local media path without uploading:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --dry-run \
  --send-media /tmp/screenshot.png \
  --message "screenshot test"
```

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
