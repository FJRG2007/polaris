#!/bin/bash
# Hook script for Claude Code SessionStart event
# Shows welcome message and Rook detection status

# Check if running in Rook terminal
if [ "$TERM_PROGRAM" = "RookTerminal" ]; then
    # Running in Rook - notifications will work
    cat << 'EOF'
{
  "systemMessage": "🔔 Rook plugin active. You'll receive native Rook notifications when tasks complete or input is needed."
}
EOF
else
    exit 0
fi
