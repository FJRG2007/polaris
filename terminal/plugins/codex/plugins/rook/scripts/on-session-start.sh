#!/bin/bash
# SessionStart: tells Rook a Codex session began.
set -euo pipefail

# Keep in sync with .claude-plugin/plugin.json in this plugin.
PLUGIN_VERSION="0.4.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"
should_use_structured || exit 0

source "$SCRIPT_DIR/emit-event.sh"
emit_event - "session_start" '{plugin_version: $plugin_version}' \
    --arg plugin_version "$PLUGIN_VERSION"
