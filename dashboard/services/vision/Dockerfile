# The Polaris vision worker.
#
# Node for the logic, ffmpeg for the decoding, and one detection model. Build
# context is the dashboard root, like the other services, so the workspace is
# available to the builder.
FROM node:22-bookworm-slim AS builder
WORKDIR /build

COPY package.json package-lock.json ./
COPY services/vision/package.json ./services/vision/
RUN npm ci --ignore-scripts

COPY . .
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

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg is what decodes video here, and ffprobe - from the same package - is
# what says how big a camera's picture is, which every box the detector reports
# is divided by.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# The detection runtime is a native addon, so it is installed rather than
# bundled. Everything else the worker uses, including the pure Polaris logic it
# shares with the dashboard, is in the one built file.
COPY services/vision/package.json ./package.json
RUN npm install --omit=dev --no-package-lock && npm cache clean --force

COPY --from=builder /build/services/vision/dist/index.js ./index.js
COPY --from=model /detector.onnx ./model/detector.onnx
RUN chown -R node:node /app

# Nothing here needs root, and it spawns processes on somebody's home network.
USER node
CMD ["node", "index.js"]
