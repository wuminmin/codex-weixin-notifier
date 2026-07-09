#!/usr/bin/env bash
set -u

SESSION_NAME="${CODEX_WEIXIN_ROUTER_SESSION:-codex-wx-router}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_PLUGIN_DIR="$(dirname -- "$SCRIPT_DIR")"
PLUGIN_DIR="${CODEX_WEIXIN_PLUGIN_DIR:-$DEFAULT_PLUGIN_DIR}"
ROUTER_SCRIPT="${CODEX_WEIXIN_ROUTER_SCRIPT:-scripts/weixin-command-router.mjs}"
NODE_BIN="${CODEX_WEIXIN_NODE:-node}"
STATE_DIR="${CODEX_WEIXIN_STATE_DIR:-$HOME/.codex/weixin-notifier}"
PID_FILE="$STATE_DIR/router.pid"
QUIET=0
RESTART=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet)
      QUIET=1
      ;;
    --restart)
      RESTART=1
      ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--quiet] [--restart]

Starts the Codex Weixin router in tmux.

Options:
  --quiet     Suppress status output.
  --restart   Stop the router first, then start it again. Active task sessions
              are restarted by the router on startup.
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
  if [ -n "$pid" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    (printf '%s\n' "$pid" >"$PID_FILE") 2>/dev/null || true
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

if [ "$RESTART" -eq 1 ] && tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if ! tmux kill-session -t "$SESSION_NAME"; then
    say "codex-wx-router: failed to stop tmux session: $SESSION_NAME"
    exit 1
  fi
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  pid="$(tmux display-message -p -t "$SESSION_NAME" "#{pane_pid}" 2>/dev/null || true)"
  write_pid "$pid"
  say "codex-wx-router: already running${pid:+ pid=$pid}"
  exit 0
fi

if ! tmux new-session -d -s "$SESSION_NAME" -c "$PLUGIN_DIR" "$NODE_BIN" "$ROUTER_SCRIPT"; then
  say "codex-wx-router: failed to start tmux session: $SESSION_NAME"
  exit 1
fi

pid="$(tmux display-message -p -t "$SESSION_NAME" "#{pane_pid}" 2>/dev/null || true)"
write_pid "$pid"
say "codex-wx-router: started${pid:+ pid=$pid}"
