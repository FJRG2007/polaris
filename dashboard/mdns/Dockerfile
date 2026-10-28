# Tiny mDNS responder image. Runs on the host network (see docker-compose) so its
# multicast announcements reach the LAN and polaris.local resolves everywhere.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
# Then npm, yarn and corepack go: the responder runs one file, and they are
# where the image's reported vulnerabilities were.
RUN npm ci --omit=dev && npm cache clean --force \
    && apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY responder.mjs address.mjs ./

# Where this process publishes the host's LAN address for the dashboard. Owned by
# the runtime user here and in the web image, since Docker seeds a fresh named
# volume from whichever container mounts it first.
RUN mkdir -p /run/polaris-host && chown -R node:node /run/polaris-host

USER node
CMD ["node", "responder.mjs"]
