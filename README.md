# Coding Agent Task Monitor

A task monitoring and routing tool for Claude Code, opencode, and Codex. It routes tasks through Weixin, Feishu, and Lark, monitors task state, and sends completion notifications. Feishu/Lark supports multiple enterprise accounts and application bots; every bot has an isolated task pool, attachment tree, state namespace, and tmux sessions.

The project itself does not depend on an AI model. Its control plane—routing, help, status, diagnostics, session selection, and notifications—works even when Codex, Claude Code, and opencode are not installed. An agent is checked and started only when a selected agent receives a task.

## Install

Review the installer first if you want to inspect what it does:

```bash
curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh
```

Install or update with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh | bash
```

If `raw.githubusercontent.com` is rate-limited or blocked, use the GitHub API raw endpoint instead:

```bash
curl -fsSL \
  -H 'Accept: application/vnd.github.raw' \
  'https://api.github.com/repos/wuminmin/coding-agent-task-monitor/contents/install.sh?ref=main' \
  | bash
```

The installer:

- Clones this repository into `~/.codex/plugins/codex-weixin-notifier/plugins/codex-weixin-notifier`.
- Runs `npm ci --omit=dev`.
- Generates `~/.codex/plugins/codex-weixin-notifier/marketplace.json`.
- Registers the local marketplace with `codex plugin marketplace add`.
- Installs or refreshes the plugin with `codex plugin add codex-weixin-notifier@codex-weixin-notifier`.

Requirements:

- Node.js 20 or newer.
- `git` and `npm`.
- `tmux` is only required when an execution session is started.
- Codex CLI, Claude Code, or opencode is only required for tasks sent to that agent. The router and control commands work without any agent installed.
- A Feishu or Lark enterprise self-built app for Feishu/Lark routing. Custom group webhooks are not supported because they cannot receive messages.

Installer overrides:

```bash
curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh \
  | CODEX_WEIXIN_REF=v0.2.0 bash

curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh \
  | CODEX_WEIXIN_INSTALL_ROOT="$HOME/.local/share/codex-weixin-notifier" bash

curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh \
  | CODEX_WEIXIN_SKIP_CODEX_PLUGIN=1 bash

curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh \
  | CODEX_WEIXIN_SKIP_ONBOARDING=1 bash
```

After installation, an interactive terminal automatically starts onboard. You can run it again at any time:

```bash
catm
catm --help
```

Direct examples:

```bash
catm --channel weixin --mode qr
catm --channel feishu --platform feishu --mode qr --account company-a --bot codex-main
catm --channel feishu --platform lark --mode qr --account global-a --bot codex-main
```

First-run journey:

1. Run the installer; in a TTY it starts the `catm` onboarding command.
2. Choose `weixin` or `feishu`; for `feishu`, choose `Feishu China` or `Lark international`.
3. Choose QR scan or manual input. Secrets are hidden during manual input.
4. Complete any Feishu/Lark developer-console publish, permission approval, long-connection, and bot-add steps.
5. Onboard starts the shared router. Send `list` in Weixin/Feishu/Lark, or `@bot list` in a Feishu/Lark group.
6. When you receive a session list after sending `历史`, onboard records success. Feishu/Lark also remembers that chat as the default completion-notification target.
7. Send `新会话` to start Codex, or `新会话 claude` / `新会话 opencode` to start another tool.

## Architecture

- `scripts/pair-weixin.mjs` starts the Tencent iLink QR login flow, shows a terminal QR code, polls for confirmation, and saves credentials to `~/.codex/weixin-notifier.json`.
- `scripts/onboard.mjs` is the first-run setup entry for Weixin, Feishu China, and Lark international.
- `scripts/codex-command-router.mjs` starts every enabled channel in one process. It long-polls the legacy Weixin adapter and establishes one official Feishu/Lark Channel WebSocket connection per enabled application bot.
- `scripts/weixin-command-router.mjs` contains the compatibility Weixin entry and shared phone-session routing. Routing context is `{channel, account, bot, conversation}`; each conversation stores its own current historical or newly-created session.
- `scripts/session-router.mjs` lists local Codex, VS Code Codex, Claude Code, and opencode sessions, starts non-numbered tmux bridges, resumes historical sessions, and routes phone messages to the current bridge.
- `scripts/notify.mjs` is the general completion sender. It performs best-effort fan-out to the configured Weixin bot and every enabled entry in Feishu `notifyTargets`; `scripts/notify-weixin.mjs` remains a Weixin-only compatibility entry.
- `scripts/setup-feishu.mjs` supports hidden interactive App ID/Secret entry, official SDK QR application registration, credential checks, Feishu/Lark platform selection, and mode-`0600` config writes.
- `scripts/codex-task-state-hook.mjs` records Codex lifecycle events from WSL CLI and VS Code into a small local session registry. `scripts/codex-task-monitor.mjs` discovers local sessions and renders the fixed `任务` (sessions), `进度` (progress), and `状态` (status) views without invoking a model.
- Multiple Codex processes are separated by `CODEX_SESSION_ID`, `CODEX_RUN_ID`, or an explicit `--session`; without one, the sender creates a short process-derived id.
- The Weixin transport is based on the official iLink API shape used by `@tencent-weixin/openclaw-weixin`; it does not require the OpenClaw CLI or gateway at runtime.
- The Feishu/Lark transport uses the official [`@larksuiteoapi/node-sdk` Channel](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md), including WebSocket reconnect, message normalization, deduplication, per-chat ordering, native Markdown chunking, media APIs, and group `@bot` policy.

## General Configuration

The general config is `~/.codex/codex-notifier.json`. Resolution order is:

1. Explicit `--config` or `CODEX_NOTIFIER_CONFIG` (the legacy `CODEX_WEIXIN_CONFIG` override is also accepted).
2. `~/.codex/codex-notifier.json`.
3. Legacy `~/.codex/weixin-notifier.json`.

The old config is read in place as `weixin/default/default`; credentials and state are not copied or migrated. When a general config exists but has no `weixin` channel, an existing legacy Weixin config is included automatically. See `scripts/codex-notifier.example.json` for a two-bot example.

```json
{
  "version": 1,
  "defaults": {
    "codexCwd": "~",
    "runner": "interactive",
    "renderMarkdownImages": true
  },
  "channels": {
    "feishu": {
      "accounts": {
        "company-a": {
          "displayName": "Company A",
          "bots": {
            "codex-main": {
              "enabled": true,
              "platform": "feishu",
              "appId": "cli_xxx",
              "appSecret": "secret",
              "notifyTargets": [
                { "id": "ops", "chatId": "oc_xxx", "enabled": true }
              ]
            }
          }
        }
      }
    }
  }
}
```

Set `"platform": "lark"` for Lark international bots. Omitted platform defaults to `"feishu"` for backward compatibility.

General state lives under `~/.codex/codex-notifier/state/<channel>/...`. Account and bot names are combined with a stable short hash for state and tmux names, so punctuation and long names cannot collide. Each Feishu/Lark namespace also records `channel-status.json` and diagnostic logs for connect, reconnect, authentication, permission, and handler failures. The legacy Weixin default keeps `~/.codex/weixin-notifier`, `~/codex/taskN`, and `codex-wx-task-N` unchanged.

## Configure Feishu or Lark

Feishu/Lark routing requires an enterprise self-built application. Each configured `bot` has its own App ID and App Secret; do not reuse one application under multiple bot entries because long connections use cluster delivery and only one connection should run for each application.

Manual setup asks for the Secret interactively so it does not enter shell history:

```bash
node scripts/setup-feishu.mjs \
  --account company-a \
  --bot codex-main \
  --platform feishu \
  --mode manual
```

QR setup uses the official SDK one-click application registration flow and pre-requests bot identity, private-message receive, group `@bot` receive, message send, media, and `im.message.receive_v1` capabilities:

```bash
node scripts/setup-feishu.mjs \
  --account company-a \
  --bot codex-main \
  --platform lark \
  --mode qr
```

After either setup mode:

1. Open the Feishu or Lark developer console and verify the application was created in the intended enterprise.
2. Enable the bot capability and long-connection event subscription.
3. Confirm `im.message.receive_v1` and the requested message/media permissions are approved.
4. Create and publish an application version; enterprise approval may be required.
5. Add the application bot to each target group. In groups, explicitly `@` that bot; direct messages need no mention.
6. Validate credentials and the WebSocket handshake:

```bash
node scripts/setup-feishu.mjs --account company-a --bot codex-main --platform feishu --check
```

Start all enabled Weixin and Feishu adapters with one process:

```bash
node scripts/codex-command-router.mjs
# or
scripts/start-router-tmux.sh --restart
```

Each Feishu/Lark bot has its own phone-session catalog, attachment inboxes, state, and tmux bridges. Conversations using the same bot keep their current session binding by chat `chatId`; identical `open_id` or `chatId` under another bot remains isolated. Replies reference the original message, and topic messages stay in the original topic.

## Completion Notifications

`notify.mjs` sends to Weixin and all enabled Feishu `notifyTargets`. A failure for one target does not stop the others; each target result is printed, and the command exits nonzero if any target failed.

```bash
node scripts/notify.mjs --dry-run --task "Smoke test" --summary "Fan-out test"

node scripts/notify.mjs \
  --channel feishu \
  --platform lark \
  --account company-a \
  --bot codex-main \
  --target ops \
  --task "Deploy complete"
```

`--target` accepts the target `id` or `chatId`. Feishu notification targets use `chatId` for either a group or a direct-message conversation. Feishu replies use native rich text/Markdown and SDK chunking; Weixin continues to render Markdown as long images by default. `task snap` remains a PNG on both channels.

The independent tool completion poller watches `claude` and `opencode` session views every 60 seconds by default and fans out only a persisted `running → completed` transition. Configure it with `CODEX_TOOL_NOTIFIER_INTERVAL_MS`, `CODEX_TOOL_NOTIFIER_SOURCES=claude,opencode`, and `CODEX_TOOL_NOTIFIER_DRY_RUN=1`. Records inactive for seven days are removed automatically; restarting the router does not re-send a session already marked as notified.

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

Run the automated configuration, isolation, queue, setup, and fan-out tests:

```bash
npm test
```

```bash
node /path/to/codex-weixin-notifier/scripts/notify-weixin.mjs \
  --dry-run \
  --session test-cli-1 \
  --source codex-cli \
  --task "Smoke test" \
  --summary "This is a formatting-only test."
```

By default, the dry run prints the generated long-image path or paths instead of uploading:

```text
[dry-run media] image /tmp/codex-weixin-md-.../reply-01.png ...
[dry-run media] image /tmp/codex-weixin-md-.../reply-02.png ...
```

Real send after pairing:

```bash
node /path/to/codex-weixin-notifier/scripts/notify-weixin.mjs \
  --session wsl-test \
  --source codex-cli \
  --task "Codex test" \
  --summary "This should arrive in Weixin."
```

Dry-run one Feishu bot without opening a WebSocket:

```bash
node scripts/codex-command-router.mjs \
  --config /path/to/codex-notifier.json \
  --channel feishu --account company-a --bot codex-main \
  --once --dry-run --message list
```

## Weixin Commands

Start only the legacy-compatible Weixin command router after pairing and binding:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs
```

Or start all configured channels in the fixed tmux router session:

```bash
/path/to/codex-weixin-notifier/scripts/start-router-tmux.sh
```

The start script is idempotent: it starts `codex-wx-router` only when that tmux session is missing. Use `--restart` when you want to stop and relaunch the router; active task sessions are restarted by the router on startup. It is safe to call from PowerShell, WSL login startup, or Windows Task Scheduler:

```powershell
wsl.exe -- bash -lc "/path/to/codex-weixin-notifier/scripts/start-router-tmux.sh"
```

```bash
/path/to/codex-weixin-notifier/scripts/start-router-tmux.sh --restart
```

The same script also keeps the independent `codex-wx-tool-notifier` poller running. Use `--skip-tool-notifier` when only the channel router should run. The poller state is stored separately from Codex tasks:

```text
~/.codex/weixin-notifier/tool-notifier-state.json
~/.codex/weixin-notifier/tool-tasks.json
~/.codex/weixin-notifier/tool-current.json
```

When the current Codex task is the same CLI session performing an update, use `scripts/restart-router-after-task-idle.sh codex-wx-task-N` in a separate tmux session. It waits for the visible `Working (...)` indicator to clear, then restarts the router and all active managed CLI task sessions.

The router stores state in:

```text
~/.codex/weixin-notifier/tasks.json
~/.codex/weixin-notifier/current-task.json
~/.codex/weixin-notifier/codex-sessions.json
~/.codex/weixin-notifier/session-bridges.json
~/.codex/weixin-notifier/session-current.json
~/.codex/weixin-notifier/session-picker.json
~/.codex/weixin-notifier/logs/
```

Send these messages to the paired Weixin bot:

```text
list
列表
任务
进度
状态
help
help agent
帮助 智能体
tool use codex
tool use claude
tool use opencode
tool doctor
工具诊断
tool off
工具退出
task 0
任务 0
task 1
任务 1
task close 1
任务 关闭 1
task reset 1
任务 重置 1
task alias 1 godot
任务 别名 1 godot
task godot
任务 godot
task tmux clean
任务 tmux 清理
task snap
任务 截图
claude 1
claude 1 review this project
opencode 1
opencode 1 inspect the build
tool list
tool close claude 1
tool off
pwd
当前目录
ls
列文件
ls /path/to/project
列文件 /path/to/project
add tests for codex-weixin-notifier
update the README too
```

The current phone-session workflow is:

```text
历史 / 会话                 list local Codex, VS Code, Claude, and opencode sessions
接管 N                      resume the Nth session from the latest history list
当前会话                    show the mobile binding
退出接管                    clear the mobile binding without deleting history
新会话                      start a new Codex session
新会话 claude               start a new Claude Code session
新会话 opencode             start a new opencode session
```

The old numbered task and tool-slot commands below are retained only as legacy documentation for old installations. New routers do not create or restart numbered task tmux sessions; use the phone-session commands above.

The command vocabulary is intentionally small:

```text
list
列表
任务
进度
状态
help
help start
help agent
help task
help monitor
help files
help admin
help all
tool use codex
tool use claude [N]
tool use opencode [N]
tool list
tool doctor
tool off
task 0
任务 0
task 1
任务 1
task 2
任务 2
task close 1
任务 关闭 1
task reset 1
任务 重置 1
task alias 1 godot
任务 别名 1 godot
task godot
任务 godot
task unalias godot
任务 取消别名 godot
task tmux clean
任务 tmux 清理
task snap
任务 截图
task screenshot
截图
pwd
当前目录
ls
列文件
```

`任务`, `进度`, and `状态` are exact local commands and never reach Codex. On the legacy Weixin bot, `任务` merges numbered Weixin tasks with recent WSL CLI and VS Code sessions, `进度` keeps only running or waiting work, and `状态` reports router, tmux, CLI, VS Code app-server, and Hook health. On Feishu, these views are scoped to the current `{account, bot}` namespace so another bot's tasks and paths never appear. `list` / `列表` keeps the numbered-task-only view on either channel.

`task 0` / `任务 0` explicitly selects the default Codex task. `task 1` / `任务 1`, `task 2` / `任务 2`, and later tasks are explicit task slots created only by `task N` or `任务 N` commands. The router handles exact English commands such as `list`, `tasks`, `progress`, `status`, `task N`, `task close N`, `task reset N`, `task alias N name`, `task name`, `task tmux clean`, `task snap`, and `task screenshot`, plus Chinese equivalents such as `列表`, `任务`, `进度`, `状态`, `任务 N`, `任务 关闭 N`, `任务 重置 N`, `任务 别名 N name`, `任务 name`, `任务 tmux 清理`, and `任务 截图`. It also accepts a small local command whitelist: `pwd` / `当前目录`, `ls` / `列文件`, and `ls` / `列文件` with one optional path or common flags such as `-la`. These control commands do not invoke an agent.

Claude Code and opencode are separate from the numbered Codex task system. `tool use claude N` and `tool use opencode N` select or create logical tool slots without starting a process. The first ordinary task sent after selection starts the dedicated tmux session. `tool off` / `工具退出` clears the selection and never falls back to Codex. If no agent is selected, ordinary text and attachments are held until the user chooses one. If the selected agent is missing, the task is blocked without fallback or loss; use `tool doctor` to inspect the host. Tool watchers persist their tmux session, prompt, reply context, and choice state in `tool-tasks.json`, resume after a router restart, detect common numbered choice prompts, and send the final pane output back to the originating chat. The legacy forms `claude N [prompt]` and `opencode N [prompt]` remain supported.

## Local Task Monitor

Add the lifecycle entries from `scripts/codex-task-hooks.example.toml` to the user-level `~/.codex/config.toml`, using the actual absolute plugin path. Restart Codex CLI sessions after changing the configuration and reload the VS Code window when convenient. New or changed command Hooks must be reviewed in `/hooks`; automation that has already vetted the Hook source can use Codex's explicit `--dangerously-bypass-hook-trust` option.

The monitor records only operational task metadata: session id, source surface, working directory, lifecycle status, current tool/stage, and timestamps. It does not call an AI model. Writes to `codex-sessions.json` are lock-protected and atomically renamed so concurrent CLI and VS Code events do not corrupt the registry.

For VS Code threads that were already open before the Hook configuration was loaded, the monitor has a read-only compatibility fallback that scans recent local session transcripts for `task_started` and `task_complete` events. Hook data takes precedence as soon as a lifecycle event is received. Transcript fallback is deliberately limited to recent VS Code sessions because Codex documents transcript files as a convenience rather than a stable Hook API.

Run the same fixed views locally:

```bash
node scripts/codex-task-monitor.mjs tasks
node scripts/codex-task-monitor.mjs progress
node scripts/codex-task-monitor.mjs status
```

By default, each task is a long-running interactive Codex session in a fixed tmux session. When the router starts, it restarts all active task sessions so task tmux panes pick up new router/Codex arguments after a router restart. Set `CODEX_WEIXIN_RESTART_TASKS_ON_ROUTER_START=0`, `"restartTasksOnRouterStart": false`, or pass `--no-restart-tasks` to the router to disable that startup restart. The router starts task `N` with this shape:

```bash
codex --no-alt-screen \
  --dangerously-bypass-approvals-and-sandbox \
  -C "${CODEX_WEIXIN_CODEX_CWD:-$HOME}"
```

When the router receives an ordinary task message, it sends one small text heartbeat such as `task 2 · 处理中`, then sends the message into the task tmux session and starts a background watcher. That heartbeat is the only dispatch acknowledgement: the router does not send a second long-image `interactive 已发送 / 已进入后台等待` reply. The watcher keeps the router free for other Weixin commands, sends choice prompts immediately, and sends the final rendered image after Codex prints `Worked` or returns to the input prompt. It maps `plan ...` / `计划 ...` to Codex CLI `/plan ...`, and maps `goal ...`, `goal status`, `goal pause`, `goal resume`, `goal clear`, plus `目标 ...`, `目标 状态`, `目标 暂停`, `目标 继续`, and `目标 清除`, to the native `/goal` slash command family.

When Codex enters an interactive `Question 1/1` choice prompt, the router formats the full question text and numbered options for Weixin, including wrapped prompt and option lines from the terminal. Reply with the option number, such as `1` or `2`, and the router submits that choice in the task tmux session.

Send `task snap`, `task screenshot`, `任务 截图`, or `截图` to render the current task's tmux pane as one or more terminal-style PNG images and send them back to Weixin. This is a static snapshot; continue to control Codex by sending normal text replies.

Task ids are monotonic and are never deleted or reused. If the next id is `3`, `task 3` may create a task slot and data directory, but `task 5` is rejected until `task 3` and `task 4` exist. `task 0` is protected and cannot be closed.

`task close` accepts one or more task ids or aliases:

```text
task close 1
任务 关闭 1
task close 1 godot
任务 关闭 1 godot
```

`task reset` / `任务 重置` accepts one or more task ids or aliases. It clears Codex resume state so the next message starts a fresh Codex session in the configured working directory. It does not delete files, aliases, task ids, historical log files, or `~/codex/taskN` data directory content; it only clears the task's pointer to the previous run logs so old session ids cannot be restored. Running tasks must be closed first:

```text
task close 1
任务 关闭 1
task reset 1
任务 重置 1
```

tmux task sessions are fixed by task id:

```text
codex-wx-task-0
codex-wx-task-1
codex-wx-task-2
```

Interactive task tmux sessions stay open until `task close N` or the Codex CLI exits. `task tmux clean` removes old pre-fixed-session names such as `codex-wx-task-1-wxrun-...` and `codex-wx-task-1-wxr-...`.

When the router starts or receives a new ordinary task message, it refreshes the recorded task runner state. If a task is marked `running` or `queued` but the recorded tmux session or pid no longer exists, the router clears the stale runner fields. If that task has pending instructions, the router automatically resumes the queue instead of leaving new messages stuck behind a dead run.

Replies are prefixed with the task id:

```text
task 0: 已开始
task 1: completed
```

`list` shows the numbered task list with current/default markers:

```text
task 0 [default,current]
状态: default
工作目录: ~
摘要: 默认 Codex 助理

task 1 [running]
别名: godot
状态: running
工作目录: ~
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

Optional command-router config fields in `~/.codex/weixin-notifier.json`:

```json
{
  "codexCommand": "codex",
  "codexCwd": "~",
  "codexBypassSandbox": true,
  "codexGlobalArgs": ["--dangerously-bypass-approvals-and-sandbox"],
  "codexArgs": ["--json", "--skip-git-repo-check"],
  "interactiveResponseTimeoutMs": 21600000,
  "interactiveWatchStatusIntervalMs": 1800000,
  "renderMarkdownImages": true,
  "chromePath": "/usr/bin/google-chrome",
  "markdownImageWidth": 920,
  "markdownImageMaxChars": 120000,
  "markdownImageMaxHeight": 30000
}
```

For this WSL-first setup, Weixin tasks can run interactive Codex with `--dangerously-bypass-approvals-and-sandbox` by setting `CODEX_WEIXIN_CODEX_BYPASS_SANDBOX=1` or `"codexBypassSandbox": true`. This removes the Codex sandbox and approval prompts for child tasks, so a Weixin message can trigger writes anywhere the WSL user can access. Separately, vetted automation can set `CODEX_WEIXIN_CODEX_BYPASS_HOOK_TRUST=1` or `"codexBypassHookTrust": true` to add Codex's explicit `--dangerously-bypass-hook-trust` flag. Existing tmux task sessions keep the arguments they were started with; close and re-enter a task to pick up changed Codex arguments.

`runner` defaults to `interactive` when tmux is installed. Set `CODEX_WEIXIN_RUNNER=tmux` for the older `codex exec` inside tmux behavior, or `CODEX_WEIXIN_RUNNER=spawn` for direct `codex exec`. Interactive tasks keep an attachable session open:

```bash
tmux attach -t codex-wx-task-...
```

By default, task Codex sessions use `$HOME` as their working directory instead of being pinned to `~/codex/taskN`. Set `CODEX_WEIXIN_CODEX_CWD` or `"codexCwd"` to choose a different default working directory. `~/codex/taskN` is still used as the task data directory for inbound attachments and durable task metadata; `CODEX_WEIXIN_TASK_ROOT` can override that data root for tests or a custom install. `CODEX_WEIXIN_RUNNER`, `CODEX_WEIXIN_CODEX_COMMAND`, `CODEX_WEIXIN_CODEX_SANDBOX`, `CODEX_WEIXIN_CODEX_BYPASS_SANDBOX`, `CODEX_WEIXIN_CODEX_BYPASS_HOOK_TRUST`, `CODEX_WEIXIN_CODEX_GLOBAL_ARGS`, and `CODEX_WEIXIN_CODEX_ARGS` can override runtime behavior.

For interactive replies, the router sends the heartbeat immediately, then tracks the tmux pane in the background until Codex shows a choice prompt, returns to an input prompt, or prints the final `Worked` status before rendering the Weixin image. Watcher state is stored in task metadata so a router restart with `--no-restart-tasks` can resume waiting for the same tmux task. `interactiveResponseTimeoutMs` is only an abnormal watcher timeout and defaults to 21600000 ms. Override it with `CODEX_WEIXIN_INTERACTIVE_RESPONSE_TIMEOUT_MS` or `"interactiveResponseTimeoutMs"`. Long-running tasks send a light status text every 1800000 ms by default; override with `CODEX_WEIXIN_INTERACTIVE_WATCH_STATUS_INTERVAL_MS` or `"interactiveWatchStatusIntervalMs"`, or set it to `0` to disable status pings.

By default, normal text/Markdown replies and completion notifications are rendered as terminal-style long PNG images before being sent to Weixin. Set `renderMarkdownImages: false` or `CODEX_WEIXIN_RENDER_MARKDOWN_IMAGES=0` to force text replies. Optional overrides: `chromePath` / `CODEX_WEIXIN_CHROME_PATH`, `markdownImageWidth` / `CODEX_WEIXIN_MARKDOWN_IMAGE_WIDTH`, `markdownImageMaxChars` / `CODEX_WEIXIN_MARKDOWN_IMAGE_MAX_CHARS`, and `markdownImageMaxHeight` / `CODEX_WEIXIN_MARKDOWN_IMAGE_MAX_HEIGHT`. `markdownImageMaxHeight` is the per-image output PNG height and defaults to `30000` for long-image mode; content beyond that limit is sent as multiple images instead of being clipped. If rendering or image upload fails, the sender falls back to the original text reply.

## Weixin and Feishu Attachments

The command router accepts inbound Weixin image and file messages for the current task:

- Inbound images are downloaded into the task data directory, normally `~/codex/taskN/inbox/`, and passed to Codex with `codex exec --image /path/to/image`.
- Inbound files are downloaded into the task data directory, normally `~/codex/taskN/inbox/`, and their local paths are included in the Codex prompt so the task can read them directly.
- If a task is already running, the text plus attachment paths are queued together and started after the current run finishes.
- Attachments use the same 20 MB default size limit as media replies; override it with `CODEX_WEIXIN_MAX_MEDIA_BYTES` or `maxMediaBytes`.

Feishu uses the same task workflow and size/allowed-directory checks. The official Channel downloads image/file resources into that bot's `taskN/inbox/`; image paths are attached with `--image`, while other file paths are included in the prompt. A file received by one bot is never written to another bot's task tree.

Local dry-run for the attachment path:

```bash
node /path/to/codex-weixin-notifier/scripts/weixin-command-router.mjs \
  --once \
  --dry-run \
  --attach-file /tmp/screenshot.png \
  --message "analyze this image"
```

## Media Replies

The command router can send local images and file attachments back to Weixin or Feishu when a Codex task includes a media directive on its own line:

```text
Here is the screenshot.
MEDIA:/tmp/screenshot.png
```

Supported behavior:

- Image files such as `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.bmp` are sent as Weixin image messages.
- Other allowed files such as `.txt`, `.log`, `.json`, `.pdf`, `.zip`, Office documents, and archives are sent as Weixin file attachments.
- Media is uploaded through the official iLink `getuploadurl` plus Weixin CDN flow before `sendmessage`.
- Feishu media is uploaded with the official Channel image/file APIs and is associated with the originating message or topic.
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

For Codex Stop hooks, use `scripts/codex-finish-hook.mjs` instead of calling a sender directly. It first records the completed task state, then writes the notification event to `/tmp/codex-weixin-notifier-hooks/`, starts the general `notify.mjs` sender in a short-lived background tmux session, and exits immediately so Codex does not fail the hook when rendering or channel APIs take longer than the host hook timeout. Hook launcher and per-target sender output is appended to `/tmp/codex-weixin-notifier-hook.log`. Child tasks launched by any notifier channel set `CODEX_NOTIFIER_ROUTER_TASK=1`, which suppresses duplicate completion notifications.

## Publishing

To publish this as a one-line install project:

1. Make the GitHub repository public or otherwise accessible to installers.
2. Confirm `DEFAULT_REPO_URL` in `install.sh` points at the public repository.
3. Confirm the included MIT `LICENSE` is the license you want, or replace it before inviting outside users.
4. Commit and push `install.sh` and this README update.
5. Tag a stable release, for example `git tag v0.2.0 && git push origin v0.2.0`.
6. Test from a clean shell:

```bash
curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/main/install.sh \
  | CODEX_WEIXIN_INSTALL_ROOT=/tmp/codex-weixin-install-test \
    CODEX_WEIXIN_REF=main \
    CODEX_WEIXIN_SKIP_CODEX_PLUGIN=1 \
    bash
```

For a release-pinned install command, publish:

```bash
curl -fsSL https://raw.githubusercontent.com/wuminmin/coding-agent-task-monitor/v0.2.0/install.sh \
  | CODEX_WEIXIN_REF=v0.2.0 bash
```

If GitHub raw returns `429`, use the API raw endpoint:

```bash
curl -fsSL \
  -H 'Accept: application/vnd.github.raw' \
  'https://api.github.com/repos/wuminmin/coding-agent-task-monitor/contents/install.sh?ref=v0.2.0' \
  | CODEX_WEIXIN_REF=v0.2.0 bash
```

## License

MIT.
