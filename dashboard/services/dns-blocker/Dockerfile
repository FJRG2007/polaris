# The network ad blocker: Blocky, reading the configuration Polaris renders.
#
# Polaris writes the whole configuration (lists, allowed and blocked names,
# upstream resolvers, local records) from its own screens, and it cannot write a
# file onto the machine it deploys to. So the configuration travels base64-encoded
# in one environment variable - a file's contents have newlines, which the host
# daemon refuses in an environment value - and the entrypoint writes it out. The
# stock image is built from scratch with no shell to do that, so its binary is
# copied onto a small base that has one.
#
# Pinned rather than tracking latest: the resolver every device in the house asks
# is the last thing that should change under it without anybody choosing to.
FROM ghcr.io/0xerr0r/blocky:v0.35.0 AS blocky

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
    && mkdir -p /app/cache /logs \
    && chown -R 100:100 /app /logs
COPY --from=blocky /app/blocky /app/blocky
COPY services/dns-blocker/entrypoint.sh /polaris-entrypoint.sh
RUN chmod +x /polaris-entrypoint.sh

USER 100
WORKDIR /app
ENV BLOCKY_CONFIG_FILE=/app/config.yml
ENTRYPOINT ["/polaris-entrypoint.sh"]
CMD ["/app/blocky"]
HEALTHCHECK --start-period=1m --timeout=3s CMD ["/app/blocky", "healthcheck"]
