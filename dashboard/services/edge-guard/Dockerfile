# polaris-edge-guard image. Build context is the dashboard root (same as the web
# image), so the workspace and @polaris/core are available. The guard is bundled
# into a single file by tsup, so the runtime stage is just node + one file - a
# minimal, reliable sentinel with no node_modules to resolve at boot.

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
COPY packages/ssh/package.json ./packages/ssh/
COPY packages/storage/package.json ./packages/storage/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/
COPY services/edge-guard/package.json ./services/edge-guard/
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
# @polaris/core must be built first (the guard bundles from its dist), then bundle.
RUN npm run build -w @polaris/core && npm run build -w @polaris/edge-guard

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# The bundle is self-contained; nothing else from the workspace is needed.
COPY --from=builder /build/services/edge-guard/dist/index.js ./index.js
USER node
EXPOSE 8080
CMD ["node", "index.js"]
