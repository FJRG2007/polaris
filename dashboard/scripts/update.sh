#!/bin/sh
# Polaris dashboard updater. Updating is the same as installing: pull the latest
# source, then run the installer in place, which reconciles new .env settings,
# rebuilds the image from source, and restarts (the entrypoint applies pending
# migrations). One source of truth, nothing for the user to manage.
#
# Full edition note: when the privileged daemon is running, an update can also be
# driven in-band with `POST /v1/update` on polaris-hostd. Either path must verify
# the image digest/provenance before deploying rather than trusting a moving tag.
set -eu

# This script lives in dashboard/scripts/; the dashboard dir is its parent.
dash_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if git -C "$dash_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'polaris: %s\n' "updating checkout"
    git -C "$dash_dir" pull --ff-only
fi

cd "$dash_dir"
exec sh scripts/install.sh "$@"
