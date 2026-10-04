#!/bin/sh
# Polaris CLI installer for macOS and Linux. Each Polaris serves this at
# /cli/install.sh with its own address filled in below, so the line on its
# Account > Downloads screen installs the CLI that matches that server:
#
#   curl -fsSL https://your-polaris/cli/install.sh | sh
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
        *)
            err "this script does not know which Polaris it came from."
            err "copy the install line from Account > Downloads on your Polaris instead."
            exit 1
            ;;
    esac

    # Git Bash, MSYS and Cygwin run Windows' own Node, which keeps its files in
    # Windows' places - so a CLI installed into ~/.local from here could not find
    # or remove itself. Windows has its own line.
    case "$(uname -s 2>/dev/null)" in
        MINGW* | MSYS* | CYGWIN*)
            err "this is the installer for macOS and Linux. On Windows, run this in PowerShell instead:"
            err "  irm $POLARIS_URL/cli/install.ps1 | iex"
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

    tmp=$(mktemp "$data/polaris.mjs.XXXXXX")
    headers=$(mktemp)
    trap 'rm -f "$tmp" "$headers"' EXIT
    log "downloading the CLI from $POLARIS_URL"
    if ! curl -fsSL -D "$headers" -o "$tmp" "$POLARIS_URL/cli/polaris.mjs"; then
        err "could not download it from $POLARIS_URL/cli/polaris.mjs. Check that this computer can open $POLARIS_URL."
        exit 1
    fi

    # Checked against the digest the server sent with it, so a truncated or
    # rewritten download is never installed.
    expected=$(tr -d '\r' <"$headers" | sed -n 's/^[Xx]-[Cc]ontent-[Ss]ha256: *//p' | tail -n1)
    actual=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp")
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
        err "the download did not match its checksum; nothing was installed. Try again."
        exit 1
    fi

    chmod 755 "$tmp"
    mv "$tmp" "$data/polaris.mjs"
    printf '{\n    "marker": "%s",\n    "origin": "%s",\n    "sha256": "%s",\n    "installedAt": "%s"\n}\n' \
        "$MARKER" "$POLARIS_URL" "$actual" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$data/polaris-cli.json"

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
    log "next: plr login --url $POLARIS_URL"
}

main "$@"
