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
FROM alpine:3

# docker-cli drives builds/pulls; tar unpacks the build context for Nixpacks.
# Nixpacks (best-effort, arch-aware) auto-builds repos that ship no Dockerfile; if
# the download fails the image still builds and Dockerfile-based deploys keep working.
ARG TARGETARCH
ARG NIXPACKS_VERSION=1.29.0
# docker-cli-compose is REQUIRED: deploys run `docker compose up`. Without the
# plugin the daemon has no `compose` subcommand and every deploy fails.
# cifs-utils/nfs-utils provide mount.cifs/mount.nfs so the daemon can kernel-mount
# NAS shares (SMB/NFS) for nas volumes; without them `mount -t cifs` fails.
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx tar ca-certificates cifs-utils nfs-utils \
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
