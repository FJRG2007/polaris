#!/bin/bash
# Reads the last user prompt and the last assistant reply out of a transcript.
#
# The two used to be separate `jq -rs` passes. `-s` slurps: it materialises the
# entire JSONL transcript as one array before the filter runs, so a long session
# paid for its whole history twice on every turn that ended. This streams with
# `inputs` instead, in a single pass, keeping only the two lines it needs.
#
# Prints a JSON object {query, response}, both truncated for display.
transcript_tail() {
    local path="$1"
    if [ -z "$path" ] || [ ! -f "$path" ]; then
        printf '%s' '{"query":"","response":""}'
        return 0
    fi

    jq -nc '
        def text_of:
            if .message.content | type == "string" then .message.content
            else [.message.content[]? | select(.type == "text") | .text] | join(" ")
            end;
        def clip: if (. | length) > 200 then .[0:197] + "..." else . end;

        reduce inputs as $line ({query: "", response: ""};
            if $line.type == "user"
               # A "user" line is either a real prompt or a tool result. Only the
               # former carries text, which is what tells them apart.
               and (($line.message.content | type) == "string"
                    or ([$line.message.content[]? | select(.type == "text")] | length) > 0)
            then .query = ($line | text_of)
            elif $line.type == "assistant" and $line.message.content
            then .response = ($line | text_of)
            else .
            end)
        | {query: (.query | clip), response: (.response | clip)}
    ' "$path" 2>/dev/null || printf '%s' '{"query":"","response":""}'
}
