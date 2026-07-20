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

RUN apk add --no-cache docker-cli

COPY --from=builder /build/target/release/polaris-hostd /usr/local/bin/polaris-hostd

ENTRYPOINT ["/usr/local/bin/polaris-hostd"]
