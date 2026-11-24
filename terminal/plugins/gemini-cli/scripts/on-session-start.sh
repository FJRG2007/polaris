#!/bin/bash
# SessionStart: tells Rook a Gemini CLI session began.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"
should_use_structured || exit 0

if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' '{"systemMessage": "Rook notifications need jq. Install it with your package manager (brew install jq, apt install jq, winget install jqlang.jq)."}'
    exit 0
fi

source "$SCRIPT_DIR/emit-event.sh"
# --slurpfile reads the manifest inside the one jq that builds the payload.
emit_event - "session_start" '{plugin_version: ($ext[0].version // "unknown")}' \
    --slurpfile ext "$SCRIPT_DIR/../gemini-extension.json"
