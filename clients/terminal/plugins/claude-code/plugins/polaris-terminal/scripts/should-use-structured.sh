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

# Last known Polaris Terminal release per channel that unconditionally set
# POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION without gating it behind the
# HOANotifications feature flag. These builds advertise protocol
# support but can't actually render structured notifications.
LAST_BROKEN_DEV=""
LAST_BROKEN_STABLE="v0.2026.03.25.08.24.stable_05"
LAST_BROKEN_PREVIEW="v0.2026.03.25.08.24.preview_05"

should_use_structured() {
    # No protocol version advertised → Polaris Terminal doesn't know about structured notifications.
    [ -z "${POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION:-}" ] && return 1

    # No client version available → can't verify this build has the fix.
    # (This catches the broken prod release before this was set, but after POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION was set without a flag check.)
    [ -z "${POLARIS_TERMINAL_CLIENT_VERSION:-}" ] && return 1

    # Check whether this version is at or before the last broken release for its channel.
    local threshold=""
    case "$POLARIS_TERMINAL_CLIENT_VERSION" in
        *dev*)     threshold="$LAST_BROKEN_DEV" ;;
        *stable*)  threshold="$LAST_BROKEN_STABLE" ;;
        *preview*) threshold="$LAST_BROKEN_PREVIEW" ;;
    esac

    # If we matched a channel and the version is <= the broken threshold, fall back.
    if [ -n "$threshold" ] && [[ ! "$POLARIS_TERMINAL_CLIENT_VERSION" > "$threshold" ]]; then
        return 1
    fi

    return 0
}
