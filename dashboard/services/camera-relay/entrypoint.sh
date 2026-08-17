#!/bin/bash
# Write the relay's configuration from the environment, then hand over to go2rtc.
#
# Only the parts Polaris decides are written here. Everything else - which
# cameras exist, what they are reached at - is set through the API afterwards and
# persisted by go2rtc into this same file, so a restart comes back with the
# cameras it had.
set -euo pipefail

CONFIG=/config/go2rtc.yaml

if [ -z "${RELAY_PASSWORD:-}" ]; then
    echo "camera-relay: RELAY_PASSWORD is not set - refusing to start with an open API" >&2
    exit 1
fi

# Written once. After the first boot go2rtc owns this file: it rewrites it every
# time a camera is added, and re-templating it here would drop every camera the
# house has on the next restart.
if [ ! -f "$CONFIG" ]; then
    cat > "$CONFIG" <<YAML
api:
  listen: ":1984"
  username: "${RELAY_USERNAME:-polaris}"
  password: "${RELAY_PASSWORD}"
  # Nothing here is meant to be opened in a browser: Polaris is the only client,
  # and it asks for streams and stills. Without this the relay serves its own web
  # interface to anybody on the network who finds the port.
  allow_paths:
    - /api/streams
    - /api/frame.jpeg
    - /api/stream.mp4
    - /api/stream.m3u8
    - /api/webrtc
    - /api/ws

log:
  level: warn

# The port cameras are re-served on inside the network. Left on so a viewer that
# cannot do WebRTC still has somewhere to fall back to.
rtsp:
  listen: ":8554"

webrtc:
  listen: ":8555"

streams: {}
YAML
    chmod 600 "$CONFIG"
fi

exec "$@"
