#!/bin/bash
# UserPromptSubmit: reports the prompt the user just sent.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# No legacy equivalent for this hook.
should_use_structured || exit 0

source "$SCRIPT_DIR/emit-event.sh"
emit_event - "prompt_submit" \
    "{query: ((.prompt // \"\") | if (. | length) > 200 then .[0:197] + \"...\" else . end)}"
