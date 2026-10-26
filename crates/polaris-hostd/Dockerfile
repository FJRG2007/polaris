# polaris-hostd container image. Builds the static host daemon and ships it on a
# minimal Alpine runtime carrying only the Docker CLI, which POST /v1/update uses
# to launch the one-shot updater container. No compose plugin is needed here: the
# compose commands run inside the updater image, not in this daemon.
#
# Build context is the repository ROOT (the Rust workspace), set by the hostd
# service in dashboard/docker/docker-compose.yml. See .dockerignore for scope.

# ---------------------------------------------------------------------------
# Builder - compile the daemon to a static musl binary (Alpine rust is musl).
# ---------------------------------------------------------------------------
FROM rust:1-alpine AS builder

RUN apk add --no-cache musl-dev

WORKDIR /build
COPY . .

# Only the daemon is built; the other workspace members are not compiled.
RUN cargo build --release -p polaris-hostd

# ---------------------------------------------------------------------------
# Runner - Alpine + Docker CLI only. Runs as root: the daemon brokers
# privileged host operations and reaches the Docker socket. It listens on a
# unix socket (0660) guarded by a per-run bearer token.
# ---------------------------------------------------------------------------
# Pinned to the Alpine minor so a rebuild never moves to a new release on its
# own; `apk upgrade` below picks up that branch's fixes on every rebuild. The
# daemon installs NUT and cifs-utils from the same branch on first use
# (src/packages.rs), so bumping this line moves those too.
FROM alpine:3.24

# docker-cli drives builds/pulls; tar unpacks the build context for Nixpacks.
# Nixpacks (best-effort, arch-aware) auto-builds repos that ship no Dockerfile; if
# the download fails the image still builds and Dockerfile-based deploys keep working.
ARG TARGETARCH
ARG NIXPACKS_VERSION=1.29.0
# docker-cli-compose is REQUIRED: deploys run `docker compose up`. Without the
# plugin the daemon has no `compose` subcommand and every deploy fails.
# docker-cli-buildx stays: `docker build` and compose builds need BuildKit, and
# without it any Dockerfile using `RUN --mount` fails. The Alpine packages carry
# the same Go modules as Docker's own release binaries of the same versions, so
# swapping them for those would change nothing; newer releases arrive through
# `apk upgrade`.
# nfs-utils provides mount.nfs so the daemon can kernel-mount NFS shares.
# nut (/v1/ups) and cifs-utils (SMB shares) are NOT here: their libraries carry
# advisories with no fix (libmodbus, net-snmp, libwbclient) and most hosts never
# use either, so the daemon installs each the first time it is needed and keeps
# the packages on its cache volume for the next start.
RUN apk upgrade --no-cache \
    && apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx tar ca-certificates nfs-utils \
    && case "$TARGETARCH" in \
        arm64) NARCH=aarch64 ;; \
        *) NARCH=x86_64 ;; \
    esac \
    && ( wget -qO /tmp/nixpacks.tar.gz \
            "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/nixpacks-v${NIXPACKS_VERSION}-${NARCH}-unknown-linux-musl.tar.gz" \
        && tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin nixpacks \
        && rm -f /tmp/nixpacks.tar.gz ) \
    || echo "nixpacks unavailable for ${TARGETARCH}; Dockerfile builds still work"

COPY --from=builder /build/target/release/polaris-hostd /usr/local/bin/polaris-hostd

ENTRYPOINT ["/usr/local/bin/polaris-hostd"]
