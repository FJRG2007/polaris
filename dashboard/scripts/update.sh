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

# Emit a completion marker with the exit code as the very last line, so the
# dashboard's live update log can tell success from failure and stop tailing. The
# trap fires on any exit, including a `set -e` abort. This script's stdout is
# captured by the redirect in POLARIS_HOSTD_UPDATE_CMD, so the marker lands in the
# shared log file the dashboard reads.
trap 'echo "POLARIS_UPDATE_EXIT=$?"' EXIT

# This script lives in dashboard/scripts/; the dashboard dir is its parent.
dash_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if git -C "$dash_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'polaris: %s\n' "updating checkout"
    git -C "$dash_dir" pull --ff-only
fi

cd "$dash_dir"
# Run the installer as a child, NOT `exec`. `exec` would replace this shell, so the
# EXIT trap above would never fire and the completion marker would never be written
# - which left the dashboard stuck on "Updating..." when the web container did not
# restart (its only other completion signal). With a child call the trap runs on
# return and stamps POLARIS_UPDATE_EXIT with the installer's exit code (set -e
# propagates a failure to this script, so the trap still reports it).
sh scripts/install.sh "$@"
