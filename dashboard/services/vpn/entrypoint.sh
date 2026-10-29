#!/bin/sh
# Writes the configuration Polaris rendered, then runs Headscale. Refuses to
# start without one rather than coming up as a control server nobody configured.
set -eu

if [ -z "${HEADSCALE_CONFIG_BASE64:-}" ]; then
    echo "vpn: HEADSCALE_CONFIG_BASE64 is not set; refusing to start without a configuration" >&2
    exit 1
fi

mkdir -p /etc/headscale /var/lib/headscale /var/run/headscale
printf '%s' "$HEADSCALE_CONFIG_BASE64" | base64 -d > "$HEADSCALE_CONFIG"

exec "$@"
