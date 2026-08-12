#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CATM_REPO:-https://github.com/wuminmin/coding-agent-task-monitor.git}"
REPO_REF="${CATM_REF:-main}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
INSTALL_DIR="$DATA_HOME/catm/app"
BIN_DIR="$HOME/.local/bin"
BIN_PATH="$BIN_DIR/catm"
LOCK_PATH="$STATE_HOME/catm/runtime/daemon.lock"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 20+ is required"
command -v npm >/dev/null 2>&1 || die "npm is required"
[ "$(node -p "Number(process.versions.node.split('.')[0])")" -ge 20 ] || die "Node.js 20+ is required"

if [ -f "$LOCK_PATH" ]; then
  legacy_pid="$(head -n 1 "$LOCK_PATH" 2>/dev/null || true)"
  if [[ "$legacy_pid" =~ ^[0-9]+$ ]] && kill -0 "$legacy_pid" 2>/dev/null; then
    legacy_cmd="$(tr '\0' ' ' < "/proc/$legacy_pid/cmdline" 2>/dev/null || true)"
    if [[ "$legacy_cmd" == *"catm-daemon.mjs"* ]]; then
      say "Stopping verified legacy CATM daemon (PID $legacy_pid)"
      kill -TERM "$legacy_pid"
    else
      die "legacy CATM lock points to an unverified process; refusing to stop it"
    fi
  fi
fi

mkdir -p "$DATA_HOME/catm" "$BIN_DIR"
chmod 700 "$DATA_HOME/catm"
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating CATM client in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth=1 origin "$REPO_REF"
  git -C "$INSTALL_DIR" checkout --detach --force FETCH_HEAD
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists but is not a Git checkout"
else
  say "Installing CATM client in $INSTALL_DIR"
  git clone --quiet --depth=1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
fi

npm --prefix "$INSTALL_DIR" ci --omit=dev
chmod +x "$INSTALL_DIR/scripts/catm.mjs"
ln -sfn "$INSTALL_DIR/scripts/catm.mjs" "$BIN_PATH"

say "CATM 2.0 client installed. No local server was started."
say "Run: $BIN_PATH connect --url https://YOUR-NAS.YOUR-TAILNET.ts.net/mcp --agents all"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  say "Add $BIN_DIR to PATH."
fi
