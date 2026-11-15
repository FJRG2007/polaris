# polaris-tunnel container image: the tunnel daemon as one static binary and
# nothing else. Build context is the repository ROOT (the Rust workspace).
#
# It runs as the unprivileged user 65532 with no capabilities: userspace
# WireGuard needs no TUN device and no NET_ADMIN. The helper container that
# shares its network namespace writes the config file owned by that user.

# Pinned by digest (rust:1.91-alpine3.22, multi-arch index) so a rebuild never
# moves the toolchain on its own. Alpine's Rust targets musl: the binary is static.
FROM rust:1.91-alpine3.22@sha256:8efbfb788786eeb127adc581394349c5fb567712156e0f8c2e499acadbc23756 AS builder

RUN apk add --no-cache musl-dev

WORKDIR /build
COPY . .

RUN cargo build --release --locked -p polaris-tunnel \
    && cp target/release/polaris-tunnel /polaris-tunnel

# No base image at all: the binary needs no libc, shell or certificates.
FROM scratch

COPY --from=builder /polaris-tunnel /polaris-tunnel

USER 65532:65532

ENTRYPOINT ["/polaris-tunnel"]
