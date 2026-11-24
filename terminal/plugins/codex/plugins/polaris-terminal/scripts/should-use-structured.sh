#!/bin/bash
# Determines whether the current Polaris Terminal build supports structured CLI agent notifications.
#
# Usage:
#   source "$SCRIPT_DIR/should-use-structured.sh"
#   if should_use_structured; then
#       # ... send structured notification
#   else
#       # ... legacy fallback or exit
#   fi
#
# Returns 0 (true) when structured notifications are safe to use, 1 (false) otherwise.

should_use_structured() {
    # No protocol version advertised → Polaris Terminal doesn't know about structured notifications.
    [ -z "${POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION:-}" ] && return 1
    # No client version advertised → can't verify the build can render them.
    [ -z "${POLARIS_TERMINAL_CLIENT_VERSION:-}" ] && return 1
    return 0
}
