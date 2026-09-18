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
COPY apps/game-servers/package.json ./apps/game-servers/
COPY apps/places/package.json ./apps/places/
# Every workspace manifest, one line each and all of them: a package missing here
# is a package `npm ci` never links into node_modules, so it builds its own output
# and every other package that imports it fails to resolve its types - which is
# what happened, in this image alone, while the same build passed everywhere else.
# `test/build/docker-manifests.test.ts` fails when this list and `packages/` stop
# agreeing, because nothing else notices until an image build breaks.
COPY packages/agent-core/package.json ./packages/agent-core/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/app-host/package.json ./packages/app-host/
COPY packages/ai-provider/package.json ./packages/ai-provider/
COPY packages/ai-search/package.json ./packages/ai-search/
COPY packages/auth/package.json ./packages/auth/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/deploy/package.json ./packages/deploy/
COPY packages/docker/package.json ./packages/docker/
COPY packages/docx/package.json ./packages/docx/
COPY packages/electron-utils/package.json ./packages/electron-utils/
COPY packages/file-parse/package.json ./packages/file-parse/
COPY packages/font-metrics/package.json ./packages/font-metrics/
COPY packages/genoffice-docs/package.json ./packages/genoffice-docs/
COPY packages/genoffice-markdown/package.json ./packages/genoffice-markdown/
COPY packages/genoffice-pdf/package.json ./packages/genoffice-pdf/
COPY packages/genoffice-slides/package.json ./packages/genoffice-slides/
COPY packages/genoffice-ui/package.json ./packages/genoffice-ui/
COPY packages/hostd-client/package.json ./packages/hostd-client/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/messaging/package.json ./packages/messaging/
COPY packages/office-layout/package.json ./packages/office-layout/
COPY packages/pdf2docx/package.json ./packages/pdf2docx/
COPY packages/pptx/package.json ./packages/pptx/
COPY packages/pptx-render/package.json ./packages/pptx-render/
COPY packages/project-store/package.json ./packages/project-store/
COPY packages/ssh/package.json ./packages/ssh/
COPY packages/storage/package.json ./packages/storage/
COPY packages/ui/package.json ./packages/ui/
COPY packages/vault-crypto/package.json ./packages/vault-crypto/
# Build-only sidecar workspace (services/*). Its manifest must be present or `npm
# ci` fails the lockfile-consistency check, even though the web image never builds
# it - it ships as its own image.
COPY services/edge-guard/package.json ./services/edge-guard/

# Dependency patches (patch-package) must be present before install: the root
# `postinstall` runs `patch-package`, which applies patches/*.patch to node_modules
# (e.g. the SMB client's over-broad open access mask). Copied before `npm ci` so the
# fix is baked into the installed dependencies the build then bundles.
COPY patches ./patches

# `npm ci` installs the whole workspace from the committed lockfile, then runs the
# root postinstall (patch-package) to apply patches/.
#
# No BuildKit cache mount here. An update builds this image on the operator's own
# machine, where `docker compose` falls back to the classic builder whenever the
# buildx plugin is absent - and the classic builder rejects `RUN --mount` outright,
# which fails the update with a Docker error and leaves the box on its old build.
# The layer cache already covers the common case: this step only re-runs when the
# lockfile changes, which is exactly when the packages have to be fetched anyway.
RUN npm ci

# The source tree follows (node_modules/.next/dist are .dockerignore'd, so this
# does not clobber the installed dependencies above).
COPY . .

# Generate the Prisma client (output: packages/db/generated/client) and build
# all packages, then the app. `npm run build` fans out across the workspaces.
RUN npm run db:generate
# Extra heap for the Next build, passed by CI where the runner has the memory for
# it (the default ~4 GB is what the app build now peaks at). Empty on an
# operator's machine, which keeps Node's own limit for the RAM that box has.
ARG NODE_BUILD_OPTIONS=""
RUN NODE_OPTIONS="$NODE_BUILD_OPTIONS" npm run build

# Build every installable app into the bundle a server that installs it downloads
# (packages/app-host/bundler). The image itself keeps only the index: which bundle,
# by digest, belongs to this build. CI publishes the bundles next to the image and
# the dashboard fetches them from there, checking each against this index.
#
# An image built on the operator's own machine (the "build" update source) has
# nothing published for it, so by default it carries its bundles inside, and the
# dashboard unpacks them from there instead. CI passes POLARIS_APP_BUNDLES=publish.
ARG POLARIS_APP_BUNDLES=embed
RUN node packages/app-host/bundler/build.mjs /build/app-bundles \
    && mkdir -p /build/app-bundles-image \
    && cp /build/app-bundles/index.json /build/app-bundles-image/ \
    && if [ "$POLARIS_APP_BUNDLES" = "embed" ]; then cp /build/app-bundles/*.zip /build/app-bundles-image/; fi

# Bundle the deploy terminal sidecar into one self-contained CJS file. It runs as
# a separate process alongside the Next server, outside the standalone bundle, so
# its imports (@polaris/hostd-client, @polaris/ssh, ws) must be inlined or they
# resolve to nothing at runtime (the old ERR_MODULE_NOT_FOUND). The optional
# native ws accelerators stay external - ws degrades gracefully without them.
#
# ssh2 stays external too, for a different reason: it reaches for an optional
# native module by a path relative to its own directory, which a bundler cannot
# resolve. It is already in the standalone node_modules (the SFTP driver pulls it
# in), and the sidecar sits under that tree, so the plain require finds it.
RUN node_modules/.bin/esbuild apps/web/ws-server.mjs --bundle --platform=node \
    --format=cjs --external:bufferutil --external:utf-8-validate --external:ssh2 \
    --outfile=apps/web/ws-server.bundle.cjs

# The standalone tracer omits an app that ships no public/ dir; guarantee the
# directory exists so the runtime COPY below never fails.
RUN mkdir -p /build/apps/web/public

# ---------------------------------------------------------------------------
# App bundles - what CI publishes beside the image, exported from the same build
# (`--target app-bundles --output type=local`) so the digests the image names are
# the digests of the files published.
# ---------------------------------------------------------------------------
FROM scratch AS app-bundles
COPY --from=builder /build/app-bundles /

# ---------------------------------------------------------------------------
# Minecraft mods - Polaris login, built from resources/minecraft and served by
# the dashboard to the game servers that switch it on (app/api/minecraft/mod).
# One stage per jar so each layer is reused until its own sources, or the ones
# both share (polaris-common), change. Each jar is renamed to the file name the
# dashboard serves (MOD_BUILDS in lib/apps/minecraft/polaris-login.ts, which a
# test holds to these lines). The version it reports carries a fingerprint of
# its sources, and is written beside the jar too, so the panel can tell a server
# still running an older build (lib/apps/minecraft/polaris-mod-files.ts).
# ---------------------------------------------------------------------------
FROM gradle:9.2.1-jdk21 AS minecraft-mods

WORKDIR /mods
COPY resources/minecraft/polaris-common/ ./polaris-common/
COPY resources/minecraft/polaris-neoforge/ ./polaris-neoforge/
RUN cd /mods/polaris-neoforge \
    && version="$(sed -n 's/^mod_version=//p' gradle.properties)+$(cd /mods && find polaris-neoforge polaris-common -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-12)" \
    && gradle --no-daemon -q build -Pmod_version="$version" \
    && mkdir -p /out \
    && cp "build/libs/polaris-$version.jar" /out/polaris-neoforge-1.21.4.jar \
    && printf '%s\n' "$version" > /out/polaris-neoforge-1.21.4.jar.version

# The same login as a plugin, for Paper, Purpur and Spigot.
FROM gradle:9.2.1-jdk21 AS minecraft-plugins

WORKDIR /mods
COPY resources/minecraft/polaris-common/ ./polaris-common/
COPY resources/minecraft/polaris-paper/ ./polaris-paper/
RUN cd /mods/polaris-paper \
    && version="$(sed -n 's/^mod_version=//p' gradle.properties)+$(cd /mods && find polaris-paper polaris-common -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-12)" \
    && gradle --no-daemon -q build -Pmod_version="$version" \
    && mkdir -p /out \
    && cp "build/libs/polaris-$version.jar" /out/polaris-paper.jar \
    && printf '%s\n' "$version" > /out/polaris-paper.jar.version

# ---------------------------------------------------------------------------
# Runner - minimal runtime. Non-root, only the standalone server + migrations.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    # Next standalone server binds these; 0.0.0.0 so the proxy can reach it.
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # SMB (NTLM) auth needs MD4, which OpenSSL 3 gates behind the legacy provider;
    # without this the SMB client throws ERR_OSSL_EVP_UNSUPPORTED as an uncaught
    # exception and takes the whole web process down.
    NODE_OPTIONS=--openssl-legacy-provider

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

# Commit this image was built from, passed by CI. Surfaced by the update checker
# so the dashboard can report how far behind the release branch it is.
#
# Declared here, after the system packages and the Prisma CLI, not above them: a
# build argument is part of the cache key of every RUN after it, and this one
# changes with every commit. Declared first, it rebuilt those two layers - over
# 400 MB - on every build, and every Update downloaded them again for nothing.
ARG POLARIS_BUILD_SHA=""
ENV POLARIS_BUILD_SHA=$POLARIS_BUILD_SHA

WORKDIR /app

# Next standalone (monorepo layout) emits a tree rooted at the workspace root:
#   apps/web/.next/standalone/apps/web/server.js   <- entry
#   apps/web/.next/standalone/node_modules         <- traced deps
# Copying the standalone root to /app preserves that structure.
COPY --from=builder --chown=node:node /build/apps/web/.next/standalone ./
# Static assets and public/ are not part of the traced standalone bundle.
COPY --from=builder --chown=node:node /build/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /build/apps/web/public ./apps/web/public

# The Minecraft mods the dashboard serves. The build keeps each jar's modification
# time, which is what a game server's image compares against on every boot.
COPY --from=minecraft-mods --chown=node:node /out ./minecraft-mods
COPY --from=minecraft-plugins --chown=node:node /out ./minecraft-mods

# The deploy terminal sidecar, bundled into a single self-contained CJS file in
# the builder stage. server.js does not import it, so Next's output tracing omits
# it; the bundle inlines every dependency, so no node_modules copy is needed.
COPY --from=builder --chown=node:node /build/apps/web/ws-server.bundle.cjs ./apps/web/ws-server.bundle.cjs

# Which app bundle belongs to this build (and, built here, the bundles themselves).
COPY --from=builder --chown=node:node /build/app-bundles-image ./app-bundles

# Schema + migrations so the entrypoint can run `prisma migrate deploy`.
COPY --from=builder --chown=node:node /build/packages/db/prisma ./packages/db/prisma

# Prisma's client gets bundled INTO the Next server output, so at runtime it
# looks for its query engine next to the bundle, under apps/web - not in
# node_modules. It searches apps/web/generated/client and apps/web/.next/server
# (confirmed from the "engine-not-found" error). Place the generated client and
# its .node engine in both, or every database query 500s.
COPY --from=builder --chown=node:node /build/packages/db/generated ./apps/web/generated
COPY --from=builder --chown=node:node /build/packages/db/generated/client/*.node ./apps/web/.next/server/

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
RUN mkdir -p /var/lib/polaris /dynamic /call-keys && chown -R node:node /var/lib/polaris /dynamic /call-keys

# Where the mDNS responder publishes the host's LAN address. Created and owned
# here as well as in the responder's image: Docker seeds a fresh named volume
# from whichever container mounts it first, and a root-owned mountpoint would
# leave the responder unable to write the address at all.
RUN mkdir -p /run/polaris-host && chown -R node:node /run/polaris-host

# Where the firewall's address list is published for the edge guard to read. Same
# reasoning as above, and the same failure when it is missing: the mountpoint is
# created root-owned, the volume seeds from it, and every publish from this
# container - which runs as node - dies on EACCES. That failure is caught and
# logged rather than fatal, so what it produces is a guard enforcing whatever list
# it last managed to read (on a volume this new, none at all) for as long as nobody
# reads the logs. Created in the guard's image too, since a fresh volume seeds from
# whichever container mounts it first.
RUN mkdir -p /edge-intel && chown -R node:node /edge-intel

# Run as the unprivileged `node` user shipped with the base image. Everything
# under /app arrived owned by it (`COPY --chown` above) rather than being walked
# afterwards: `chown -R` rewrites the metadata of every file it touches, which
# copies the whole tree up into a second layer and ships two of everything. The
# vision image failed to pull on overlayfs over exactly that duplicate.
USER node

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
