#!/bin/sh
# Polaris dashboard one-command installer AND updater. Run the same line to set
# it up or to update later: it pulls the latest source, adds any new settings to
# .env automatically, rebuilds, and restarts (applying migrations). Nothing else
# to manage.
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.sh | sh
#   # sandboxed edition (no privileged host daemon; no in-band updates or local
#   # Docker host):
#   curl -fsSL .../install.sh | sh -s -- --limited
#   # also grant SSH access to a REMOTE host's Docker Engine (the local host
#   # works without this in the full edition):
#   curl -fsSL .../install.sh | sh -s -- --ssh
#
# The full edition (privileged host daemon) is the default: it unlocks in-band
# self-update and the local Docker host with no extra flags.
#
# Idempotent: re-running reconciles the stack and never overwrites an existing
# .env. Everything is wrapped in main() so a truncated download cannot execute a
# partial script.
set -eu

REPO_URL="${POLARIS_REPO_URL:-https://github.com/FJRG2007/polaris.git}"
# Fixed, $HOME-independent default so the same line resolves to the same place no
# matter who runs it (a user, or root via sudo - which changes $HOME). An already
# running deployment is found via Docker regardless of this (see main).
INSTALL_DIR="${POLARIS_INSTALL_DIR:-/opt/polaris}"

log() { printf 'polaris: %s\n' "$1"; }
err() { printf 'polaris: %s\n' "$1" >&2; }

# Durable store for generated deployment secrets. The database lives in a
# persistent Docker volume, but POLARIS_MASTER_KEY (which envelope-encrypts stored
# credentials) lived only in .env - so a deleted or regenerated .env would mint a
# NEW key and orphan every already-encrypted credential in that surviving volume.
# This store keeps those secrets outside .env so they are REUSED across installs:
# only genuinely-new secrets are generated, existing ones are never changed. A
# fixed, $HOME-independent path so sudo and non-sudo runs share one store (writes
# are best-effort; when the path is not writable the Docker-based recovery in
# durable_secret still keeps the key stable). Override with POLARIS_SECRETS_FILE.
SECRETS_STORE="${POLARIS_SECRETS_FILE:-/var/lib/polaris/secrets.env}"

# Echo a remembered secret's value for KEY (empty if the store has none).
recall_secret() {
    [ -f "$SECRETS_STORE" ] || return 0
    sed -n "s/^$1=//p" "$SECRETS_STORE" | head -n1
}

# Persist KEY=VALUE in the store (created 0600), replacing any prior line for KEY.
# Best-effort: if the store path is not writable (e.g. a fixed system path under a
# non-root run), skip silently - the Docker-based recovery still keeps keys stable.
remember_secret() {
    key="$1"
    value="$2"
    dir=$(dirname -- "$SECRETS_STORE")
    { [ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null; } || return 0
    { [ -f "$SECRETS_STORE" ] || : > "$SECRETS_STORE" 2>/dev/null; } || return 0
    chmod 600 "$SECRETS_STORE" 2>/dev/null || true
    tmp=$(mktemp 2>/dev/null) || return 0
    grep -v "^${key}=" "$SECRETS_STORE" 2>/dev/null > "$tmp" || true
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
    cat "$tmp" > "$SECRETS_STORE" 2>/dev/null || true
    rm -f "$tmp"
}

# Generate a random secret of the requested kind.
gen_secret() {
    case "$1" in
        b64_32) openssl rand -base64 32 ;;
        b64_48) openssl rand -base64 48 ;;
        hex_24) openssl rand -hex 24 ;;
    esac
}

# Recover a secret from the currently-running Polaris deployment (its web
# container's environment). Docker volumes are global to the `polaris` compose
# project, so the live master key is identical no matter which directory or user
# runs the installer - reusing it is what stops a fresh .env from orphaning the
# database's encrypted credentials. Empty if Docker is absent or nothing runs.
docker_recover_env() {
    command -v docker >/dev/null 2>&1 || return 0
    cid=$(docker ps -q \
        --filter "label=com.docker.compose.project=polaris" \
        --filter "label=com.docker.compose.service=web" 2>/dev/null | head -n1)
    [ -n "$cid" ] || return 0
    docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
        | sed -n "s/^$1=//p" | head -n1
}

# Return a durable secret for KEY: reuse the remembered value, else adopt the
# value from a Polaris deployment already running on this host, else generate one
# of KIND. Each source is remembered. This is what makes a regenerated .env - or a
# fresh checkout in another directory - recover the SAME master key.
durable_secret() {
    key="$1"
    existing=$(recall_secret "$key")
    if [ -n "$existing" ]; then
        printf '%s' "$existing"
        return 0
    fi
    recovered=$(docker_recover_env "$key")
    if [ -n "$recovered" ]; then
        remember_secret "$key" "$recovered"
        printf '%s' "$recovered"
        return 0
    fi
    value=$(gen_secret "$2")
    remember_secret "$key" "$value"
    printf '%s' "$value"
}

# Seed the durable store from an existing .env: the first run of this hardened
# installer captures the CURRENT master key (and other durable secrets) so a
# later .env loss recovers them instead of minting new ones. Never overwrites a
# value already in the store.
seed_store_from_env() {
    target="$1"
    for key in POLARIS_MASTER_KEY POLARIS_AUTH_SECRET POSTGRES_PASSWORD; do
        [ -n "$(recall_secret "$key")" ] && continue
        cur=$(sed -n "s/^${key}=//p" "$target" | head -n1)
        case "$cur" in "" | REPLACE_ME_*) continue ;; esac
        remember_secret "$key" "$cur"
    done
}

# The host directory of a Polaris deployment already running here (its compose
# working dir, i.e. the `docker/` folder). Used so a bare `curl | sh` updates that
# deployment in place instead of cloning a divergent checkout into $HOME/polaris -
# which, sharing the global Docker volumes, would run a fresh master key against
# the existing database and orphan its encrypted credentials. Empty if none runs.
existing_deployment_dir() {
    command -v docker >/dev/null 2>&1 || return 0
    cid=$(docker ps -q \
        --filter "label=com.docker.compose.project=polaris" \
        --filter "label=com.docker.compose.service=web" 2>/dev/null | head -n1)
    [ -n "$cid" ] || return 0
    docker inspect "$cid" \
        --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null
}

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
    # Durable across installs, so a regenerated .env keeps decrypting existing
    # data and keeps the DB password stable. The setup token is intentionally
    # ephemeral (it is inert once an administrator exists).
    master_key=$(durable_secret POLARIS_MASTER_KEY b64_32)
    auth_secret=$(durable_secret POLARIS_AUTH_SECRET b64_48)
    pg_password=$(durable_secret POSTGRES_PASSWORD hex_24)
    setup_token=$(openssl rand -hex 24)

    sed \
        -e "s#REPLACE_ME_openssl_rand_base64_32#${master_key}#" \
        -e "s#REPLACE_ME_long_random_string#${auth_secret}#" \
        -e "s#REPLACE_ME_setup_token#${setup_token}#" \
        -e "s#REPLACE_ME_strong_password#${pg_password}#g" \
        "$example" > "$target"

    chmod 600 "$target"
}

# Substitute a known secret placeholder with a value, or echo it unchanged. Keeps
# updates hands-off: new secrets appear automatically. Durable secrets (master
# key, auth secret, DB password) are reused from the store if known, so a key
# that was dropped from .env is restored rather than regenerated. KEY is the .env
# key being filled; PLACEHOLDER is its example value.
materialize() {
    key="$1"
    case "$2" in
        REPLACE_ME_openssl_rand_base64_32) durable_secret "$key" b64_32 ;;
        REPLACE_ME_long_random_string) durable_secret "$key" b64_48 ;;
        REPLACE_ME_strong_password) durable_secret "$key" hex_24 ;;
        REPLACE_ME_setup_token) openssl rand -hex 24 ;;
        *) printf '%s' "$2" ;;
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
            value=$(materialize "$key" "${line#*=}")
            printf '%s=%s\n' "$key" "$value" >> "$target"
            added="$added $key"
        fi
    done < "$example"
    chmod 600 "$target"
    if [ -n "$added" ]; then
        log "added new settings to .env (auto-generated):$added"
    fi
}

# Upsert KEY=VALUE in the env file, replacing any existing line for KEY. The
# value is written verbatim (never through sed), so it may safely contain spaces
# and shell metacharacters - as the generated update command does.
set_env_var() {
    file="$1"
    key="$2"
    value="$3"
    tmp=$(mktemp)
    grep -v "^${key}=" "$file" 2>/dev/null > "$tmp" || true
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
    cat "$tmp" > "$file"
    rm -f "$tmp"
    chmod 600 "$file"
}

# Select the edition by writing the compose profile into .env, so every
# `docker compose` - installer and CLI alike - picks it up. In the full edition
# also write the in-band update command with this host's repo path baked in:
# hostd (in its container) launches a throwaway updater container that
# bind-mounts this repo and the docker socket and re-runs the updater script
# (git pull -> reconcile .env -> pull images -> migrate -> redeploy -> verify).
# Limited clears both so a bare `docker compose up` stays sandboxed.
configure_edition() {
    mode="$1"
    env_file="$2"
    if [ "$mode" = "yes" ]; then
        # The updater's bind-mount source must be the HOST repo path even when
        # this installer runs INSIDE the updater container (where the repo is
        # mounted at /polaris, so `cd ../..` would resolve to the wrong path and
        # corrupt the command on the next self-update). hostd passes the real
        # host path back in as POLARIS_HOST_REPO; on a normal host install it is
        # unset and the working tree is correct.
        host_repo="${POLARIS_HOST_REPO:-$(cd ../.. && pwd)}"
        set_env_var "$env_file" "COMPOSE_PROFILES" "full"
        # The updater runs in the foreground, so redirecting the `docker run` output
        # to the shared polaris-run volume (mounted in both hostd and web at
        # /run/polaris) streams the whole update - git pull, image pull, migrations,
        # redeploy, verify - to a file the dashboard tails live, and survives the web
        # container being recreated mid-update. `>` truncates it, so each run starts
        # clean; update.sh appends a POLARIS_UPDATE_EXIT=<code> marker on exit. No `$`
        # in this value, so Compose never tries to interpolate it.
        update_cmd="docker rm -f polaris-updater >/dev/null 2>&1; docker run --name polaris-updater --rm -e POLARIS_HOST_REPO=${host_repo} -v /var/run/docker.sock:/var/run/docker.sock -v ${host_repo}:/polaris -w /polaris/dashboard ghcr.io/fjrg2007/polaris-updater:latest sh scripts/update.sh > /run/polaris/update.log 2>&1"
        set_env_var "$env_file" "POLARIS_HOSTD_UPDATE_CMD" "$update_cmd"
        log "full edition (privileged host daemon, in-band updates, local Docker host)"
    else
        set_env_var "$env_file" "COMPOSE_PROFILES" ""
        set_env_var "$env_file" "POLARIS_HOSTD_UPDATE_CMD" ""
        log "limited edition (no privileged host daemon)"
    fi
}

# Keep POLARIS_DATABASE_URL's password in lockstep with POSTGRES_PASSWORD so the
# two can never drift apart (the classic P1000 auth failure). Only rewrites a URL
# that targets the bundled `postgres` service; an external database URL is left
# untouched.
sync_database_url() {
    target="$1"
    pg_user=$(sed -n 's/^POSTGRES_USER=//p' "$target" | head -n1)
    pg_pw=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$target" | head -n1)
    pg_db=$(sed -n 's/^POSTGRES_DB=//p' "$target" | head -n1)
    [ -n "$pg_pw" ] || return 0
    current=$(sed -n 's/^POLARIS_DATABASE_URL=//p' "$target" | head -n1)
    case "$current" in *@postgres:5432/*) ;; *) return 0 ;; esac
    desired="postgresql://${pg_user:-polaris}:${pg_pw}@postgres:5432/${pg_db:-polaris}"
    if [ "$current" != "$desired" ]; then
        sed -i "s#^POLARIS_DATABASE_URL=.*#POLARIS_DATABASE_URL=${desired}#" "$target"
        log "kept POLARIS_DATABASE_URL consistent with POSTGRES_PASSWORD"
    fi
}

# Whether the web container is serving. Prefers the container healthcheck; on an
# older image that has none, settles for "running and not restarting".
web_ready() {
    id=$(docker compose ps -q web 2>/dev/null)
    [ -n "$id" ] || return 1
    state=$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null || echo "")
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || echo "")
    if [ -n "$health" ]; then
        [ "$health" = "healthy" ]
    else
        [ "$state" = "running" ]
    fi
}

# Wait up to ~90s for the web service to come up, so a broken deploy fails loudly
# here instead of silently as a 502. Returns 1 if it never becomes ready.
verify_deploy() {
    i=1
    while [ "$i" -le 45 ]; do
        if web_ready; then
            return 0
        fi
        id=$(docker compose ps -q web 2>/dev/null)
        if [ -n "$id" ] && [ "$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null)" = "exited" ]; then
            return 1
        fi
        sleep 2
        i=$((i + 1))
    done
    return 1
}

# True once at least one account exists, so the installer can stop advertising the
# first-run setup token after setup is complete. Unknown (DB not reachable / table
# not yet created on a fresh install) counts as "not done" so a genuine first run
# still shows the link.
setup_done() {
    count=$(docker compose exec -T postgres \
        psql -U "${POSTGRES_USER:-polaris}" -d "${POSTGRES_DB:-polaris}" -tAc 'SELECT count(*) FROM "User";' \
        2>/dev/null | tr -d '[:space:]')
    case "$count" in "" | *[!0-9]*) return 1 ;; esac
    [ "$count" -gt 0 ]
}

# Make POSTGRES_PASSWORD the single source of truth. Postgres only reads
# POSTGRES_PASSWORD when it first initializes its data volume and ignores it ever
# after, so a regenerated .env - or a database role left at some earlier password -
# drifts from what the web presents and authentication fails (P1000). After the
# stack is up, set the bundled role's password to match .env. The local socket
# uses trust auth, so this needs no old password and loses no data. An external
# database (a URL not pointing at the bundled `postgres`) is left untouched.
align_db_password() {
    pw=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | head -n1)
    [ -n "$pw" ] || return 0
    case "$(sed -n 's/^POLARIS_DATABASE_URL=//p' .env | head -n1)" in
        *@postgres:5432/*) ;;
        *) return 0 ;;
    esac
    user=$(sed -n 's/^POSTGRES_USER=//p' .env | head -n1)
    user=${user:-polaris}
    db=$(sed -n 's/^POSTGRES_DB=//p' .env | head -n1)
    db=${db:-polaris}
    esc=$(printf '%s' "$pw" | sed "s/'/''/g")
    i=1
    while [ "$i" -le 15 ]; do
        if docker compose exec -T postgres pg_isready -U "$user" -d "$db" >/dev/null 2>&1; then
            if docker compose exec -T postgres psql -U "$user" -d "$db" \
                -c "ALTER USER \"$user\" WITH PASSWORD '$esc';" >/dev/null 2>&1; then
                log "aligned the database password with .env"
                return 0
            fi
        fi
        sleep 2
        i=$((i + 1))
    done
    err "could not align the database password automatically; run 'polaris doctor' if the web fails"
}

# The published web image lags the source it was built from: CI takes a few
# minutes to build and push :latest after a commit lands on main. An update pulls
# the freshly advanced checkout instantly but then pulls whatever :latest points
# to RIGHT NOW - which, during that window, is still the PREVIOUS commit's image.
# The deploy then reports success while the running build sits one commit behind
# HEAD, so the dashboard shows "update available" until some later update happens
# to run after CI caught up. That race is why an update "breaks" on every change
# that touches the web image. The paths below mirror the web-image path filter in
# .github/workflows/dashboard-publish.yml (and update-service.ts) exactly, so this
# agrees with what actually rebuilds the image.
WEB_IMAGE="ghcr.io/fjrg2007/polaris-dashboard:latest"
WEB_IMAGE_PATHS='^dashboard/(apps|packages|cli)/|^dashboard/docker/(Dockerfile|entrypoint\.sh)|^dashboard/package(-lock)?\.json$|^\.github/workflows/dashboard-publish\.yml$'

# The commit the locally-present web image was built from (baked in as
# POLARIS_BUILD_SHA), or empty if the image or label is absent.
web_image_sha() {
    docker image inspect "$WEB_IMAGE" \
        --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
        | sed -n 's/^POLARIS_BUILD_SHA=//p' | head -n1
}

# True (0) when the local web image is STALE for the target commit: a web-image
# path changed between the image's commit and target, so CI has not yet published
# target's image. False (1) when it is current, or when we cannot tell (unknown
# commit, or a shallow history that does not contain the image's commit) - never
# block on uncertainty.
web_image_stale() {
    target="$1"
    sha=$(web_image_sha)
    [ -n "$sha" ] || return 1
    [ "$sha" = "$target" ] && return 1
    git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null 2>&1 || return 1
    git diff --name-only "$sha" "$target" 2>/dev/null | grep -qE "$WEB_IMAGE_PATHS"
}

# Hold an UPDATE until the registry's web image is built from HEAD (or HEAD made no
# web change at all), so the deploy lands the commit that was just pulled instead of
# the previous one. Bounded at ~20 minutes: past the cap - a failed or absent CI run
# - it deploys whatever is current and lets a later check pick up the newer build,
# so a stuck CI can never wedge the update. A first install (no web container yet)
# and a shallow clone with no local history both fall through immediately.
wait_for_web_image() {
    command -v git >/dev/null 2>&1 || return 0
    target=$(git rev-parse HEAD 2>/dev/null) || return 0
    [ -n "$target" ] || return 0
    # Only meaningful when a deployment is already running (i.e. this is an update);
    # a first install has no prior image that could be "behind".
    docker ps -q \
        --filter "label=com.docker.compose.project=polaris" \
        --filter "label=com.docker.compose.service=web" 2>/dev/null | grep -q . || return 0

    i=0
    while [ "$i" -lt 40 ]; do
        docker pull "$WEB_IMAGE" >/dev/null 2>&1 || true
        web_image_stale "$target" || return 0
        [ "$i" -eq 0 ] && log "web image for $(printf '%s' "$target" | cut -c1-7) is still building on CI; waiting before deploying..."
        sleep 30
        i=$((i + 1))
    done
    err "the published web image did not catch up to $(printf '%s' "$target" | cut -c1-7) within ~20 min; deploying the current image (a later update will pick up the newer build)"
    return 0
}

main() {
    # Full edition (privileged host daemon) is the default: it is what unlocks
    # in-band updates and the local Docker host with no extra flags. `--limited`
    # opts out to the sandboxed edition; `--full` is accepted for compatibility.
    full="yes"
    ssh="no"
    for arg in "$@"; do
        case "$arg" in
            --full) full="yes" ;;
            --limited) full="no" ;;
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
        # Prefer a deployment already running on this host: update IT in place so a
        # bare `curl | sh` (run from any directory or user) never spins up a second,
        # divergent checkout with a fresh master key against the shared volumes.
        running_dir=$(existing_deployment_dir)
        if [ -n "$running_dir" ] && [ -f "$running_dir/docker-compose.yml" ]; then
            INSTALL_DIR=$(cd "$running_dir/../.." && pwd)
            log "found the running Polaris deployment at $INSTALL_DIR; updating it in place"
        fi
        need git "install git so the installer can fetch the Polaris repository"
        if [ -d "$INSTALL_DIR/.git" ]; then
            log "updating existing checkout in $INSTALL_DIR"
            git -C "$INSTALL_DIR" pull --ff-only
            # The pull may have updated THIS script. A shell keeps executing the
            # version it already parsed, so any fix in the new installer would only
            # take effect one run later. Re-exec the freshly pulled copy once (a
            # guard env var prevents a loop) so the newest logic always runs now.
            if [ -z "${POLARIS_INSTALL_REEXEC:-}" ] && [ -f "$INSTALL_DIR/dashboard/scripts/install.sh" ]; then
                POLARIS_INSTALL_REEXEC=1
                export POLARIS_INSTALL_REEXEC
                exec sh "$INSTALL_DIR/dashboard/scripts/install.sh" "$@"
            fi
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
        # Capture the current durable secrets before touching anything, so this
        # host's existing master key survives a future .env loss.
        seed_store_from_env ".env"
        reconcile_env ".env.example" ".env"
    fi

    # Guarantee the app's database URL and the Postgres password always agree.
    sync_database_url ".env"

    # The placeholder example.com domain can never get a certificate (RFC 2606
    # reserves it), so leaving it makes Caddy loop on ACME forever while the site
    # is unreachable - every time. Rewrite it to a working LAN default; a real
    # domain a user actually configured is never example.com, so this is safe.
    if grep -qE '^POLARIS_SITE_ADDRESS=.*example\.com' .env || grep -qE '^POLARIS_APP_URL=.*example\.com' .env; then
        sed -i 's#^POLARIS_SITE_ADDRESS=.*#POLARIS_SITE_ADDRESS=:80#' .env
        sed -i 's#^POLARIS_APP_URL=.*#POLARIS_APP_URL=http://polaris.local#' .env
        log "replaced the placeholder example.com address with the LAN default (:80, http://polaris.local)"
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

    # Select the edition (full by default) and, for full, provision the in-band
    # update command. Writes COMPOSE_PROFILES into .env.
    configure_edition "$full" ".env"

    # Honour the profile deterministically: export it for every compose call below.
    # Relying on COMPOSE_PROFILES from .env alone is not reliable across Docker
    # Compose versions - when it is ignored, the full edition's privileged daemon
    # (hostd, in the `full` profile) never starts and the dashboard is stuck on the
    # limited edition, so the local Docker host never appears.
    COMPOSE_PROFILES=$(sed -n 's/^COMPOSE_PROFILES=//p' .env | head -n1)
    export COMPOSE_PROFILES

    # On an update, do not deploy until the published web image matches the source
    # just pulled - otherwise the running build sits a commit behind HEAD and the
    # dashboard nags "update available" until a later run. No-op on a first install.
    wait_for_web_image

    # Install and update are the same command: prefer the published `latest` image
    # (fast), falling back to building from source if the registry is unavailable.
    build_flag=""
    if $compose pull 2>/dev/null; then
        log "starting from the published image (also applies database migrations)"
    else
        log "registry unavailable; building from source (also applies migrations)"
        build_flag="--build"
    fi

    # Bring up the database first and align its password with .env BEFORE anything
    # connects. Postgres only reads POSTGRES_PASSWORD at first init, so a drifted
    # volume password would otherwise make the web fail auth on startup (P1000) and
    # restart in a loop; aligning first means the web connects cleanly the first
    # time - no race, no restart churn.
    $compose up -d $build_flag postgres
    align_db_password

    # Now bring up the rest against the already-aligned database.
    $compose up -d $build_flag --remove-orphans

    # In the full edition, confirm the privileged daemon actually started - a
    # silently-missing hostd is exactly what leaves the dashboard on "limited" and
    # hides the local Docker host. Warn loudly (do not fail the whole deploy).
    if [ "$full" = "yes" ] && [ -z "$($compose ps -q hostd 2>/dev/null)" ]; then
        err "full edition selected but the polaris-hostd service is not running."
        err "recent hostd logs:"
        $compose logs --tail 20 hostd >&2 2>/dev/null || true
        err "the local Docker host needs hostd; inspect with 'polaris status' / 'docker compose ps'."
    fi

    # The Caddyfile is bind-mounted, so `up -d` does NOT restart Caddy when it
    # changes - which is why a proxy/TLS change from an update would silently not
    # take effect. Reload its config live (fast, no downtime); if that is not
    # possible, recreate the container so the new Caddyfile is always applied.
    $compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
        || $compose up -d --force-recreate caddy >/dev/null 2>&1 || true

    # Reclaim what this update superseded, automatically, so the disk cannot creep
    # to full over many updates (a full disk is exactly what took the dashboard
    # down). Everything here is conservative and best-effort - cleanup must never
    # fail an otherwise-successful update, and must never touch data:
    #   - dangling images: the previous `:latest` each pull leaves untagged
    #   - build cache: stale layers from source builds
    #   - unused networks: prune keeps any network that still has a container
    # Tagged images (including deployed apps') are all kept.
    docker image prune -f >/dev/null 2>&1 || true
    docker builder prune -f >/dev/null 2>&1 || true
    docker network prune -f >/dev/null 2>&1 || true
    # Orphan (anonymous) volumes only, and only on Docker >= 23 where `volume prune`
    # defaults to anonymous-only - named volumes (how Polaris names every app/data
    # volume) are NOT removed. On older Docker `volume prune` would also take named
    # volumes, so skip it there rather than risk deleting an app's data.
    dver="$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1)"
    case "$dver" in
        ''|*[!0-9]*) : ;;
        *) [ "$dver" -ge 23 ] && docker volume prune -f >/dev/null 2>&1 || true ;;
    esac

    url=$(sed -n 's#^POLARIS_APP_URL=##p' .env | head -n1)

    # Verify the deploy actually came up rather than reporting success blindly.
    if ! verify_deploy; then
        err "the web service did not become healthy. Recent logs:"
        $compose logs --tail 30 web >&2 || true
        err "diagnose with 'polaris doctor' (or 'polaris logs web'); the stack is left running so you can inspect it"
        exit 1
    fi

    log "done. Polaris is running at: ${url:-your configured POLARIS_APP_URL}"
    # Only advertise the first-run setup link while setup is still pending; once an
    # administrator exists, registration is invite-only and the token is inert.
    if ! setup_done; then
        setup_token=$(sed -n 's#^POLARIS_SETUP_TOKEN=##p' .env | head -n1)
        printf '\npolaris: ----------------------------------------------------------\n' >&2
        printf 'polaris: First run - open this link to create the administrator:\n' >&2
        printf 'polaris:   http://polaris.local/oauth/setup?token=%s\n' "$setup_token" >&2
        printf 'polaris: (registration is otherwise invite-only)\n' >&2
        printf 'polaris: ----------------------------------------------------------\n\n' >&2
    fi
    log "check status with: polaris status"
}

main "$@"
