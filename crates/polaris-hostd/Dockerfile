# polaris-hostd container image. Builds the static host daemon and ships it on a
# minimal Alpine runtime carrying the Docker CLI with its compose and buildx
# plugins (deploys, builds, and POST /v1/update launching the one-shot updater
# container) and Nixpacks.
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
# Runner - Alpine + the Docker CLI and its plugins. Runs as root: the daemon brokers
# privileged host operations and reaches the Docker socket. It listens on a
# unix socket (0660) guarded by a per-run bearer token.
# ---------------------------------------------------------------------------
# Pinned to the Alpine minor so a rebuild never moves to a new release on its
# own; `apk upgrade` below picks up that branch's fixes on every rebuild. The
# daemon installs NUT and cifs-utils from the same branch on first use
# (src/packages.rs), so bumping this line moves those too.
FROM alpine:3.24

# docker drives builds and pulls, and deploys run `docker compose up`: without
# the compose plugin the daemon has no `compose` subcommand and every deploy
# fails. buildx stays because `docker build` and compose builds need BuildKit,
# and without it any Dockerfile using `RUN --mount` fails.
#
# All three are Docker's own release binaries, pinned by version and checked
# against a SHA-256 here, rather than Alpine's packages: those trail the
# releases, and the Go libraries compiled into an older build (golang.org/x/net,
# moby/go-archive) were where this image's critical findings were. Moving a
# version is editing these lines, never `latest`.
#   docker CLI: https://download.docker.com/linux/static/stable/ (no published
#     checksum; the values are the archives' own, taken when the version was set)
#   compose:    https://github.com/docker/compose/releases/download/v5.7.0/checksums.txt
#   buildx:     https://github.com/docker/buildx/releases/download/v0.38.2/checksums.txt
#   nixpacks:   https://github.com/railwayapp/nixpacks/releases/tag/v1.29.0 (no
#     published checksum; same as the docker CLI)
ARG TARGETARCH
ARG DOCKER_VERSION=29.9.2
ARG DOCKER_SHA256_AMD64=9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb
ARG DOCKER_SHA256_ARM64=873b3e0207857c3b2f28392fb922f3ea6efe37620c16d4d4aaf2fef409c90b73
ARG COMPOSE_VERSION=5.7.0
ARG COMPOSE_SHA256_AMD64=7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2
ARG COMPOSE_SHA256_ARM64=15861535d14e26555736b49376c95e14bfd94285366c8446bfac7156a972e76f
ARG BUILDX_VERSION=0.38.2
ARG BUILDX_SHA256_AMD64=7992ec09413b80ff57ba4e081f56fc833d7bac1d5e71143c6c809e7e6065f6d6
ARG BUILDX_SHA256_ARM64=46c0f334772de3cb0b341cc415caf7339fb5cfc8b8438ebcb5a10e7f23800d36
# Nixpacks auto-builds repositories that ship no Dockerfile.
ARG NIXPACKS_VERSION=1.29.0
ARG NIXPACKS_SHA256_AMD64=b8bf8b3c00d171b0abd5a7f73a31f3c2a6baed263b8393018227da530f8609cf
ARG NIXPACKS_SHA256_ARM64=2b0081e10187d0a3ffde12b474cde1ddff4a3dbe2e09e2640df195d2635ea3e0
# tar unpacks the build context for Nixpacks; nfs-utils provides mount.nfs so the
# daemon can kernel-mount NFS shares.
# nut (/v1/ups) and cifs-utils (SMB shares) are NOT here: their libraries carry
# advisories with no fix (libmodbus, net-snmp, libwbclient) and most hosts never
# use either, so the daemon installs each the first time it is needed and keeps
# the packages on its cache volume for the next start.
RUN set -eu; \
    apk upgrade --no-cache; \
    apk add --no-cache tar ca-certificates nfs-utils; \
    case "$TARGETARCH" in \
        amd64) DARCH=x86_64; CARCH=x86_64; BARCH=amd64; NARCH=x86_64; \
            DSUM="$DOCKER_SHA256_AMD64"; CSUM="$COMPOSE_SHA256_AMD64"; \
            BSUM="$BUILDX_SHA256_AMD64"; NSUM="$NIXPACKS_SHA256_AMD64" ;; \
        arm64) DARCH=aarch64; CARCH=aarch64; BARCH=arm64; NARCH=aarch64; \
            DSUM="$DOCKER_SHA256_ARM64"; CSUM="$COMPOSE_SHA256_ARM64"; \
            BSUM="$BUILDX_SHA256_ARM64"; NSUM="$NIXPACKS_SHA256_ARM64" ;; \
        *) echo "hostd: no Docker build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    plugins=/usr/local/libexec/docker/cli-plugins; \
    mkdir -p "$plugins"; \
    wget -q -O /tmp/docker.tgz \
        "https://download.docker.com/linux/static/stable/${DARCH}/docker-${DOCKER_VERSION}.tgz"; \
    echo "$DSUM  /tmp/docker.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker; \
    wget -q -O "$plugins/docker-compose" \
        "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${CARCH}"; \
    echo "$CSUM  $plugins/docker-compose" | sha256sum -c -; \
    wget -q -O "$plugins/docker-buildx" \
        "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${BARCH}"; \
    echo "$BSUM  $plugins/docker-buildx" | sha256sum -c -; \
    wget -q -O /tmp/nixpacks.tar.gz \
        "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/nixpacks-v${NIXPACKS_VERSION}-${NARCH}-unknown-linux-musl.tar.gz"; \
    echo "$NSUM  /tmp/nixpacks.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin nixpacks; \
    chmod 0755 /usr/local/bin/docker /usr/local/bin/nixpacks "$plugins/docker-compose" "$plugins/docker-buildx"; \
    rm -f /tmp/docker.tgz /tmp/nixpacks.tar.gz; \
    docker --version; docker compose version; docker buildx version

COPY --from=builder /build/target/release/polaris-hostd /usr/local/bin/polaris-hostd

ENTRYPOINT ["/usr/local/bin/polaris-hostd"]
