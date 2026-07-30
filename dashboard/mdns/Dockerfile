# Tiny mDNS responder image. Runs on the host network (see docker-compose) so its
# multicast announcements reach the LAN and polaris.local resolves everywhere.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY responder.mjs ./

# Where this process publishes the host's LAN address for the dashboard. Owned by
# the runtime user here and in the web image, since Docker seeds a fresh named
# volume from whichever container mounts it first.
RUN mkdir -p /run/polaris-host && chown -R node:node /run/polaris-host

USER node
CMD ["node", "responder.mjs"]
