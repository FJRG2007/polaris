#!/bin/sh
# Polaris for Stream Deck: install the plugin, and keep it up to date by itself,
# in the Stream Deck app on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/streamdeck/scripts/install.sh | sh
#
# And to stop the updates and remove it again:
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/streamdeck/scripts/install.sh | sh -s uninstall
#
# What it does: it fetches the newest `streamdeck-v*` release of this
# repository and puts the plugin where the Stream Deck app keeps its plugins,
# ~/Library/Application Support/com.elgato.StreamDeck/Plugins/<uuid>.sdPlugin.
# A `.streamDeckPlugin` file is a zip holding that one folder, so installing it
# silently is unpacking it there. The app reads its plugins when it starts, so
# when it is running it is asked to quit for the swap and opened again in the
# background; when it is not running, nothing is started. If the folder cannot
# be swapped, the file is opened instead, which is the app's own install dialog.
#
# Then it leaves a launchd job of this user's own (no administrator rights)
# that runs every six hours and does the same when a newer release is out.
# What the job runs is a copy of THIS script as the release attached it,
# checked against the digest GitHub publishes for it.
#
# Running the line again is safe: it replaces the job rather than adding a
# second one, and leaves the plugin as it is when it is already current.
#
# Linux has no Stream Deck app. OpenDeck runs the same plugin, but where it
# keeps its plugins is not documented, so it is installed from OpenDeck's own
# Plugins page instead; this script says so and changes nothing there.

set -eu

REPO="${POLARIS_REPO:-FJRG2007/polaris}"
# Only ever changed to test this script against a stand-in.
API="${POLARIS_GITHUB_API:-https://api.github.com}"
AGENT="polaris-streamdeck-installer"
JOB="polaris-streamdeck-update"
# The plugin's identifier, which is also its folder's name (manifest.json `UUID`).
UUID="io.github.fjrg2007.polaris"
# The app's bundle identifier, which is how it is quit and opened.
APP_ID="com.elgato.StreamDeck"
APP_PLUGINS="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
# POLARIS_STREAMDECK_PLUGINS installs somewhere else - only to try this script
# out. The app is never quit or opened for a folder it does not read.
PLUGINS="${POLARIS_STREAMDECK_PLUGINS:-$APP_PLUGINS}"
DIR="$PLUGINS/$UUID.sdPlugin"
BASE="$HOME/Library/Application Support/Polaris/streamdeck"
UPDATER="$BASE/update.sh"
LOG="$BASE/update.log"

SCHEDULED=0
log() {
    if [ "$SCHEDULED" = 1 ]; then
        if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 65536 ]; then rm -f "$LOG"; fi
        printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG" 2>/dev/null || true
    else
        printf 'polaris: %s\n' "$1"
    fi
}
err() {
    if [ "$SCHEDULED" = 1 ]; then log "$1"; else printf 'polaris: %s\n' "$1" >&2; fi
}

fetch() { curl -fsSL -H "User-Agent: $AGENT" -H "Accept: application/vnd.github+json" "$@"; }

# The newest PLUGIN release, which is not the newest release: this repository
# publishes the dashboard too and marks those as latest. Read with awk from
# GitHub's pretty-printed JSON, one field per line, as the extension's does.
newest_tag() {
    fetch "$API/repos/$REPO/releases?per_page=100" |
        awk '
            /"tag_name":/ { tag = $0; sub(/.*"tag_name": *"/, "", tag); sub(/".*/, "", tag) }
            /"prerelease": *true/ || /"draft": *true/ { skip = 1 }
            /"prerelease": *false/ && tag ~ /^streamdeck-v/ && !skip { print tag; exit }
            /"prerelease":/ { skip = 0; tag = "" }
        '
}

# "<url> <digest>" of the first asset whose name matches $2.
asset_of() {
    printf '%s\n' "$1" | awk -v want="$2" '
        /"digest":/ { digest = $0; sub(/.*"digest": *"/, "", digest); sub(/".*/, "", digest) }
        /"digest": *null/ { digest = "" }
        /"browser_download_url":/ {
            url = $0; sub(/.*"browser_download_url": *"/, "", url); sub(/".*/, "", url)
            name = url; sub(/.*\//, "", name)
            if (name ~ want) { print url " " digest; exit }
            digest = ""
        }
    '
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    else
        shasum -a 256 "$1" | awk '{ print $1 }'
    fi
}

# GitHub publishes a sha256 for every asset it stores; a download that does
# not match it is not installed. Assets uploaded before that carry none.
digest_ok() {
    [ -n "$2" ] || return 0
    case "$2" in
        sha256:*) ;;
        *) return 1 ;;
    esac
    [ "$(sha256_of "$1" | tr 'A-F' 'a-f')" = "$(printf '%s' "${2#sha256:}" | tr 'A-F' 'a-f')" ]
}

# A manifest's `Version`, or nothing.
manifest_version() {
    [ -f "$1/manifest.json" ] || return 0
    sed -n 's/.*"Version": *"\([^"]*\)".*/\1/p' "$1/manifest.json" | head -n1
}
manifest_uuid() {
    [ -f "$1/manifest.json" ] || return 0
    sed -n 's/.*"UUID": *"\([^"]*\)".*/\1/p' "$1/manifest.json" | head -n1
}

owns_app() { [ "$PLUGINS" = "$APP_PLUGINS" ]; }

app_running() {
    owns_app || return 1
    [ "$(osascript -e "application id \"$APP_ID\" is running" 2>/dev/null)" = "true" ]
}

quit_app() {
    osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
    tries=0
    while app_running && [ "$tries" -lt 20 ]; do
        sleep 1
        tries=$((tries + 1))
    done
    sleep 2
}

open_app() { open -g -b "$APP_ID" >/dev/null 2>&1 || true; }

launchd_plist() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$JOB"; }

install_job() {
    plist=$(launchd_plist)
    mkdir -p "$(dirname -- "$plist")"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$JOB</string>
    <key>ProgramArguments</key>
    <array><string>/bin/sh</string><string>$UPDATER</string><string>scheduled</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>POLARIS_STREAMDECK_PLUGINS</key><string>$PLUGINS</string>
        <key>POLARIS_REPO</key><string>$REPO</string>
        <key>POLARIS_GITHUB_API</key><string>$API</string>
    </dict>
    <key>StartInterval</key><integer>21600</integer>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
    uid=$(id -u)
    launchctl bootout "gui/$uid/$JOB" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$uid" "$plist" || return 1
}

remove_job() {
    launchctl bootout "gui/$(id -u)/$JOB" >/dev/null 2>&1 || true
    rm -f "$(launchd_plist)"
}

# Fetch, check and put one release in place. Falls back to opening the file.
swap_in() {
    tag=$1 version=$2 url=$3 digest=$4
    stage=$(mktemp -d "$BASE/.incoming-XXXXXX")
    retired="$BASE/.retired-$$"
    trap 'rm -rf "$stage" "$retired"' EXIT INT TERM

    log "fetching $tag"
    file="$stage/${url##*/}"
    fetch "$url" -o "$file" || {
        err "could not download $url"
        return 1
    }
    digest_ok "$file" "$digest" || {
        err "the download for $tag does not match its published digest; nothing was changed"
        return 1
    }
    unzip -q "$file" -d "$stage/unpacked" || {
        err "that download is not a readable plugin file"
        return 1
    }
    fresh="$stage/unpacked/$UUID.sdPlugin"
    if [ "$(manifest_uuid "$fresh")" != "$UUID" ] || [ "$(manifest_version "$fresh")" != "$version.0" ]; then
        err "the file in $tag is not the plugin it says it is; nothing was changed"
        return 1
    fi

    running=0
    if app_running; then
        running=1
        log "closing the Stream Deck app to put the new version in; it opens again by itself"
        quit_app
    fi
    swapped=0
    if [ ! -e "$DIR" ] || mv "$DIR" "$retired"; then
        if mv "$fresh" "$DIR"; then
            swapped=1
        elif [ -e "$retired" ]; then
            mv "$retired" "$DIR"
        fi
    fi
    [ "$running" = 1 ] && open_app

    if [ "$swapped" = 1 ]; then
        log "installed $version"
        return 0
    fi
    if [ "$SCHEDULED" = 0 ] && owns_app; then
        # The app's own install dialog, from the same file.
        keep="$BASE/${url##*/}"
        cp "$file" "$keep" && open "$keep" && {
            log "opened the plugin file instead: confirm the install in the Stream Deck app"
            return 0
        }
    fi
    err "could not put $version in place; the version there was kept"
    return 1
}

main() {
    mode="${1:-install}"
    case "$mode" in
        install | scheduled | uninstall) ;;
        *)
            err "'$mode' is not something this script does. Run it with no argument to install, or with 'uninstall'."
            return 1
            ;;
    esac
    [ "$mode" = scheduled ] && SCHEDULED=1

    if [ "$(uname -s)" != Darwin ] && [ -z "${POLARIS_STREAMDECK_PLUGINS:-}" ]; then
        err "this installs into Elgato's Stream Deck app, which runs on macOS and Windows."
        err "On Linux, OpenDeck runs the same plugin: download the .streamDeckPlugin file"
        err "from your Polaris's Downloads page, then in OpenDeck open Plugins and press"
        err "Install from file."
        return 1
    fi

    if [ "$mode" = uninstall ]; then
        remove_job
        running=0
        if [ -e "$DIR" ] && app_running; then
            running=1
            quit_app
        fi
        rm -rf "$DIR" "$UPDATER" "$LOG"
        [ "$running" = 1 ] && open_app
        log "removed the update job and the plugin"
        return 0
    fi

    for tool in curl unzip awk; do
        command -v "$tool" >/dev/null 2>&1 || {
            err "$tool is needed and was not found"
            return 1
        }
    done

    if [ ! -d "$PLUGINS" ]; then
        if owns_app; then
            err "the Stream Deck app is not installed for this user. Install it from elgato.com, open it once, and run this again."
            return 1
        fi
        mkdir -p "$PLUGINS"
    fi

    # Asked twice: a list GitHub answers while a release is being published has
    # been seen to come back without any plugin release in it.
    tag=$(newest_tag) || tag=""
    if [ -z "$tag" ]; then
        sleep 5
        tag=$(newest_tag) || tag=""
    fi
    [ -n "$tag" ] || {
        err "GitHub listed no Stream Deck plugin release just now, or could not be reached. Run the line again in a minute."
        return 1
    }
    version=${tag#streamdeck-v}
    release=$(fetch "$API/repos/$REPO/releases/tags/$tag") || {
        err "could not read release $tag"
        return 1
    }
    package=$(asset_of "$release" '[.]streamDeckPlugin$')
    [ -n "$package" ] || {
        err "release $tag carries no .streamDeckPlugin file"
        return 1
    }

    mkdir -p "$BASE"
    if [ "$(manifest_version "$DIR")" = "$version.0" ]; then
        [ "$SCHEDULED" = 1 ] || log "$version is already installed"
    else
        swap_in "$tag" "$version" "${package%% *}" "${package#* }" || return 1
    fi

    # The updater the job runs: this script, exactly as the release attached
    # it, refreshed on every run.
    script=$(asset_of "$release" '^install[.]sh$')
    if [ -n "$script" ]; then
        fresh=$(mktemp "$BASE/.update-XXXXXX")
        if fetch "${script%% *}" -o "$fresh" && digest_ok "$fresh" "${script#* }"; then
            mv "$fresh" "$UPDATER"
        else
            rm -f "$fresh"
            log "could not refresh the updater from $tag; keeping the one there was"
        fi
    fi

    updating=0
    if [ "$SCHEDULED" = 0 ] && [ -f "$UPDATER" ]; then
        if [ "$(uname -s)" = Darwin ] && install_job; then
            updating=1
        else
            err "could not set up a job to keep it up to date, so it will not update itself"
        fi
    fi

    if [ "$SCHEDULED" = 0 ]; then
        log ""
        if [ "$updating" = 1 ]; then
            log "It checks for a new version every 6 hours and installs it by itself."
        else
            log "To update it, run this line again."
        fi
        log "Next: open the Stream Deck app, find Polaris in the actions list on the"
        log "right, drag an action onto a key and press Connect in its settings."
    fi
}

main "$@"
