# Tiny mDNS responder image. Runs on the host network (see docker-compose) so its
# multicast announcements reach the LAN and polaris.local resolves everywhere.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY responder.mjs ./
USER node
CMD ["node", "responder.mjs"]
