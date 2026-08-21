# The Polaris vision worker.
#
# Node for the logic, ffmpeg for the decoding, and one detection model. Build
# context is the dashboard root, like the other services, so the workspace is
# available to the builder.
FROM node:22-bookworm-slim AS builder
WORKDIR /build

# Manifests first so the install layer is cached until dependencies change. The
# whole workspace's, not just this service's: `npm ci` resolves the lockfile
# against every member it names, and a member whose manifest is absent is a
# member whose dependencies never arrive - which surfaces much later, as
# @polaris/core failing to build for want of one of its own imports.
COPY package.json package-lock.json ./
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
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
COPY services/vision/package.json ./services/vision/
RUN npm ci --ignore-scripts

COPY . .
# @polaris/core first: the worker bundles the zone geometry, the detector's
# decoder and the tracker out of its dist.
RUN npm run build -w @polaris/core && npm run build -w @polaris/vision

# The model, fetched once at build time and checked.
#
# Baked in rather than downloaded on first use, for the same reason the
# recognizer's weights are: a worker that fetches twenty megabytes the first
# time somebody walks past a camera is a worker that misses that person, and one
# on a house network with no way out never works at all.
#
# YOLOX tiny, from the project's own release. Apache-2.0, like Polaris. The
# checksum is what makes this reproducible: a file that is not the one this
# worker's decoder was written against fails the build here rather than
# reporting boxes in the wrong part of the picture.
FROM debian:bookworm-slim AS model
ARG MODEL_URL=https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx
ARG MODEL_SHA256=427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /detector.onnx "$MODEL_URL" && \
    echo "$MODEL_SHA256  /detector.onnx" | sha256sum -c -

# The one dependency the worker cannot bundle: a native addon, installed from
# the workspace's own lockfile so two builds of this commit ship the same code
# down to the last transitive package. Scripts are off for the install and run
# only for this package, which is what fetches its .node binaries.
FROM node:22-bookworm-slim AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
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
COPY services/vision/package.json ./services/vision/
RUN npm ci --omit=dev --workspace @polaris/vision --include-workspace-root=false --ignore-scripts && \
    npm rebuild onnxruntime-node && \
    rm -rf node_modules/@polaris && \
    npm cache clean --force

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg is what decodes video here, and ffprobe - from the same package - is
# what says how big a camera's picture is, which every box the detector reports
# is divided by.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Everything the worker uses beyond that addon, including the pure Polaris logic
# it shares with the dashboard, is in the one built file.
COPY services/vision/package.json ./package.json
COPY --from=deps /deps/node_modules ./node_modules

COPY --from=builder /build/services/vision/dist/index.js ./index.js
COPY --from=model /detector.onnx ./model/detector.onnx
RUN chown -R node:node /app

# Nothing here needs root, and it spawns processes on somebody's home network.
USER node
CMD ["node", "index.js"]
