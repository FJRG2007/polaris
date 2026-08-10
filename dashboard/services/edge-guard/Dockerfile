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
# Plain `npm ci`, no BuildKit cache mount: an update builds this on the operator's
# own machine, and `docker compose` falls back to the classic builder wherever the
# buildx plugin is absent - which rejects `RUN --mount` and fails the update.
RUN npm ci

COPY . .
# @polaris/core must be built first (the guard bundles from its dist), then bundle.
RUN npm run build -w @polaris/core && npm run build -w @polaris/edge-guard

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# The bundle is self-contained; nothing else from the workspace is needed.
COPY --from=builder /build/services/edge-guard/dist/index.js ./index.js
# The intel volume is mounted read-only here, but ownership is decided by whichever
# container mounts it first: if that is this one and the mountpoint is root-owned,
# the control plane can never write the list this guard reads. Created node-owned
# in both images so the order stops mattering.
RUN mkdir -p /edge-intel && chown -R node:node /edge-intel
USER node
# 8080 answers Traefik's forwardAuth question; 8081 IS the upstream for a route whose
# response gets rewritten. Both are declared so `docker ps` shows what the container
# actually serves - a guard listed as 8080-only reads as one that has no proxy.
EXPOSE 8080 8081
CMD ["node", "index.js"]
