# polaris messaging-bridge image. Build context is the dashboard root (same as the
# web image) so the workspace and @polaris/messaging are available. The bridge is
# bundled into a single file by tsup, so the runtime stage is just node + one file.

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
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
# @polaris/messaging must be built first (the bridge bundles from its dist).
RUN npm run build -w @polaris/messaging && npm run build -w @polaris/messaging-bridge

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# The bundle is self-contained; nothing else from the workspace is needed.
COPY --from=builder /build/services/messaging-bridge/dist/index.js ./index.js
USER node
EXPOSE 8787
CMD ["node", "index.js"]
