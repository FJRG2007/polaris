#!/bin/sh
# Polaris dashboard one-command installer AND updater. Run the same line to set
# it up or to update later: it pulls the latest source, adds any new settings to
# .env automatically, rebuilds, and restarts (applying migrations). Nothing else
# to manage.
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.sh | sh
#   # full edition (starts the privileged host daemon):
#   curl -fsSL .../install.sh | sh -s -- --full
#   # grant the container secure SSH access to the host Docker Engine:
#   curl -fsSL .../install.sh | sh -s -- --ssh
#
# Idempotent: re-running reconciles the stack and never overwrites an existing
# .env. Everything is wrapped in main() so a truncated download cannot execute a
# partial script.
set -eu

REPO_URL="${POLARIS_REPO_URL:-https://github.com/FJRG2007/polaris.git}"
INSTALL_DIR="${POLARIS_INSTALL_DIR:-$HOME/polaris}"

log() { printf 'polaris: %s\n' "$1"; }
err() { printf 'polaris: %s\n' "$1" >&2; }

need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "required command not found: $1"
        err "$2"
        exit 1
    fi
}

# Resolve the docker compose invocation (v2 plugin only; the legacy v1 binary
# is unsupported). Echoes the base command for the caller to extend.
compose_cmd() {
    if docker compose version >/dev/null 2>&1; then
        echo "docker compose"
    else
        err "'docker compose' (v2) is required but not available"
        err "install Docker Engine with the Compose plugin: https://docs.docker.com/engine/install/"
        exit 1
    fi
}

# Map polaris / polaris.local to loopback on this machine so it resolves even
# without mDNS (the compose `mdns` service advertises polaris.local LAN-wide).
# Best effort and idempotent: needs root, so it warns rather than fails.
setup_hostnames() {
    hosts_file="/etc/hosts"
    marker="# polaris-dashboard"
    entry="127.0.0.1 polaris polaris.local ${marker}"
    if grep -q "$marker" "$hosts_file" 2>/dev/null; then
        return 0
    fi
    if [ -w "$hosts_file" ]; then
        printf '%s\n' "$entry" >> "$hosts_file"
    elif command -v sudo >/dev/null 2>&1; then
        printf '%s\n' "$entry" | sudo tee -a "$hosts_file" >/dev/null 2>&1 || {
            err "could not edit $hosts_file; add manually: $entry"
            return 0
        }
    else
        err "could not add polaris/polaris.local to $hosts_file (need root); add manually:"
        err "  $entry"
        return 0
    fi
    log "mapped polaris and polaris.local to 127.0.0.1 in $hosts_file"
}

# Install the `polaris` (and `plr`) management CLI on the host, baking in this
# deployment's path so `polaris setup`, `polaris logs`, etc. just work. Must run
# from the docker workdir so ../cli resolves; best effort (needs root).
install_cli() {
    src="../cli/polaris"
    [ -f "$src" ] || return 0
    root=$(cd ../.. && pwd)
    tmp=$(mktemp)
    sed "s|__POLARIS_INSTALL_DIR__|${root}|" "$src" > "$tmp"
    dest="/usr/local/bin"
    if [ -w "$dest" ]; then
        cp "$tmp" "$dest/polaris" && chmod +x "$dest/polaris" && ln -sf "$dest/polaris" "$dest/plr" \
            && log "installed the 'polaris' (and 'plr') command"
    elif command -v sudo >/dev/null 2>&1; then
        sudo cp "$tmp" "$dest/polaris" && sudo chmod +x "$dest/polaris" && sudo ln -sf "$dest/polaris" "$dest/plr" \
            && log "installed the 'polaris' (and 'plr') command"
    else
        err "could not install the polaris CLI to $dest (need root); copy $src there by hand"
    fi
    rm -f "$tmp"
}

# Fill the three secrets in a freshly copied .env, in place, using # as the sed
# delimiter so base64 '/' characters pass through untouched.
generate_env() {
    example="$1"
    target="$2"
    master_key=$(openssl rand -base64 32)
    auth_secret=$(openssl rand -base64 48)
    pg_password=$(openssl rand -hex 24)
    setup_token=$(openssl rand -hex 24)

    sed \
        -e "s#REPLACE_ME_openssl_rand_base64_32#${master_key}#" \
        -e "s#REPLACE_ME_long_random_string#${auth_secret}#" \
        -e "s#REPLACE_ME_setup_token#${setup_token}#" \
        -e "s#REPLACE_ME_strong_password#${pg_password}#g" \
        "$example" > "$target"

    chmod 600 "$target"
}

# Substitute a known secret placeholder with a freshly generated value, or echo
# the value unchanged. Keeps updates hands-off: new secrets appear automatically.
materialize() {
    case "$1" in
        REPLACE_ME_openssl_rand_base64_32) openssl rand -base64 32 ;;
        REPLACE_ME_long_random_string) openssl rand -base64 48 ;;
        REPLACE_ME_setup_token) openssl rand -hex 24 ;;
        REPLACE_ME_strong_password) openssl rand -hex 24 ;;
        *) printf '%s' "$1" ;;
    esac
}

# Reconcile an existing .env against the example: append any keys that were added
# in a newer version (generating their secrets), so re-running the installer to
# update never requires the user to touch .env by hand. Existing values are kept.
reconcile_env() {
    example="$1"
    target="$2"
    added=""
    while IFS= read -r line; do
        case "$line" in ""|\#*) continue ;; esac
        case "$line" in *=*) ;; *) continue ;; esac
        key=${line%%=*}
        if ! grep -q "^${key}=" "$target" 2>/dev/null; then
            value=$(materialize "${line#*=}")
            printf '%s=%s\n' "$key" "$value" >> "$target"
            added="$added $key"
        fi
    done < "$example"
    chmod 600 "$target"
    if [ -n "$added" ]; then
        log "added new settings to .env (auto-generated):$added"
    fi
}

main() {
    full="no"
    ssh="no"
    for arg in "$@"; do
        case "$arg" in
            --full) full="yes" ;;
            --ssh) ssh="yes" ;;
            *) err "unknown argument: $arg"; exit 1 ;;
        esac
    done

    need docker "install Docker Engine: https://docs.docker.com/engine/install/"
    need openssl "install openssl (used to generate deployment secrets)"
    compose="$(compose_cmd)"

    # Locate the compose directory: run in place if we are already inside a
    # checkout, otherwise clone (or update) one into the install dir.
    if [ -f "docker/docker-compose.yml" ] && [ -f "docker/.env.example" ]; then
        workdir="docker"
    elif [ -f "docker-compose.yml" ] && [ -f ".env.example" ]; then
        workdir="."
    else
        need git "install git so the installer can fetch the Polaris repository"
        if [ -d "$INSTALL_DIR/.git" ]; then
            log "updating existing checkout in $INSTALL_DIR"
            git -C "$INSTALL_DIR" pull --ff-only
        else
            log "cloning $REPO_URL into $INSTALL_DIR"
            git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
        fi
        workdir="$INSTALL_DIR/dashboard/docker"
    fi

    cd "$workdir"

    if [ ! -f ".env" ]; then
        log "generating .env with fresh secrets"
        generate_env ".env.example" ".env"
        err "review .env and set POLARIS_SITE_ADDRESS / POLARIS_APP_URL to your domain"
    else
        log ".env present; reconciling any new settings"
        reconcile_env ".env.example" ".env"
    fi

    setup_hostnames
    install_cli

    # The web container always bind-mounts this directory read-only; keep it
    # present (empty is fine) so `up` never fails when SSH access is not set up.
    mkdir -p secrets/ssh

    if [ "$ssh" = "yes" ]; then
        log "provisioning secure SSH access to the host Docker Engine"
        need ssh-keygen "install openssh-client so the installer can generate the access key"
        POLARIS_ENV_FILE="$(pwd)/.env" sh ../scripts/setup-ssh-access.sh
    fi

    set -- up -d --build --remove-orphans
    if [ "$full" = "yes" ]; then
        log "enabling the full edition (privileged host daemon)"
        export COMPOSE_PROFILES="full"
    fi

    # One step for both install and update: rebuild the image from the freshly
    # pulled source and (re)start. The web entrypoint applies pending migrations,
    # so an update needs nothing else from the user.
    log "building and starting the stack (also applies database migrations)"
    $compose "$@"

    url=$(sed -n 's#^POLARIS_APP_URL=##p' .env | head -n1)
    setup_token=$(sed -n 's#^POLARIS_SETUP_TOKEN=##p' .env | head -n1)
    log "done. Polaris should be reachable at: ${url:-your configured POLARIS_APP_URL}"
    printf '\npolaris: ----------------------------------------------------------\n' >&2
    printf 'polaris: First run - open this link to create the administrator:\n' >&2
    printf 'polaris:   http://polaris.local/oauth/setup?token=%s\n' "$setup_token" >&2
    printf 'polaris: (registration is otherwise invite-only)\n' >&2
    printf 'polaris: ----------------------------------------------------------\n\n' >&2
    log "check status with: (cd $(pwd) && $compose ps)"
}

main "$@"
