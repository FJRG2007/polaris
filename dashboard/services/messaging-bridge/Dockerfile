# polaris messaging-bridge image. Build context is the dashboard root (same as the
# web image) so the workspace and @polaris/messaging are available. tsup bundles
# the bridge (with @polaris/* and zod inlined) into one file; whatsapp-web.js and
# its Puppeteer/Chromium cannot be bundled, so they are installed in the runner.

FROM node:22-bookworm-slim AS builder
WORKDIR /build

# Manifests first so the npm ci layer is cached until dependencies change.
COPY package.json package-lock.json ./
COPY packages/auth/package.json ./packages/auth/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/deploy/package.json ./packages/deploy/
COPY packages/docker/package.json ./packages/docker/
COPY packages/hostd-client/package.json ./packages/hostd-client/
COPY packages/messaging/package.json ./packages/messaging/
COPY packages/ssh/package.json ./packages/ssh/
COPY packages/storage/package.json ./packages/storage/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/
COPY services/edge-guard/package.json ./services/edge-guard/
COPY services/messaging-bridge/package.json ./services/messaging-bridge/
# The bridge pulls Puppeteer transitively; skip its Chromium download (the runner
# uses the system chromium instead).
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
# @polaris/messaging must be built first (the bridge bundles from its dist).
RUN npm run build -w @polaris/messaging && npm run build -w @polaris/messaging-bridge

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Use the system Chromium for whatsapp-web.js; never let Puppeteer download its own.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium ca-certificates fonts-liberation && \
    rm -rf /var/lib/apt/lists/*

# The bundle inlines @polaris/* and zod; the rest of the adapters' npm deps
# (discord.js, whatsapp-web.js + its Puppeteer/Chromium, qrcode) stay external and
# load from node_modules here - Chromium and discord.js's dynamic requires do not
# bundle. registry.ts imports every adapter eagerly, so a single missing package
# crashes the whole bridge on start (the ERR_MODULE_NOT_FOUND crashloop); keep this
# list in sync with the bridge's runtime dependencies. type=module so the ESM
# bundle runs under `node index.js`.
COPY --from=builder /build/services/messaging-bridge/dist/index.js ./index.js
RUN echo '{"type":"module"}' > package.json && \
    npm install --omit=dev discord.js@14.16.3 whatsapp-web.js@1.34.7 qrcode@1.5.4 && \
    mkdir -p /app/.sessions && chown -R node:node /app

USER node
EXPOSE 8787
CMD ["node", "index.js"]
