#!/bin/bash
# PostToolUse: moves the session from Blocked back to Running.
#
# This fires after every single tool call, so it is the hottest hook the plugin
# has and the one worth keeping cheap.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# No legacy equivalent for this hook.
should_use_structured || exit 0

source "$SCRIPT_DIR/emit-event.sh"
emit_event - "tool_complete" "{tool_name: (.tool_name // \"\")}"
