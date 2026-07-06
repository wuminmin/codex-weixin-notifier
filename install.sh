#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="codex-weixin-notifier"
MARKETPLACE_NAME="codex-weixin-notifier"
DISPLAY_NAME="Codex Weixin Notifier"
DEFAULT_REPO_URL="https://github.com/wuminmin/codex-weixin-notifier.git"
DEFAULT_REF="main"

REPO_URL="${CODEX_WEIXIN_REPO:-$DEFAULT_REPO_URL}"
REPO_REF="${CODEX_WEIXIN_REF:-$DEFAULT_REF}"
INSTALL_ROOT="${CODEX_WEIXIN_INSTALL_ROOT:-$HOME/.codex/plugins/$PLUGIN_NAME}"
PLUGIN_DIR="$INSTALL_ROOT/plugins/$PLUGIN_NAME"
MARKETPLACE_FILE="$INSTALL_ROOT/marketplace.json"
SKIP_CODEX_PLUGIN="${CODEX_WEIXIN_SKIP_CODEX_PLUGIN:-0}"
SKIP_NPM="${CODEX_WEIXIN_SKIP_NPM:-0}"

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

node_major_version() {
  node -p "Number(process.versions.node.split('.')[0])"
}

usage() {
  cat <<EOF
Install $DISPLAY_NAME.

Environment overrides:
  CODEX_WEIXIN_REPO              Git repository URL. Default: $DEFAULT_REPO_URL
  CODEX_WEIXIN_REF               Git branch or tag. Default: $DEFAULT_REF
  CODEX_WEIXIN_INSTALL_ROOT      Install root. Default: ~/.codex/plugins/$PLUGIN_NAME
  CODEX_WEIXIN_SKIP_CODEX_PLUGIN Set to 1 to skip Codex plugin registration.
  CODEX_WEIXIN_SKIP_NPM          Set to 1 to skip npm dependency install.

Example:
  curl -fsSL https://raw.githubusercontent.com/wuminmin/codex-weixin-notifier/main/install.sh | bash
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

need_cmd git
need_cmd node

if [ "$(node_major_version)" -lt 20 ]; then
  die "Node.js 20 or newer is required; found $(node -v)"
fi

if [ "$SKIP_NPM" != "1" ]; then
  need_cmd npm
fi

if ! command -v tmux >/dev/null 2>&1; then
  say "warning: tmux was not found; command routing requires tmux."
fi

mkdir -p "$INSTALL_ROOT/plugins"

if [ -d "$PLUGIN_DIR/.git" ]; then
  say "Updating $PLUGIN_NAME in $PLUGIN_DIR"
  git -C "$PLUGIN_DIR" -c advice.detachedHead=false fetch --depth=1 origin "$REPO_REF"
  git -C "$PLUGIN_DIR" -c advice.detachedHead=false checkout -q FETCH_HEAD
elif [ -e "$PLUGIN_DIR" ]; then
  die "$PLUGIN_DIR already exists and is not a Git checkout"
else
  say "Cloning $PLUGIN_NAME into $PLUGIN_DIR"
  git -c advice.detachedHead=false clone --quiet --depth=1 --branch "$REPO_REF" "$REPO_URL" "$PLUGIN_DIR"
fi

if [ "$SKIP_NPM" != "1" ]; then
  say "Installing Node dependencies"
  npm --prefix "$PLUGIN_DIR" ci --omit=dev
fi

chmod +x "$PLUGIN_DIR"/scripts/*.mjs "$PLUGIN_DIR"/scripts/*.sh

cat >"$MARKETPLACE_FILE" <<EOF
{
  "name": "$MARKETPLACE_NAME",
  "interface": {
    "displayName": "$DISPLAY_NAME"
  },
  "plugins": [
    {
      "name": "$PLUGIN_NAME",
      "source": {
        "source": "local",
        "path": "./plugins/$PLUGIN_NAME"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
EOF

if [ "$SKIP_CODEX_PLUGIN" != "1" ]; then
  if command -v codex >/dev/null 2>&1; then
    say "Registering Codex plugin marketplace"
    if ! codex plugin marketplace add "$INSTALL_ROOT" >/dev/null 2>&1; then
      say "warning: marketplace registration failed or already exists; continuing."
    fi

    say "Installing Codex plugin"
    if ! codex plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME" >/dev/null 2>&1; then
      say "Refreshing existing Codex plugin install"
      codex plugin remove "$PLUGIN_NAME@$MARKETPLACE_NAME" >/dev/null 2>&1 || true
      if ! codex plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME" >/dev/null 2>&1; then
        say "warning: Codex plugin install failed."
        say "         Try: codex plugin add $PLUGIN_NAME@$MARKETPLACE_NAME"
      fi
    fi
  else
    say "warning: codex command not found; skipped Codex plugin registration."
  fi
fi

cat <<EOF

$DISPLAY_NAME installed.

Plugin directory:
  $PLUGIN_DIR

Next steps:
  node "$PLUGIN_DIR/scripts/pair-weixin.mjs"
  node "$PLUGIN_DIR/scripts/bind-recipient.mjs"
  "$PLUGIN_DIR/scripts/start-router-tmux.sh"
EOF
