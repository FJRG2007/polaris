#!/bin/bash
# Write the relay's configuration from the environment, then hand over to go2rtc.
#
# One file, two owners. Everything above `streams:` is what Polaris decides, and
# it is rewritten on every boot so a change made here reaches a relay that was
# installed months ago - the file lives in a volume that outlives the image, and
# writing it only once means shipping a fix nobody receives. Everything from
# `streams:` down belongs to go2rtc: it rewrites that section every time a camera
# is added, and it is what brings the cameras back after a restart.
set -euo pipefail

CONFIG=/config/go2rtc.yaml

if [ -z "${RELAY_PASSWORD:-}" ]; then
    echo "camera-relay: RELAY_PASSWORD is not set - refusing to start with an open API" >&2
    exit 1
fi

settings() {
    cat <<YAML
api:
  listen: ":1984"
  username: "${RELAY_USERNAME:-polaris}"
  password: "${RELAY_PASSWORD}"
  # Nothing here is meant to be opened in a browser: Polaris is the only client,
  # and it asks for streams and stills. Without this the relay serves its own web
  # interface to anybody on the network who finds the port.
  #
  # Whole paths, not prefixes: go2rtc compares these against the request path
  # entire, so a folder like /api/hls allows nothing and every file a player
  # fetches has to be named. Miss them and the stream plays everywhere except on
  # Apple devices, which take no other format.
  allow_paths:
    - /api/streams
    # go2rtc's own log. The only place its reason for a failure exists: asking
    # for a frame from a camera that refused the password answers 200 with an
    # empty body, and the stream record carries no error either - so without
    # this, a working camera and a rejected one are the same answer, and the
    # person reading the screen has no container to look in.
    - /api/log
    - /api/frame.jpeg
    - /api/stream.mp4
    - /api/stream.m3u8
    - /api/hls/playlist.m3u8
    - /api/hls/init.mp4
    - /api/hls/segment.m4s
    - /api/hls/segment.ts
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

YAML
}

# The cameras the relay already holds, exactly as go2rtc wrote them. The key
# itself is always re-emitted bare: an inline `streams: {}` is a mapping go2rtc's
# config writer cannot add a line to, and it fails the entire write - which
# reaches somebody as a camera that was accepted and then has no stream.
cameras() {
    if [ -f "$CONFIG" ] && grep -q '^streams:' "$CONFIG"; then
        sed -n '/^streams:/,$p' "$CONFIG" | tail -n +2
    fi
}

kept=$(cameras)
{
    settings
    echo "streams:"
    if [ -n "$kept" ]; then printf "%s\n" "$kept"; fi
} > "$CONFIG.new"
chmod 600 "$CONFIG.new"
mv "$CONFIG.new" "$CONFIG"

exec "$@"
