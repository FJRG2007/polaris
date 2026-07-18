#!/bin/sh
# Polaris dashboard one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.sh | sh
#   # full edition (starts the privileged host daemon):
#   curl -fsSL .../install.sh | sh -s -- --full
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

# Fill the three secrets in a freshly copied .env, in place, using # as the sed
# delimiter so base64 '/' characters pass through untouched.
generate_env() {
    example="$1"
    target="$2"
    master_key=$(openssl rand -base64 32)
    auth_secret=$(openssl rand -base64 48)
    pg_password=$(openssl rand -hex 24)

    sed \
        -e "s#REPLACE_ME_openssl_rand_base64_32#${master_key}#" \
        -e "s#REPLACE_ME_long_random_string#${auth_secret}#" \
        -e "s#REPLACE_ME_strong_password#${pg_password}#g" \
        "$example" > "$target"

    chmod 600 "$target"
}

main() {
    full="no"
    for arg in "$@"; do
        case "$arg" in
            --full) full="yes" ;;
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
        log ".env already present, keeping it"
    fi

    set -- up -d
    if [ "$full" = "yes" ]; then
        log "enabling the full edition (privileged host daemon)"
        export COMPOSE_PROFILES="full"
    fi

    log "pulling images (falling back to a local build)"
    $compose pull || $compose build

    log "starting the stack"
    $compose "$@"

    url=$(sed -n 's#^POLARIS_APP_URL=##p' .env | head -n1)
    log "done. Polaris should be reachable at: ${url:-your configured POLARIS_APP_URL}"
    log "check status with: (cd $(pwd) && $compose ps)"
}

main "$@"
