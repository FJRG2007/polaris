# One-shot updater image. polaris-hostd's POST /v1/update spawns a short-lived
# container from this image to perform a full, correct update: it runs the repo's
# own install.sh (git pull, reconcile .env, pull images, apply migrations,
# redeploy, verify) against the host Docker Engine, then exits.
#
# At runtime hostd bind-mounts the host repo checkout and the Docker socket into
# the container, so it carries git (to pull), the Docker CLI + compose plugin (to
# redeploy), and openssl (install.sh generates/reconciles secrets with it). It is
# never long-running and holds no state.
FROM alpine:3

RUN apk add --no-cache docker-cli docker-cli-compose git openssl

# The bind-mounted repo is owned by the host user, not root-in-container, which
# would trip git's "dubious ownership" guard and abort the pull. This container
# is ephemeral and only ever runs our own install.sh, so trusting any mounted
# checkout is safe and keeps the update hands-off.
RUN git config --system --add safe.directory '*'
