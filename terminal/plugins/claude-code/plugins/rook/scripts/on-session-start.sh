#!/bin/bash
# SessionStart: tells Rook a CLI agent session began, and which plugin version.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# Legacy fallback for old Rook versions.
if ! should_use_structured; then
    exec "$SCRIPT_DIR/legacy/on-session-start.sh"
fi

if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' '{"systemMessage": "Rook notifications need jq. Install it with your package manager (brew install jq, apt install jq, winget install jqlang.jq)."}'
    exit 0
fi

# Claude Code's version decides how the sequence is delivered, and it is cached
# in the session env file so later hooks never look again.
#
# The lookup used to run `claude --version` unconditionally, which starts the
# whole Claude Code binary during session startup - the single most expensive
# thing this plugin did, on the path the user is already waiting on. It now only
# runs when there is somewhere to cache the answer, so it happens at most once
# per session instead of once per session start with no cache.
if [ -z "${CLAUDE_CODE_VERSION:-}" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    CC_VERSION=$(claude --version 2>/dev/null | head -1 || true)
    if [ -n "$CC_VERSION" ]; then
        printf 'export CLAUDE_CODE_VERSION=%q\n' "$CC_VERSION" >> "$CLAUDE_ENV_FILE"
        export CLAUDE_CODE_VERSION="$CC_VERSION"
    fi
fi

source "$SCRIPT_DIR/emit-event.sh"
# --slurpfile reads plugin.json inside the one jq that builds the payload,
# rather than shelling out to a second one to read a single field.
emit_event - "session_start" \
    '{plugin_version: ($plugin[0].version // "unknown")}' \
    --slurpfile plugin "$SCRIPT_DIR/../.claude-plugin/plugin.json"
