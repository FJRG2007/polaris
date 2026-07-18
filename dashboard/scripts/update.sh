#!/bin/sh
# Polaris dashboard updater. Pulls the newest published images (or rebuilds from
# an updated checkout), reconciles the running stack, and prunes what it
# replaced. Safe to run repeatedly.
#
# Full edition note: when the privileged daemon is running, an update can also
# be driven in-band with `POST /v1/update` on polaris-hostd, which performs the
# same pull + redeploy from inside the trust boundary (no shell access needed).
#
# Security requirement: image updates MUST verify digest and provenance before
# they are deployed. Pin `POLARIS_IMAGE_TAG` to a released version and confirm
# the pulled digest against the signed release attestation (cosign / GitHub
# attestations) rather than blindly trusting a moving `latest` tag. The daemon's
# update path enforces this; when updating by hand, verify before `up -d`.
set -eu

log() { printf 'polaris: %s\n' "$1"; }

if ! docker compose version >/dev/null 2>&1; then
    printf 'polaris: %s\n' "'docker compose' (v2) is required" >&2
    exit 1
fi

# Run from the compose directory whether invoked from the repo root or docker/.
if [ -f "docker/docker-compose.yml" ]; then
    cd docker
elif [ ! -f "docker-compose.yml" ]; then
    printf 'polaris: %s\n' "run this from the Polaris checkout (docker-compose.yml not found)" >&2
    exit 1
fi

# If this is a git checkout, fast-forward it so a local-build fallback and the
# compose file itself stay current. Published-image installs skip straight to
# the pull below.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "updating checkout"
    git pull --ff-only
fi

log "pulling newest images"
docker compose pull

log "redeploying"
docker compose up -d

log "pruning replaced images"
docker image prune -f

log "update complete"
