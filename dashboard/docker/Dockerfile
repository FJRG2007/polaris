# Polaris dashboard image. Multi-stage: a full workspace build, then a slim
# runtime that carries only the Next.js standalone output plus the Prisma CLI
# needed to apply migrations on start.
#
# Build context is the dashboard/ monorepo root (see docker-compose.yml, which
# sets `context: ..`). The same image serves both editions; the privileged
# host daemon runs as a separate service (see docker-compose.yml `full` profile).

# ---------------------------------------------------------------------------
# Builder - compile every workspace package and the Next.js app.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# openssl lets Prisma detect the right engine (debian-openssl-3.0.x) at generate
# time so the client matches the runner, which also has openssl 3.x on bookworm.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Dependency layer: copy only the workspace manifests + lockfile first so the
# `npm ci` layer is cached and re-runs ONLY when dependencies change, not on every
# source edit (the old `COPY . .` before install invalidated it on any file change).
# The npm cache mount avoids re-downloading even when the layer does rebuild.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
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
# Build-only sidecar workspace (services/*). Its manifest must be present or `npm
# ci` fails the lockfile-consistency check, even though the web image never builds
# it - it ships as its own image.
COPY services/edge-guard/package.json ./services/edge-guard/

# `npm ci` installs the whole workspace from the committed lockfile.
RUN --mount=type=cache,target=/root/.npm npm ci

# The source tree follows (node_modules/.next/dist are .dockerignore'd, so this
# does not clobber the installed dependencies above).
COPY . .

# Generate the Prisma client (output: packages/db/generated/client) and build
# all packages, then the app. `npm run build` fans out across the workspaces.
RUN npm run db:generate
RUN npm run build

# Bundle the deploy terminal sidecar into one self-contained CJS file. It runs as
# a separate process alongside the Next server, outside the standalone bundle, so
# its imports (@polaris/hostd-client, ws) must be inlined or they resolve to
# nothing at runtime (the old ERR_MODULE_NOT_FOUND). The optional native ws
# accelerators stay external - ws degrades gracefully without them.
RUN node_modules/.bin/esbuild apps/web/ws-server.mjs --bundle --platform=node \
    --format=cjs --external:bufferutil --external:utf-8-validate \
    --outfile=apps/web/ws-server.bundle.cjs

# The standalone tracer omits an app that ships no public/ dir; guarantee the
# directory exists so the runtime COPY below never fails.
RUN mkdir -p /build/apps/web/public

# ---------------------------------------------------------------------------
# Runner - minimal runtime. Non-root, only the standalone server + migrations.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

# Commit this image was built from, passed by CI. Surfaced by the update checker
# so the dashboard can report how far behind the release branch it is.
ARG POLARIS_BUILD_SHA=""

ENV NODE_ENV=production \
    # Next standalone server binds these; 0.0.0.0 so the proxy can reach it.
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # SMB (NTLM) auth needs MD4, which OpenSSL 3 gates behind the legacy provider;
    # without this the SMB client throws ERR_OSSL_EVP_UNSUPPORTED as an uncaught
    # exception and takes the whole web process down.
    NODE_OPTIONS=--openssl-legacy-provider \
    POLARIS_BUILD_SHA=$POLARIS_BUILD_SHA

# openssl for the Prisma engines; ca-certificates for TLS to Postgres; smbclient
# so Polaris can enumerate and reach SMB shares (e.g. a UniFi UNAS) itself -
# the user never has to install or run smbclient on the host.
# git + tar let the Deploy app build applications from a public git repository
# (clone + tar the context, then build it on the target).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates smbclient git tar \
    && rm -rf /var/lib/apt/lists/*

# Prisma CLI, pinned to the version used by @polaris/db, so `migrate deploy`
# in the entrypoint matches the generated client and committed migrations.
RUN npm install -g prisma@6.2.1

WORKDIR /app

# Next standalone (monorepo layout) emits a tree rooted at the workspace root:
#   apps/web/.next/standalone/apps/web/server.js   <- entry
#   apps/web/.next/standalone/node_modules         <- traced deps
# Copying the standalone root to /app preserves that structure.
COPY --from=builder /build/apps/web/.next/standalone ./
# Static assets and public/ are not part of the traced standalone bundle.
COPY --from=builder /build/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /build/apps/web/public ./apps/web/public

# The deploy terminal sidecar, bundled into a single self-contained CJS file in
# the builder stage. server.js does not import it, so Next's output tracing omits
# it; the bundle inlines every dependency, so no node_modules copy is needed.
COPY --from=builder /build/apps/web/ws-server.bundle.cjs ./apps/web/ws-server.bundle.cjs

# Schema + migrations so the entrypoint can run `prisma migrate deploy`.
COPY --from=builder /build/packages/db/prisma ./packages/db/prisma

# Prisma's client gets bundled INTO the Next server output, so at runtime it
# looks for its query engine next to the bundle, under apps/web - not in
# node_modules. It searches apps/web/generated/client and apps/web/.next/server
# (confirmed from the "engine-not-found" error). Place the generated client and
# its .node engine in both, or every database query 500s.
COPY --from=builder /build/packages/db/generated ./apps/web/generated
COPY --from=builder /build/packages/db/generated/client/*.node ./apps/web/.next/server/

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The polaris CLI inside the container: `docker exec polaris-web-1 polaris setup`
# reads POLARIS_SETUP_TOKEN from the container env.
COPY cli/polaris /usr/local/bin/polaris
RUN chmod +x /usr/local/bin/polaris && ln -sf /usr/local/bin/polaris /usr/local/bin/plr

# The persistent data dir (backups, etc.) must be writable by the unprivileged
# runtime user. Create and own it here so a fresh named volume inherits node's
# ownership; the backup service still falls back to a temp dir if a bind mount
# overrides this with root ownership.
RUN mkdir -p /var/lib/polaris /dynamic && chown -R node:node /var/lib/polaris /dynamic

# Run as the unprivileged `node` user shipped with the base image.
RUN chown -R node:node /app
USER node

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
