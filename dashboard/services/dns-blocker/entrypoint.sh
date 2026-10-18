#!/bin/sh
# Writes the configuration Polaris rendered, then runs Blocky. Refuses to start
# without one rather than coming up as a resolver nobody configured.
set -eu

if [ -z "${BLOCKY_CONFIG_BASE64:-}" ]; then
    echo "dns-blocker: BLOCKY_CONFIG_BASE64 is not set; refusing to start without a configuration" >&2
    exit 1
fi

printf '%s' "$BLOCKY_CONFIG_BASE64" | base64 -d > "$BLOCKY_CONFIG_FILE"

exec "$@"
