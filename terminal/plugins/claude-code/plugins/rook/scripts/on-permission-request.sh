#!/bin/bash
# PermissionRequest: the agent is blocked asking to run something.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# No legacy equivalent for this hook.
should_use_structured || exit 0

source "$SCRIPT_DIR/emit-event.sh"
emit_event - "permission_request" \
    "(.tool_name // \"unknown\") as \$tool
     | ((.tool_input // {})
        | if .command then .command elif .file_path then .file_path else (tostring) end
        | if (. | length) > 120 then .[0:117] + \"...\" else . end) as \$preview
     | {tool_name: \$tool,
        tool_input: (.tool_input // {}),
        summary: (\"Wants to run \" + \$tool + (if \$preview == \"\" then \"\" else \": \" + \$preview end))}"
