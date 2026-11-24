#!/bin/bash
# StopFailure: the turn ended on an API error rather than a reply.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# Legacy Rook clients have no UI to act on this, so they are not told.
should_use_structured || exit 0

INPUT=$(cat)
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null)

source "$SCRIPT_DIR/transcript-tail.sh"
TAIL=$(transcript_tail "$TRANSCRIPT_PATH")

source "$SCRIPT_DIR/emit-event.sh"
emit_event "$INPUT" "stop_failure" \
    '($tail | fromjson) as $t
     | {query: $t.query,
        response: (.last_assistant_message // ""),
        error_type: (.error // ""),
        transcript_path: (.transcript_path // "")}' \
    --arg tail "$TAIL"
