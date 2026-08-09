#!/usr/bin/env bash
set -u

SESSION_NAME="${CODEX_WEIXIN_ROUTER_SESSION:-codex-wx-router}"
NOTIFIER_SESSION_NAME="${CODEX_TOOL_NOTIFIER_SESSION:-codex-wx-tool-notifier}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_PLUGIN_DIR="$(dirname -- "$SCRIPT_DIR")"
PLUGIN_DIR="${CODEX_WEIXIN_PLUGIN_DIR:-$DEFAULT_PLUGIN_DIR}"
ROUTER_SCRIPT="${CODEX_WEIXIN_ROUTER_SCRIPT:-scripts/codex-command-router.mjs}"
NOTIFIER_SCRIPT="${CODEX_TOOL_NOTIFIER_SCRIPT:-scripts/tool-notifier-poll.mjs}"
NODE_BIN="${CODEX_WEIXIN_NODE:-node}"
STATE_DIR="${CODEX_WEIXIN_STATE_DIR:-$HOME/.codex/weixin-notifier}"
PID_FILE="$STATE_DIR/router.pid"
NOTIFIER_PID_FILE="$STATE_DIR/tool-notifier.pid"
QUIET=0
RESTART=0
SKIP_NOTIFIER=0
ROUTER_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet)
      QUIET=1
      ;;
    --restart)
      RESTART=1
      ;;
    --no-restart-tasks)
      ROUTER_ARGS+=("--no-restart-tasks")
      ;;
    --skip-tool-notifier)
      SKIP_NOTIFIER=1
      ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--quiet] [--restart] [--no-restart-tasks] [--skip-tool-notifier]

Starts the Codex notifier channel router (Weixin and Feishu) in tmux, plus an
optional tool-completion poller for Claude Code and opencode sessions.

Options:
  --quiet               Suppress status output.
  --restart             Stop the router first, then start it again. Active task
                        sessions are restarted by the router on startup.
  --no-restart-tasks    Pass through to the router so active task sessions are
                        not restarted on startup.
  --skip-tool-notifier  Do not start the claude/opencode completion poller.
EOF
      exit 0
      ;;
    *)
      printf 'codex-wx-router: unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

say() {
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

write_pid() {
  local pid="$1"
  local target="${2:-$PID_FILE}"
  if [ -n "$pid" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    (printf '%s\n' "$pid" >"$target") 2>/dev/null || true
  fi
}

if ! command -v tmux >/dev/null 2>&1; then
  say "codex-wx-router: tmux not found"
  exit 1
fi

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  say "codex-wx-router: node not found: $NODE_BIN"
  exit 1
fi

if [ ! -d "$PLUGIN_DIR" ]; then
  say "codex-wx-router: plugin directory not found: $PLUGIN_DIR"
  exit 1
fi

if [ ! -f "$PLUGIN_DIR/$ROUTER_SCRIPT" ]; then
  say "codex-wx-router: router script not found: $PLUGIN_DIR/$ROUTER_SCRIPT"
  exit 1
fi

# Skip-tool-notifier mode: tear down any stale poller session so it does not
# survive a --skip-tool-notifier restart.
if [ "$SKIP_NOTIFIER" -eq 1 ] && tmux has-session -t "$NOTIFIER_SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$NOTIFIER_SESSION_NAME" 2>/dev/null || true
fi

if [ "$RESTART" -eq 1 ] && tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if ! tmux kill-session -t "$SESSION_NAME"; then
    say "codex-wx-router: failed to stop tmux session: $SESSION_NAME"
    exit 1
  fi
fi

if [ "$RESTART" -eq 1 ] && tmux has-session -t "$NOTIFIER_SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$NOTIFIER_SESSION_NAME" 2>/dev/null || true
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  pid="$(tmux display-message -p -t "$SESSION_NAME" "#{pane_pid}" 2>/dev/null || true)"
  write_pid "$pid"
  say "codex-wx-router: already running${pid:+ pid=$pid}"
  exit 0
fi

if ! tmux new-session -d -s "$SESSION_NAME" -c "$PLUGIN_DIR" "$NODE_BIN" "$ROUTER_SCRIPT" "${ROUTER_ARGS[@]}"; then
  say "codex-wx-router: failed to start tmux session: $SESSION_NAME"
  exit 1
fi

pid="$(tmux display-message -p -t "$SESSION_NAME" "#{pane_pid}" 2>/dev/null || true)"
write_pid "$pid"
say "codex-wx-router: started${pid:+ pid=$pid}"

if [ "$SKIP_NOTIFIER" -eq 0 ] && [ -f "$PLUGIN_DIR/$NOTIFIER_SCRIPT" ]; then
  if tmux has-session -t "$NOTIFIER_SESSION_NAME" 2>/dev/null; then
    notifier_pid="$(tmux display-message -p -t "$NOTIFIER_SESSION_NAME" "#{pane_pid}" 2>/dev/null || true)"
    write_pid "$notifier_pid" "$NOTIFIER_PID_FILE"
    say "$NOTIFIER_SESSION_NAME: already running${notifier_pid:+ pid=$notifier_pid}"
  else
    if tmux new-session -d -s "$NOTIFIER_SESSION_NAME" -c "$PLUGIN_DIR" "$NODE_BIN" "$NOTIFIER_SCRIPT"; then
      notifier_pid="$(tmux display-message -p -t "$NOTIFIER_SESSION_NAME" "#{pane_pid}" 2>/dev/null || true)"
      write_pid "$notifier_pid" "$NOTIFIER_PID_FILE"
      say "$NOTIFIER_SESSION_NAME: started${notifier_pid:+ pid=$notifier_pid}"
    else
      say "$NOTIFIER_SESSION_NAME: failed to start (router is still running)"
    fi
  fi
fi
