#!/bin/sh
# Polaris browser extension: install AND update, for Chrome, Edge, Brave and
# Opera on macOS and Linux. Run the same line either way.
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/extension/scripts/install.sh | sh
#
# What it does, and why it is worth a script at all: it puts the extension in ONE
# fixed folder and replaces what is there. An unpacked extension is re-read from
# the folder it was loaded from, so once the browser has been pointed at that
# folder every later version is the refresh arrow on the extensions page and
# nothing else - no second "Load unpacked", no second copy, no folder per
# version. Doing it by hand works too; doing it by hand into a DIFFERENT folder
# each time is what makes updating feel like installing again.
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

# One fixed home per platform, following what each system already does with
# application data. Override with POLARIS_EXTENSION_DIR if you keep such things
# somewhere else - but keep it the same folder every time, which is the point.
default_dir() {
    case "$(uname -s)" in
        Darwin) printf '%s/Library/Application Support/Polaris/extension/chrome' "$HOME" ;;
        *) printf '%s/polaris/extension/chrome' "${XDG_DATA_HOME:-$HOME/.local/share}" ;;
    esac
}

log() { printf 'polaris: %s\n' "$1"; }
err() { printf 'polaris: %s\n' "$1" >&2; }

# The newest extension release, which is NOT the newest release. This repository
# publishes the dashboard too and marks those as latest, so asking for
# `releases/latest` answers with a dashboard build that carries no extension at
# all. The tag prefix is the thing that tells them apart.
newest_extension_tag() {
    curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" |
        sed -n 's/.*"tag_name": *"\(extension-v[^"]*\)".*/\1/p' |
        head -n1
}

# The Chromium package on that release, asked for rather than spelled out.
#
# Published releases do not agree on a filename. `wxt zip` used to name its
# output after the package and the version - `polarisextension-0.1.0-chrome.zip`
# - and the config now pins one stable name per browser instead. Both kinds of
# release exist and both are installable, since POLARIS_EXTENSION_TAG is how
# somebody pins an older one, so a name written here is a name that is right for
# some releases and a 404 from the middle of an install for the others.
#
# The release knows what it carries. This asks it, the way the dashboard's own
# download already does, and then no future change of naming reaches this file at
# all.
#
# "chrome" alone identifies it: the other two packages are the Firefox build and
# the sources archive Firefox's review asks for, and neither carries that word.
chrome_asset_url() {
    curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$1" |
        sed -n 's/.*"browser_download_url": *"\([^"]*chrome[^"]*\.zip\)".*/\1/p' |
        head -n1
}

main() {
    for tool in curl unzip; do
        command -v "$tool" >/dev/null 2>&1 || {
            err "$tool is needed and was not found"
            return 1
        }
    done

    dir="${POLARIS_EXTENSION_DIR:-$(default_dir)}"
    tag="${POLARIS_EXTENSION_TAG:-$(newest_extension_tag)}"
    [ -n "$tag" ] || {
        err "no extension release has been published yet"
        return 1
    }

    url=$(chrome_asset_url "$tag")
    [ -n "$url" ] || {
        err "release $tag carries no Chromium package"
        return 1
    }
    tmp=$(mktemp -d)
    # The download and the unpack happen away from the live folder, so a failure
    # half way leaves the working copy the browser is loading exactly as it was.
    trap 'rm -rf "$tmp"' EXIT INT TERM

    log "fetching $tag"
    curl -fsSL "$url" -o "$tmp/extension.zip" || {
        err "could not download $url"
        return 1
    }
    unzip -q "$tmp/extension.zip" -d "$tmp/unpacked" || {
        err "that download is not a readable zip"
        return 1
    }

    mkdir -p "$(dirname -- "$dir")"
    rm -rf "$dir"
    mv "$tmp/unpacked" "$dir"

    log "installed in $dir"
    log ""
    log "First time: open chrome://extensions (brave://, edge:// or opera:// in"
    log "those), turn on Developer mode, press Load unpacked and choose:"
    log "  $dir"
    log ""
    log "Every time after: run this again, then press the refresh arrow on the"
    log "Polaris card. The folder does not change, so nothing else has to."
}

main "$@"
