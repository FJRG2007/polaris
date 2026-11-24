#!/bin/bash
# Hook script for Claude Code SessionStart event
# Shows welcome message and Polaris Terminal detection status

# Check if running in Polaris Terminal terminal
if [ "$TERM_PROGRAM" = "PtermTerminal" ]; then
    # Running in Polaris Terminal - notifications will work
    cat << 'EOF'
{
  "systemMessage": "🔔 Polaris Terminal plugin active. You'll receive native Polaris Terminal notifications when tasks complete or input is needed."
}
EOF
else
    exit 0
fi
