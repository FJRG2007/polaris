# The Matter bridge: the OHF Matter.js server for cameras, behind an account,
# with a WebRTC signalling door the camera relay dials.
#
# Built the way the upstream image is built (docker/matterjs-server/Dockerfile
# in matter-js/matterjs-server), from the npm release pinned in deps/ with its
# lockfile, so the image moves only when those files do. Bluetooth is left out:
# a camera is added with the code its own app shares, over the network it is
# already on.
FROM node:24-trixie-slim

WORKDIR /app

COPY services/matter-bridge/deps/package.json services/matter-bridge/deps/package-lock.json ./

RUN set -eux \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends tini iputils-ping \
    && npm ci --omit=dev --no-audit --no-fund \
    && test -f node_modules/matter-server/dist/esm/MatterServer.js \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* /tmp/* /root/.npm \
    && mkdir /data \
    && chown 1000:1000 /data

COPY services/matter-bridge/src /app/bridge

ENV LOG_LEVEL=info
ENV MATTER_LOG_FORMAT=plain

VOLUME ["/data"]
EXPOSE 5590

USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/bridge/bridge.mjs"]
