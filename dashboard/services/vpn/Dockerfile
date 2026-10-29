# The VPN: Headscale, the self-hosted Tailscale control server, reading the
# configuration Polaris renders.
#
# Polaris writes the whole configuration (its address, the tailnet's DNS) from
# its own screens and cannot write a file onto the machine it deploys to, so the
# configuration travels base64-encoded in one environment variable - a file's
# contents have newlines, which the host daemon refuses in an environment value -
# and the entrypoint writes it out. The upstream image is distroless with no
# shell to do that, so the released binary is put onto a small base that has one.
#
# Pinned, and checked against the checksums the release publishes, rather than
# tracking latest: every device on the tailnet talks to this server, and the
# control protocol is the last thing that should change under them without
# anybody choosing to.
FROM alpine:3.20
ARG TARGETARCH
ARG HEADSCALE_VERSION=0.29.6
# From https://github.com/juanfont/headscale/releases/download/v0.29.6/checksums.txt
ARG HEADSCALE_SHA256_AMD64=7477c374949eea6fb7cf3cbff14dbef49e4d118d9a33557d6764a77ece617e53
ARG HEADSCALE_SHA256_ARM64=7b3c792ebe10e1a81a0c8d9674aee8eb540e7dbb7ccb80a98b71024da4c72a48
RUN set -eu; \
    apk add --no-cache ca-certificates tzdata; \
    case "$TARGETARCH" in \
        amd64) sum="$HEADSCALE_SHA256_AMD64" ;; \
        arm64) sum="$HEADSCALE_SHA256_ARM64" ;; \
        *) echo "vpn: no Headscale build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    wget -q -O /usr/local/bin/headscale \
        "https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/headscale_${HEADSCALE_VERSION}_linux_${TARGETARCH}"; \
    echo "$sum  /usr/local/bin/headscale" | sha256sum -c -; \
    chmod +x /usr/local/bin/headscale; \
    mkdir -p /etc/headscale /var/lib/headscale /var/run/headscale
COPY services/vpn/entrypoint.sh /polaris-entrypoint.sh
RUN chmod +x /polaris-entrypoint.sh

# The database, the server's noise key and everything else it keeps. Polaris
# mounts a volume here so a redeploy (every saved setting is one) keeps every
# device signed in.
VOLUME /var/lib/headscale
EXPOSE 8080
ENV HEADSCALE_CONFIG=/etc/headscale/config.yaml
ENTRYPOINT ["/polaris-entrypoint.sh"]
CMD ["headscale", "serve"]
HEALTHCHECK --start-period=30s --timeout=3s CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
