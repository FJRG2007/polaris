#!/bin/sh
# Polaris CLI installer for macOS and Linux. It installs the newest CLI release
# from the project's GitHub repository, the way the browser extension is
# installed, and you point it at your Polaris afterwards:
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/packages/cli/scripts/install.sh | sh
#   plr login --url https://your-polaris
#
# The download is checked against the SHA-256 digest GitHub publishes for it.
# A Polaris also serves this script at /cli/install.sh with its own address
# filled in, so the last line it prints names that Polaris; the CLI itself still
# comes from GitHub.
#
# It puts the bundle in ${XDG_DATA_HOME:-~/.local/share}/polaris-cli and two
# launchers, plr and polaris, in ~/.local/bin. Nothing outside your home folder
# is touched and nothing needs root. Running it again updates in place.
#
# It refuses to install on a computer that runs a Polaris SERVER: the server
# puts its own polaris and plr commands on PATH, and the two would collide.
#
# Everything is wrapped in main() so a truncated download cannot run half a
# script.
set -eu

REPO="${POLARIS_REPO:-FJRG2007/polaris}"
# Where GitHub's API is. Only ever changed to test this script against a stand-in.
API="${POLARIS_GITHUB_API:-https://api.github.com}"
# The Polaris to sign in to next, when a Polaris served this script; anything
# that is not an address (the placeholder, unfilled) means none.
POLARIS_URL="${POLARIS_URL:-__POLARIS_URL__}"
# Written into every file this installs, so `plr uninstall` and the server's
# installer can tell them apart from anything else called polaris.
MARKER="polaris-developer-cli"

log() { printf 'polaris-cli: %s\n' "$1"; }
err() { printf 'polaris-cli: %s\n' "$1" >&2; }

# What a Polaris server install leaves on a machine, or nothing. Mirrors
# packages/cli/src/guard.ts, plus a look at Docker for the running stack.
server_install() {
    for f in /usr/local/bin/polaris /usr/local/bin/plr; do
        if [ -f "$f" ] && grep -q "manage a Polaris dashboard deployment" "$f" 2>/dev/null; then
            printf '%s' "the server's own command at $f"
            return 0
        fi
    done
    dir="${POLARIS_INSTALL_DIR:-/opt/polaris}"
    if [ -f "$dir/dashboard/docker/docker-compose.yml" ]; then
        printf '%s' "a server checkout at $dir"
        return 0
    fi
    secrets="${POLARIS_SECRETS_FILE:-/var/lib/polaris/secrets.env}"
    if [ -f "$secrets" ]; then
        printf '%s' "the server's secrets store at $secrets"
        return 0
    fi
    if command -v docker >/dev/null 2>&1; then
        running=$(docker ps -a -q --filter "label=com.docker.compose.project=polaris" 2>/dev/null | head -n1 || true)
        if [ -n "$running" ]; then
            printf '%s' "containers of the 'polaris' Docker Compose project"
            return 0
        fi
    fi
    return 1
}

fetch() { curl -fsSL -H "User-Agent: polaris-cli-installer" -H "Accept: application/vnd.github+json" "$@"; }

# "<url> <digest>" of the bundle on the newest CLI release, or nothing. This
# repository releases the dashboard and the extension too, so the tag prefix is
# what tells them apart; drafts and prereleases are skipped. GitHub prints one
# field per line, and in an asset the digest comes before the download address.
# The list is walked a page at a time, up to ten, while a full page has none.
newest_bundle() {
    page=1
    while [ "$page" -le 10 ]; do
        answer=$(fetch "$API/repos/$REPO/releases?per_page=100&page=$page" | newest_on_page) || return 0
        case "$answer" in
            more) page=$((page + 1)) ;;
            *) printf '%s' "$answer"; return 0 ;;
        esac
    done
}

# "<url> <digest>" from one page of the release list, "more" when the page was
# full without one, or nothing.
newest_on_page() {
    awk '
        /"tag_name":/ { tag = $0; sub(/.*"tag_name": *"/, "", tag); sub(/".*/, "", tag); skip = 0; count++ }
        /"draft": *true/ || /"prerelease": *true/ { skip = 1 }
        /"digest":/ { digest = $0; sub(/.*"digest": *"/, "", digest); sub(/".*/, "", digest) }
        /"digest": *null/ { digest = "" }
        /"browser_download_url":/ {
            url = $0; sub(/.*"browser_download_url": *"/, "", url); sub(/".*/, "", url)
            name = url; sub(/.*\//, "", name)
            if (tag ~ /^cli-v/ && !skip && name == "polaris.mjs" && digest ~ /^sha256:/) { print url " " digest; found = 1; exit }
            digest = ""
        }
        END { if (!found && count >= 100) print "more" }
    '
}

# The startup file of the user's shell, where ~/.local/bin is put on PATH.
shell_rc() {
    case "$(basename "${SHELL:-sh}")" in
        zsh) printf '%s/.zshrc' "$HOME" ;;
        bash) printf '%s/.bashrc' "$HOME" ;;
        *) printf '%s/.profile' "$HOME" ;;
    esac
}

main() {
    case "$POLARIS_URL" in
        http://* | https://*) ;;
        *) POLARIS_URL="" ;;
    esac

    # Git Bash, MSYS and Cygwin run Windows' own Node, which keeps its files in
    # Windows' places - so a CLI installed into ~/.local from here could not find
    # or remove itself. Windows has its own line.
    case "$(uname -s 2>/dev/null)" in
        MINGW* | MSYS* | CYGWIN*)
            err "this is the installer for macOS and Linux. On Windows, run this in PowerShell instead:"
            err "  irm https://raw.githubusercontent.com/$REPO/main/dashboard/packages/cli/scripts/install.ps1 | iex"
            exit 1
            ;;
    esac

    if ! command -v node >/dev/null 2>&1; then
        err "the CLI runs on Node.js 20 or newer, and node is not installed: https://nodejs.org"
        exit 1
    fi
    if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
        err "the CLI needs Node.js 20 or newer; this computer has $(node --version). Update it: https://nodejs.org"
        exit 1
    fi
    command -v curl >/dev/null 2>&1 || { err "curl is required to download the CLI"; exit 1; }

    if found=$(server_install); then
        err "this computer runs a Polaris server ($found)."
        err "the server has its own polaris and plr commands, and the CLI would collide with them,"
        err "so it is not installed here. Use the CLI from another computer."
        exit 1
    fi

    data="${XDG_DATA_HOME:-$HOME/.local/share}/polaris-cli"
    bin="$HOME/.local/bin"
    mkdir -p "$data" "$bin"

    found_bundle=$(newest_bundle || true)
    if [ -z "$found_bundle" ]; then
        err "could not find a CLI release on github.com/$REPO. Check that this computer can open github.com, then try again."
        exit 1
    fi
    url=${found_bundle% *}
    expected=${found_bundle#* sha256:}

    tmp=$(mktemp "$data/polaris.mjs.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    log "downloading the CLI from $url"
    if ! curl -fsSL -H "User-Agent: polaris-cli-installer" -o "$tmp" "$url"; then
        err "could not download it from $url. Check that this computer can open github.com, then try again."
        exit 1
    fi

    # Checked against the digest GitHub published for it, so a truncated or
    # swapped download is never installed.
    actual=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp")
    if [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" != "$actual" ]; then
        err "the download did not match its checksum; nothing was installed. Try again."
        exit 1
    fi

    chmod 755 "$tmp"
    mv "$tmp" "$data/polaris.mjs"
    printf '{\n    "marker": "%s",\n    "origin": "https://github.com/%s",\n    "repo": "%s",\n    "sha256": "%s",\n    "installedAt": "%s"\n}\n' \
        "$MARKER" "$REPO" "$REPO" "$actual" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$data/polaris-cli.json"

    for name in plr polaris; do
        target="$bin/$name"
        # Never replace a polaris or plr that is not this CLI's own launcher.
        if [ -e "$target" ] && ! grep -q "$MARKER" "$target" 2>/dev/null; then
            err "$target already exists and is not the Polaris CLI; leaving it alone."
            continue
        fi
        printf '#!/bin/sh\n# %s: launcher for the Polaris CLI\nexec node "%s/polaris.mjs" "$@"\n' "$MARKER" "$data" >"$target"
        chmod 755 "$target"
    done

    case ":$PATH:" in
        *":$bin:"*) on_path=1 ;;
        *) on_path=0 ;;
    esac
    if [ "$on_path" = "0" ]; then
        rc=$(shell_rc)
        if ! grep -q "$MARKER" "$rc" 2>/dev/null; then
            printf '\nexport PATH="$HOME/.local/bin:$PATH" # %s\n' "$MARKER" >>"$rc"
        fi
        log "added $bin to PATH in $rc; open a new terminal to use plr."
    fi

    log "installed plr (also polaris)."
    log "next: plr login --url ${POLARIS_URL:-https://your-polaris}"
}

main "$@"
