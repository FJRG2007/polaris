#!/bin/bash
# Notification: the agent is waiting on the user.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    [ "$TERM_PROGRAM" = "RookTerminal" ] && exec "$SCRIPT_DIR/legacy/on-notification.sh"
    exit 0
fi

source "$SCRIPT_DIR/emit-event.sh"
# The event name is the notification type, so it is set from the input here
# rather than passed in.
emit_event - "unknown" \
    "{event: (.notification_type // \"unknown\"),
      summary: ((.message // \"\") | if . == \"\" then \"Input needed\" else . end)}"
