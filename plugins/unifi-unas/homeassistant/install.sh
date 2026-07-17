#!/usr/bin/env sh
# Install the UniFi UNAS (Polaris) integration into Home Assistant.
#
# Run this on the Home Assistant host (e.g. the Terminal & SSH add-on shell, the
# HA container, or a Core venv host). It downloads the latest release and copies
# the integration into <config>/custom_components/unifi_unas/.
#
#   sh install.sh [--config DIR] [--tag TAG]
#
# Or as a one-liner (review the script first if you prefer):
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/plugins/unifi-unas/homeassistant/install.sh | sh
#
# Options:
#   --config DIR   Home Assistant config directory (the one with configuration.yaml).
#                  Auto-detected if omitted; also read from $HA_CONFIG.
#   --tag TAG      Release tag to install (default: the latest release).
set -eu

REPO="FJRG2007/polaris"
ASSET="unifi_unas.zip"
DOMAIN="unifi_unas"
TAG="latest"
CONFIG="${HA_CONFIG:-}"

log() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --config) CONFIG="${2:-}"; shift 2 ;;
        --config=*) CONFIG="${1#*=}"; shift ;;
        --tag) TAG="${2:-}"; shift 2 ;;
        --tag=*) TAG="${1#*=}"; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) err "unknown argument: $1" ;;
    esac
done

# Locate the Home Assistant config directory.
if [ -z "$CONFIG" ]; then
    for candidate in /config /homeassistant "$HOME/.homeassistant" /root/.homeassistant /usr/share/hassio/homeassistant; do
        if [ -f "$candidate/configuration.yaml" ]; then
            CONFIG="$candidate"
            break
        fi
    done
fi
[ -n "$CONFIG" ] || err "could not find the Home Assistant config directory; pass --config DIR"
[ -f "$CONFIG/configuration.yaml" ] || err "'$CONFIG' has no configuration.yaml; is it the HA config directory?"
log "Home Assistant config: $CONFIG"

# Pick a downloader.
if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
else
    err "need curl or wget to download the release"
fi
command -v unzip >/dev/null 2>&1 || err "need unzip (on Alpine/HAOS SSH: 'apk add unzip')"

if [ "$TAG" = "latest" ]; then
    URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
    URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

log "Downloading $ASSET ($TAG)..."
fetch "$URL" "$TMP/$ASSET" || err "download failed ($URL). Is there a published release yet?"
unzip -tq "$TMP/$ASSET" >/dev/null 2>&1 || err "downloaded file is not a valid zip (no release asset?)"

unzip -q "$TMP/$ASSET" -d "$TMP/extracted"
SRC="$TMP/extracted/custom_components/$DOMAIN"
[ -f "$SRC/manifest.json" ] || err "release archive is missing custom_components/$DOMAIN/manifest.json"

TARGET="$CONFIG/custom_components/$DOMAIN"
mkdir -p "$CONFIG/custom_components"
rm -rf "$TARGET"
cp -r "$SRC" "$TARGET"

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TARGET/manifest.json" | head -n1)"
log ""
log "Installed unifi_unas ${VERSION:-?} into $TARGET"
log ""
log "Next steps:"
log "  1. Restart Home Assistant."
log "  2. Settings -> Devices & Services -> Add Integration -> \"UniFi UNAS\"."
