# The Polaris vision worker.
#
# Node for the logic and ffmpeg for the decoding, which is the whole runtime: the
# worker has no npm dependencies, so the image is the two binaries and one
# bundled file. Build context is the dashboard root, like the other services, so
# the workspace is available to the builder.
FROM node:22-bookworm-slim AS builder
WORKDIR /build

COPY package.json package-lock.json ./
COPY services/vision/package.json ./services/vision/
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build -w @polaris/vision

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg is what actually decodes video here. Nothing else is needed: the worker
# compares raw grayscale frames itself and speaks HTTP for the rest.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/services/vision/dist/index.js ./index.js
RUN echo '{"type":"module"}' > package.json && chown -R node:node /app

# Nothing here needs root, and it spawns processes on somebody's home network.
USER node
CMD ["node", "index.js"]
