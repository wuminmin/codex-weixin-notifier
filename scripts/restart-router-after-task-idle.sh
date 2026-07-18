#!/usr/bin/env bash
set -u

TASK_SESSION="${1:-codex-wx-task-0}"
MAX_POLLS="${CODEX_WEIXIN_RESTART_IDLE_MAX_POLLS:-120}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

is_working() {
  local pane="$1"
  if command -v rg >/dev/null 2>&1; then
    printf '%s\n' "$pane" | rg -q '^[[:space:]]*[•◦]?[[:space:]]*Working[[:space:]]*\('
  else
    printf '%s\n' "$pane" | grep -Eq '^[[:space:]]*[•◦]?[[:space:]]*Working[[:space:]]*\('
  fi
}

for ((attempt = 0; attempt < MAX_POLLS; attempt += 1)); do
  if ! tmux has-session -t "$TASK_SESSION" 2>/dev/null; then
    break
  fi
  pane="$(tmux capture-pane -p -t "$TASK_SESSION" 2>/dev/null || true)"
  if ! is_working "$pane"; then
    break
  fi
  sleep 1
done

exec "$SCRIPT_DIR/start-router-tmux.sh" --restart
