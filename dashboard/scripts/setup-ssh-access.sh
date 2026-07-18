#!/bin/sh
# Provision a secure, unique SSH access for the dockerized Polaris dashboard so
# the web container can reach the host's Docker Engine over SSH (to view and
# manage containers) without mounting the docker socket into the container.
#
# Security model (least privilege):
#   - A dedicated ed25519 keypair, generated fresh per install (never reused,
#     never committed), stored 0600 in the compose directory's secrets/ssh dir.
#   - The public key is authorized with a FORCED COMMAND: it can only run
#     `docker system dial-stdio` - the exact bridge the Docker CLI/dockerode use
#     to reach the Engine API. The key cannot open a shell, forward ports, or run
#     anything else (`restrict` disables pty/agent/X11/port forwarding).
#   - `from="..."` limits which source addresses may use the key (Docker bridge
#     subnets + loopback by default).
#   - The host's SSH host key is pinned into a known_hosts file, so the container
#     verifies the host instead of trusting it blindly on first connect.
#
# Note: authorizing this key grants Docker access, which is root-equivalent on
# the host. Point POLARIS_SSH_USER at a dedicated, least-privilege account that
# is only a member of the `docker` group.
set -eu

SSH_DIR="${POLARIS_SSH_DIR:-$(pwd)/secrets/ssh}"
SSH_USER="${POLARIS_SSH_USER:-$(id -un)}"
CONTAINER_HOST="${POLARIS_SSH_HOST:-host.docker.internal}"
SCAN_HOST="${POLARIS_SSH_SCAN_HOST:-127.0.0.1}"
SSH_PORT="${POLARIS_SSH_PORT:-22}"
FROM_CIDRS="${POLARIS_SSH_FROM:-172.16.0.0/12,192.168.0.0/16,10.0.0.0/8,127.0.0.1}"
ENV_FILE="${POLARIS_ENV_FILE:-$(pwd)/.env}"
FORCED_COMMAND="docker system dial-stdio"
KEY_COMMENT="polaris-dashboard"
KEY="$SSH_DIR/id_ed25519"

log() { printf 'polaris-ssh: %s\n' "$1"; }
err() { printf 'polaris-ssh: %s\n' "$1" >&2; }

need() {
    command -v "$1" >/dev/null 2>&1 || { err "required command not found: $1"; exit 1; }
}

# Insert or replace KEY=value in the env file so re-runs stay idempotent.
upsert_env() {
    key="$1"
    value="$2"
    touch "$ENV_FILE"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        tmp="${ENV_FILE}.tmp"
        grep -v "^${key}=" "$ENV_FILE" > "$tmp"
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
        mv "$tmp" "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
}

need ssh-keygen
need ssh-keyscan

# 1. Unique keypair (generated once; pass --rotate to force a new one).
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
if [ "${1:-}" = "--rotate" ] && [ -f "$KEY" ]; then
    log "rotating existing key"
    rm -f "$KEY" "$KEY.pub"
fi
if [ ! -f "$KEY" ]; then
    log "generating a dedicated ed25519 key for the dashboard"
    ssh-keygen -t ed25519 -N "" -q -f "$KEY" -C "$KEY_COMMENT"
fi
chmod 600 "$KEY"
chmod 644 "$KEY.pub"
pubkey=$(cat "$KEY.pub")
keymaterial=$(awk '{print $2}' "$KEY.pub")

# 2. Authorize the key on the host user with a forced command + restrictions.
user_home=$(eval echo "~$SSH_USER")
auth_dir="$user_home/.ssh"
auth_file="$auth_dir/authorized_keys"
mkdir -p "$auth_dir"
chmod 700 "$auth_dir"
touch "$auth_file"
chmod 600 "$auth_file"

options="command=\"${FORCED_COMMAND}\",restrict,from=\"${FROM_CIDRS}\""
line="${options} ${pubkey}"

# Drop any prior Polaris entry (matched by the key material) before re-adding, so
# option changes take effect and the file never accumulates duplicates.
if grep -q "$keymaterial" "$auth_file" 2>/dev/null; then
    tmp="${auth_file}.tmp"
    grep -v "$keymaterial" "$auth_file" > "$tmp" || true
    mv "$tmp" "$auth_file"
    chmod 600 "$auth_file"
fi
printf '%s\n' "$line" >> "$auth_file"
log "authorized the key for user '$SSH_USER' (forced command: ${FORCED_COMMAND})"

# 3. Pin the host key so the container verifies the host (no blind TOFU). Rewrite
#    the scanned loopback hostname to the alias the container connects to.
if [ "$SSH_PORT" = "22" ]; then
    host_alias="$CONTAINER_HOST"
else
    host_alias="[$CONTAINER_HOST]:$SSH_PORT"
fi
scanned=$(ssh-keyscan -T 5 -p "$SSH_PORT" "$SCAN_HOST" 2>/dev/null || true)
if [ -z "$scanned" ]; then
    err "could not scan the host key at $SCAN_HOST:$SSH_PORT"
    err "is the host running sshd and reachable? known_hosts was not written"
else
    printf '%s\n' "$scanned" | sed "s#^[^ ]*#${host_alias}#" > "$SSH_DIR/known_hosts"
    chmod 644 "$SSH_DIR/known_hosts"
    log "pinned the host key for '$host_alias'"
fi

# 4. Publish the connection details to the env the compose stack reads. The paths
#    are where compose mounts the secrets read-only inside the container.
upsert_env POLARIS_SSH_ENABLED "true"
upsert_env POLARIS_SSH_HOST "$CONTAINER_HOST"
upsert_env POLARIS_SSH_USER "$SSH_USER"
upsert_env POLARIS_SSH_PORT "$SSH_PORT"
upsert_env POLARIS_SSH_KEY "/run/polaris-ssh/id_ed25519"
upsert_env POLARIS_SSH_KNOWN_HOSTS "/run/polaris-ssh/known_hosts"

log "SSH docker access ready. Fingerprint:"
ssh-keygen -lf "$KEY.pub" | sed 's/^/polaris-ssh:   /'
# The key is locked to `docker system dial-stdio`, so a normal `ssh ... <cmd>` is
# ignored. Verify end to end by piping a Docker API request through the bridge;
# a healthy Engine answers "HTTP/1.0 200 OK ... OK".
log "verify from this host with:"
log "  printf 'GET /_ping HTTP/1.0\\r\\n\\r\\n' | ssh -i $KEY -o UserKnownHostsFile=$SSH_DIR/known_hosts $SSH_USER@$SCAN_HOST"
