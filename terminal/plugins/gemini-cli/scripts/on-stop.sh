#!/bin/bash
# Stop: Claude finished its turn.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# Legacy fallback for old Rook versions.
if ! should_use_structured; then
    exit 0
fi

INPUT=$(cat)

# One pass for both fields this hook needs out of its own input.
read -r STOP_HOOK_ACTIVE TRANSCRIPT_PATH < <(
    printf '%s' "$INPUT" | jq -r '"\(.stop_hook_active // false) \(.transcript_path // "")"' 2>/dev/null
)
[ "$STOP_HOOK_ACTIVE" = "true" ] && exit 0

# The Stop hook fires before Claude Code has flushed the turn, so the last
# messages are not on disk yet. This wait is why this hook is slower than the
# others, and it is deliberate rather than overhead to remove.
sleep 0.3

source "$SCRIPT_DIR/transcript-tail.sh"
TAIL=$(transcript_tail "$TRANSCRIPT_PATH")

source "$SCRIPT_DIR/emit-event.sh"
emit_event "$INPUT" "stop" \
    '($tail | fromjson) as $t
     | {query: $t.query, response: $t.response, transcript_path: (.transcript_path // "")}' \
    --arg tail "$TAIL"
