#!/bin/sh
# Polaris browser extension: install it, and keep it up to date by itself, for
# Chrome, Edge, Brave and Opera on macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/extension/scripts/install.sh | sh
#
# And to stop the updates and remove it again:
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/extension/scripts/install.sh | sh -s -- uninstall
#
# What it does, and why it is worth a script at all: it puts the extension in ONE
# fixed folder. An unpacked extension is re-read from the folder it was loaded
# from, so once the browser has been pointed at that folder a newer version is
# only ever new files in the same place - and the extension notices its own
# files changed and restarts into them (`src/lib/self-update.ts`).
#
# So the script also leaves behind the one thing that puts new files there: a
# job of this user's own - a launchd agent on macOS, a systemd user timer on
# Linux, or a crontab line where there is no systemd - that runs a few times a
# day and at sign-in, asks GitHub for the newest extension release, and swaps
# the folder when there is one. What the job runs is a copy of THIS script as
# the release attached it, checked against the digest GitHub publishes for it
# and refreshed with every update, so the updater is always the one the
# installed version shipped with.
#
# Running the line again is safe: it replaces the job rather than adding a
# second one, and leaves the extension as it is when it is already current.
#
# Firefox is deliberately not handled. A temporary add-on is loaded through
# about:debugging and is gone when Firefox closes, so there is nothing on disk
# for a script to keep current.
#
# Everything is wrapped in main() so a truncated download cannot execute half a
# script, which is the same reason the dashboard's own installer is written that
# way.
set -eu

REPO="${POLARIS_REPO:-FJRG2007/polaris}"
# Where GitHub's API is. Only ever changed to test this script against a
# stand-in; the job carries it, with the folder and the repository, because a
# scheduled run starts with none of the environment the install line ran with.
API="${POLARIS_GITHUB_API:-https://api.github.com}"
AGENT="polaris-extension-installer"
# The name every kind of job is registered under, so a second run finds and
# replaces the first instead of adding another.
JOB="polaris-extension-update"
# Written into the extension's own folder, so the extension can read it and know
# that this copy is kept current by the job rather than by hand.
MARKER="polaris-updater.json"

# One fixed home per platform, following what each system already does with
# application data. Override with POLARIS_EXTENSION_DIR if you keep such things
# somewhere else - but keep it the same folder every time, which is the point.
default_dir() {
    case "$(uname -s)" in
        Darwin) printf '%s/Library/Application Support/Polaris/extension/chrome' "$HOME" ;;
        *) printf '%s/polaris/extension/chrome' "${XDG_DATA_HOME:-$HOME/.local/share}" ;;
    esac
}

SCHEDULED=0
UPDATING=0
log() {
    if [ "$SCHEDULED" = 1 ]; then
        # Nobody is watching a scheduled run, so it keeps a short log instead.
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

# The newest extension release, which is NOT the newest release. This repository
# publishes the dashboard too and marks those as latest, so asking for
# `releases/latest` answers with a dashboard build that carries no extension at
# all. The tag prefix is the thing that tells them apart; drafts and
# prereleases are never listed to somebody without access, and are skipped here
# regardless.
newest_extension_tag() {
    fetch "$API/repos/$REPO/releases?per_page=100" |
        awk '
            /"tag_name":/ { tag = $0; sub(/.*"tag_name": *"/, "", tag); sub(/".*/, "", tag) }
            /"prerelease": *true/ || /"draft": *true/ { skip = 1 }
            /"prerelease": *false/ && tag ~ /^extension-v/ && !skip { print tag; exit }
            /"prerelease":/ { skip = 0; tag = "" }
        '
}

# One asset of a release, as "<url> <digest>" (the digest may be absent), for
# the first asset whose name matches the pattern.
#
# The chrome package is asked for rather than spelled out: published releases do
# not agree on a filename, and "chrome" is the one word that tells it apart from
# the Firefox build and the sources archive.
#
# GitHub prints one field per line, and in an asset the digest comes before the
# download address - so the digest last seen belongs to the next address.
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

# A download that does not match the digest GitHub publishes for it is not
# installed, whatever else it looks like. Releases uploaded before GitHub
# computed digests carry none, and those are accepted on the other checks alone.
digest_ok() {
    [ -n "$2" ] || return 0
    case "$2" in
        sha256:*) ;;
        *) return 1 ;;
    esac
    [ "$(sha256_of "$1" | tr 'A-F' 'a-f')" = "$(printf '%s' "${2#sha256:}" | tr 'A-F' 'a-f')" ]
}

manifest_version() {
    [ -f "$1/manifest.json" ] || return 0
    sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/manifest.json" | head -n1
}

# --- the job, per platform -------------------------------------------------

job_kind() {
    case "$(uname -s)" in
        Darwin) echo launchd ;;
        Linux)
            if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
                echo systemd
            elif command -v crontab >/dev/null 2>&1; then
                echo cron
            else
                echo none
            fi
            ;;
        *) echo none ;;
    esac
}

launchd_plist() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$JOB"; }
systemd_dir() { printf '%s/systemd/user' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

install_job() {
    kind=$(job_kind)
    case "$kind" in
        launchd)
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
        <key>POLARIS_EXTENSION_DIR</key><string>$DIR</string>
        <key>POLARIS_REPO</key><string>$REPO</string>
        <key>POLARIS_GITHUB_API</key><string>$API</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>StartInterval</key><integer>21600</integer>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
            uid=$(id -u)
            launchctl bootout "gui/$uid/$JOB" >/dev/null 2>&1 || true
            launchctl bootstrap "gui/$uid" "$plist" || return 1
            ;;
        systemd)
            unit=$(systemd_dir)
            mkdir -p "$unit"
            cat >"$unit/$JOB.service" <<EOF
[Unit]
Description=Keep the Polaris browser extension up to date

[Service]
Type=oneshot
Environment="POLARIS_EXTENSION_DIR=$DIR" "POLARIS_REPO=$REPO" "POLARIS_GITHUB_API=$API"
ExecStart=/bin/sh "$UPDATER" scheduled
EOF
            cat >"$unit/$JOB.timer" <<EOF
[Unit]
Description=Keep the Polaris browser extension up to date

[Timer]
OnStartupSec=2min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF
            systemctl --user daemon-reload || return 1
            systemctl --user enable --now "$JOB.timer" >/dev/null 2>&1 || return 1
            ;;
        cron)
            line="POLARIS_EXTENSION_DIR='$DIR' POLARIS_REPO='$REPO' POLARIS_GITHUB_API='$API' /bin/sh '$UPDATER' scheduled # $JOB"
            { crontab -l 2>/dev/null | grep -v "# $JOB\$" || true
              printf '17 */6 * * * %s\n' "$line"
              printf '@reboot %s\n' "$line"; } | crontab - || return 1
            ;;
        *)
            # No scheduler this script knows (the caller says so).
            return 1
            ;;
    esac
    log "it updates itself: every 6 hours and when you sign in"
    UPDATING=1
}

remove_job() {
    case "$(uname -s)" in
        Darwin)
            launchctl bootout "gui/$(id -u)/$JOB" >/dev/null 2>&1 || true
            rm -f "$(launchd_plist)"
            ;;
        Linux)
            if command -v systemctl >/dev/null 2>&1; then
                systemctl --user disable --now "$JOB.timer" >/dev/null 2>&1 || true
            fi
            rm -f "$(systemd_dir)/$JOB.service" "$(systemd_dir)/$JOB.timer"
            command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true
            if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q "# $JOB\$"; then
                crontab -l 2>/dev/null | grep -v "# $JOB\$" | crontab -
            fi
            ;;
    esac
}

# --- the folder --------------------------------------------------------------

# Download, check and unpack BESIDE the live folder, on the same filesystem, so
# the swap at the end is two renames and a failure anywhere before it leaves the
# copy the browser is loading exactly as it was.
swap_in() {
    tag=$1 version=$2 url=$3 digest=$4
    stage=$(mktemp -d "$BASE/.incoming-XXXXXX")
    retired="$BASE/.retired-$$"
    # shellcheck disable=SC2064
    trap "rm -rf '$stage' '$retired'" EXIT INT TERM

    log "fetching $tag"
    fetch "$url" -o "$stage/extension.zip" || {
        err "could not download $url"
        return 1
    }
    digest_ok "$stage/extension.zip" "$digest" || {
        err "the download for $tag does not match its published digest; nothing was changed"
        return 1
    }
    unzip -q "$stage/extension.zip" -d "$stage/unpacked" || {
        err "that download is not a readable zip"
        return 1
    }
    if [ "$(manifest_version "$stage/unpacked")" != "$version" ] ||
        ! grep -q '"background"' "$stage/unpacked/manifest.json"; then
        err "the package for $tag is not the extension it says it is; nothing was changed"
        return 1
    fi
    updater_kind=$5
    printf '{"updater":"%s","tag":"%s","updatedAt":"%s"}\n' \
        "$updater_kind" "$tag" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$stage/unpacked/$MARKER"

    # The swap. The live folder is renamed away and the new one renamed in; if
    # the second rename fails the first is undone.
    if [ -e "$DIR" ] && ! mv "$DIR" "$retired"; then
        err "could not move the version in $DIR aside; it was kept"
        return 1
    fi
    if ! mv "$stage/unpacked" "$DIR"; then
        [ -e "$retired" ] && mv "$retired" "$DIR"
        err "could not put $tag in place; the version there was kept"
        return 1
    fi
    log "installed $version in $DIR"
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

    DIR="${POLARIS_EXTENSION_DIR:-$(default_dir)}"
    BASE=$(dirname -- "$DIR")
    UPDATER="$BASE/update.sh"
    LOG="$BASE/update.log"
    [ "$mode" = scheduled ] && SCHEDULED=1

    if [ "$mode" = uninstall ]; then
        remove_job
        rm -rf "$DIR" "$UPDATER" "$LOG"
        log "removed the update job and $DIR"
        log "Remove the Polaris card on your browser's extensions page as well."
        return 0
    fi

    for tool in curl unzip awk; do
        command -v "$tool" >/dev/null 2>&1 || {
            err "$tool is needed and was not found"
            return 1
        }
    done

    # POLARIS_EXTENSION_TAG pins one release instead, and a pinned install is
    # left without the job: somebody who asked for that version asked to stay on
    # it.
    pinned=0
    if [ -n "${POLARIS_EXTENSION_TAG:-}" ]; then
        pinned=1
        tag=$POLARIS_EXTENSION_TAG
    else
        tag=$(newest_extension_tag) || tag=""
    fi
    [ -n "$tag" ] || {
        err "no extension release has been published yet, or GitHub could not be reached"
        return 1
    }
    version=${tag#extension-v}

    release=$(fetch "$API/repos/$REPO/releases/tags/$tag") || {
        err "could not read release $tag"
        return 1
    }
    package=$(asset_of "$release" 'chrome.*[.]zip$')
    [ -n "$package" ] || {
        err "release $tag carries no Chromium package"
        return 1
    }

    mkdir -p "$BASE"
    kind=$(job_kind)
    [ "$pinned" = 1 ] && kind=none

    if [ "$(manifest_version "$DIR")" = "$version" ] && [ -f "$DIR/$MARKER" ]; then
        [ "$SCHEDULED" = 1 ] || log "$version is already installed in $DIR"
    else
        # shellcheck disable=SC2086
        swap_in "$tag" "$version" ${package%% *} "${package#* }" "$kind" || return 1
    fi

    if [ "$pinned" = 1 ]; then
        remove_job
        [ "$SCHEDULED" = 1 ] || log "pinned to $tag, so it will not update itself"
    else
        # The updater the job runs: this script, exactly as the release attached
        # it. Refreshed on every run, so a release that changes how updating
        # works is followed by the job too.
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
        # Set up by a person's run only; a scheduled run leaves its own job alone.
        if [ "$SCHEDULED" = 0 ] && [ -f "$UPDATER" ]; then
            install_job || err "could not set up a job to keep it up to date, so it will not update itself"
        fi
    fi

    # The note in the folder says a job keeps it current. Where none could be
    # set up it says so, and the extension keeps showing the manual steps.
    if [ "$SCHEDULED" = 0 ] && [ -f "$DIR/$MARKER" ]; then
        noted=none
        [ "$UPDATING" = 1 ] && noted=$kind
        sed "s/\"updater\":\"[^\"]*\"/\"updater\":\"$noted\"/" "$DIR/$MARKER" >"$DIR/$MARKER.tmp" &&
            mv "$DIR/$MARKER.tmp" "$DIR/$MARKER"
    fi

    if [ "$SCHEDULED" = 0 ]; then
        log ""
        log "First time: open chrome://extensions (brave://, edge:// or opera:// in"
        log "those), turn on Developer mode, press Load unpacked and choose:"
        log "  $DIR"
        log ""
        if [ "$UPDATING" = 1 ]; then
            log "That is the only time. New versions arrive in that folder by themselves"
            log "and the extension restarts into them."
        else
            log "To update it, run this line again and press the refresh arrow on the"
            log "Polaris card."
        fi
    fi
}

main "$@"
