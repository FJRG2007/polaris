# One-shot updater image. polaris-hostd's POST /v1/update spawns a short-lived
# container from this image to perform a full, correct update: it runs the repo's
# own install.sh (git pull, reconcile .env, pull images, apply migrations,
# redeploy, verify) against the host Docker Engine, then exits.
#
# At runtime hostd bind-mounts the host repo checkout and the Docker socket into
# the container, so it carries git (to pull), the Docker CLI + compose plugin (to
# redeploy), and openssl (install.sh generates/reconciles secrets with it). It is
# never long-running and holds no state.
#
# Pinned to the Alpine minor, as the hostd image is, so a rebuild never moves to
# a new release on its own; `apk upgrade` picks up that branch's fixes.
FROM alpine:3.24

# The Docker CLI and its compose plugin are Docker's own release binaries, pinned
# by version and checked against a SHA-256, rather than Alpine's packages, which
# trail the releases and carry the older Go libraries the scans flag. The same
# versions as the host daemon's image (crates/polaris-hostd/Dockerfile), where
# the sources of the checksums are listed; move both together.
ARG TARGETARCH
ARG DOCKER_VERSION=29.9.2
ARG DOCKER_SHA256_AMD64=9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb
ARG DOCKER_SHA256_ARM64=873b3e0207857c3b2f28392fb922f3ea6efe37620c16d4d4aaf2fef409c90b73
ARG COMPOSE_VERSION=5.7.0
ARG COMPOSE_SHA256_AMD64=7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2
ARG COMPOSE_SHA256_ARM64=15861535d14e26555736b49376c95e14bfd94285366c8446bfac7156a972e76f
RUN set -eu; \
    apk upgrade --no-cache; \
    apk add --no-cache git openssl; \
    case "$TARGETARCH" in \
        amd64) DARCH=x86_64; DSUM="$DOCKER_SHA256_AMD64"; CSUM="$COMPOSE_SHA256_AMD64" ;; \
        arm64) DARCH=aarch64; DSUM="$DOCKER_SHA256_ARM64"; CSUM="$COMPOSE_SHA256_ARM64" ;; \
        *) echo "updater: no Docker build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    plugins=/usr/local/libexec/docker/cli-plugins; \
    mkdir -p "$plugins"; \
    wget -q -O /tmp/docker.tgz \
        "https://download.docker.com/linux/static/stable/${DARCH}/docker-${DOCKER_VERSION}.tgz"; \
    echo "$DSUM  /tmp/docker.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker; \
    wget -q -O "$plugins/docker-compose" \
        "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${DARCH}"; \
    echo "$CSUM  $plugins/docker-compose" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/docker "$plugins/docker-compose"; \
    rm -f /tmp/docker.tgz; \
    docker --version; docker compose version

# The bind-mounted repo is owned by the host user, not root-in-container, which
# would trip git's "dubious ownership" guard and abort the pull. This container
# is ephemeral and only ever runs our own install.sh, so trusting any mounted
# checkout is safe and keeps the update hands-off.
RUN git config --system --add safe.directory '*'
