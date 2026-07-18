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

# Reproducible install: copy the lockfile-bearing manifests first so this layer
# is cached until dependencies actually change. The full tree follows.
COPY . .

# `npm ci` installs the whole workspace from the committed lockfile.
RUN npm ci

# Generate the Prisma client (output: packages/db/generated/client) and build
# all packages, then the app. `npm run build` fans out across the workspaces.
RUN npm run db:generate
RUN npm run build

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
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates smbclient \
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

# Run as the unprivileged `node` user shipped with the base image.
RUN chown -R node:node /app
USER node

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
