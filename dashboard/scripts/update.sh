#!/bin/sh
# Polaris dashboard updater.
#
# An update is a PULL by default, not a build. CI publishes every image on push, so
# the usual work here is fetching what it published and moving the deployment onto
# it: a build in the update path takes ten minutes and races CI, and the dashboard
# offers an update only once the image it would pull actually exists (see
# lib/update-service.ts), so there is normally nothing to build.
#
# A deployment can ask for the other kind - Settings > Update with > "Build on this
# host" - and then the checkout is the update: this script advances it and builds
# the image here. That is what a fork, a patched deployment, or a machine that
# cannot reach the registry needs. The choice is a single word on the shared volume
# (see update_source below), because the dashboard cannot pass this script
# arguments and should not be able to.
#
# The dashboard is rolled over with no downtime: the new container starts and has to
# pass its healthcheck while the current one keeps serving, and only then is the old
# one retired. Traefik discovers both by their labels and load-balances across them
# for those few seconds. If the new build never becomes healthy, it is removed and
# the old one stays up - a failed update leaves a serving dashboard, not a broken one.
#
# Everything except the dashboard is converged before the rollover, so nothing
# touches the web service after it is done.
#
# Run by hostd's POST /v1/update (see POLARIS_HOSTD_UPDATE_CMD in install.sh) or by
# hand from a checkout: `sh dashboard/scripts/update.sh`.
set -eu

# --- Live log ---------------------------------------------------------------
# When POLARIS_UPDATE_LOG is set, this script owns that file: it timestamps every
# line and writes them itself, rather than being redirected into it by whoever
# started it. That matters because the caller is a shell inside the hostd container,
# and an update can recreate hostd - which killed the redirect mid-update and left
# the dashboard tailing a log that had stopped growing, with no exit marker, on
# "Updating..." forever. Writing the file from inside the updater container makes the
# log (and the outcome) independent of anything the update itself restarts.
#
# The timestamps are the same RFC 3339 shape docker uses for container logs, so the
# dashboard's log viewer renders both the same way.
if [ -n "${POLARIS_UPDATE_LOG:-}" ] && [ -z "${POLARIS_UPDATE_NESTED:-}" ]; then
    mkdir -p "$(dirname -- "$POLARIS_UPDATE_LOG")" 2>/dev/null || true
    # Truncate: each run starts a clean log, which is what the dashboard's
    # byte-offset tail expects.
    : > "$POLARIS_UPDATE_LOG"
    POLARIS_UPDATE_NESTED=1 sh "$0" "$@" 2>&1 \
        | awk '{ printf("%s %s\n", strftime("%Y-%m-%dT%H:%M:%SZ", systime()), $0); fflush() }' \
        >> "$POLARIS_UPDATE_LOG"
    # The nested run stamps the exit marker the dashboard reads, so this wrapper's
    # own status carries nothing and must not fail the caller.
    exit 0
fi

# This script lives in dashboard/scripts/; the dashboard dir is its parent, and the
# repository root is the dashboard's parent (where .git lives).
dash_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$dash_dir/.." && pwd)

# Reuse the installer's helpers instead of a second copy of them: it is the one
# place that knows how to reconcile .env, keep the durable secrets, and write the
# update command. Sourced with POLARIS_INSTALL_LIB set, which stops it running its
# own main().
POLARIS_INSTALL_LIB=1 . "$dash_dir/scripts/install.sh"

# How long the new dashboard has to become healthy before the update is called off.
# Generous: it applies pending migrations before it starts serving.
READY_TIMEOUT=${POLARIS_UPDATE_TIMEOUT:-300}

# Where the dashboard leaves the kind of update this deployment wants. It shares
# this volume with the container running this script; the dashboard cannot pass an
# argument to a command that runs as root on the host, so it writes one word here
# and only the two words below are ever honoured.
SOURCE_FILE=${POLARIS_UPDATE_SOURCE_FILE:-/run/polaris/update.source}

# image - pull what CI published (the default, and what an unwritten file means).
# build - fast-forward this checkout and build the image on this host.
# POLARIS_UPDATE_SOURCE overrides the file, for a run started by hand.
update_source() {
    chosen=${POLARIS_UPDATE_SOURCE:-}
    if [ -z "$chosen" ] && [ -r "$SOURCE_FILE" ]; then
        chosen=$(head -n1 "$SOURCE_FILE" 2>/dev/null | tr -d '[:space:]')
    fi
    case "$chosen" in
        build) echo build ;;
        *) echo image ;;
    esac
}

# On EXIT: hand the checkout back to whoever owns it, THEN emit a completion marker
# with the exit code as the very last line, so the dashboard's live update log can
# tell success from failure and stop tailing (the trap fires on any exit, including
# a `set -e` abort).
#
# The chown fixes a recurring "update keeps failing" cause: the updater runs as ROOT
# (a container), so the git objects and .env files it writes are root-owned. A later
# NON-root update - a manual `polaris update` or `git pull` by the login user - then
# aborts with "insufficient permission for adding an object to repository database
# .git/objects" and no update can complete. Restoring the tree to its owning user
# after a root run keeps every update path able to write it. Best-effort and only
# when root; a normal user run already owns its files.
on_exit() {
    rc=$?
    if [ "$(id -u)" = "0" ]; then
        owner=$(stat -c '%u:%g' "$repo_root" 2>/dev/null || true)
        [ -n "${owner:-}" ] && chown -R "$owner" "$repo_root" 2>/dev/null || true
    fi
    echo "POLARIS_UPDATE_EXIT=$rc"
}
trap on_exit EXIT

# The image a container is actually running, and the image a tag resolves to now.
# Comparing the two is how "is there anything to deploy" is answered without
# trusting the tag to have moved.
container_image() {
    docker inspect --format '{{.Image}}' "$1" 2>/dev/null || true
}

image_id() {
    docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
}

# Whether a container is serving. A healthcheck is the answer when it has one;
# without one, running is all there is to go on.
container_ready() {
    [ "$(docker inspect --format '{{.State.Status}}' "$1" 2>/dev/null || true)" = "running" ] || return 1
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null || true)
    [ -n "$health" ] || return 0
    [ "$health" = "healthy" ]
}

# Wait for a container to pass its healthcheck. Fails fast if it exits instead -
# a container that has stopped will never become healthy, and waiting out the full
# timeout only delays the rollback.
wait_ready() {
    id="$1"
    waited=0
    while [ "$waited" -lt "$READY_TIMEOUT" ]; do
        if container_ready "$id"; then
            return 0
        fi
        case "$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null || true)" in
            exited | dead)
                return 1
                ;;
        esac
        sleep 3
        waited=$((waited + 3))
    done
    return 1
}

# Move the dashboard onto the pulled image without dropping a request: start the new
# container beside the running one, wait for it to pass its healthcheck, then retire
# the old one. Traefik routes both while they overlap (identical labels, one
# load-balanced service), so requests keep being served throughout.
#
# The new container applies pending migrations on boot, while the old one is still
# serving - which is why migrations have to stay readable by the previous build for
# the few seconds an update overlaps. For that same window both builds run their
# background evaluators; those are database-guarded, so the overlap is idle work
# rather than divergence.
roll_dashboard() {
    image="$1"
    target=$(image_id "$image")
    old=$($compose ps -q web 2>/dev/null | tr '\n' ' ')

    if [ -z "$(printf '%s' "$old" | tr -d ' ')" ]; then
        log "the dashboard is not running; starting it"
        $compose up -d web
        return 0
    fi

    first=$(printf '%s' "$old" | tr ' ' '\n' | head -n1)
    if [ -n "$target" ] && [ "$(container_image "$first")" = "$target" ]; then
        log "the dashboard already runs the published image; nothing to roll over"
        return 0
    fi

    log "starting the new dashboard alongside the running one"
    $compose up -d --no-deps --no-recreate --scale web=2 web

    new=""
    for id in $($compose ps -q web 2>/dev/null); do
        case " $old " in
            *" $id "*) continue ;;
        esac
        new="$id"
    done
    if [ -z "$new" ]; then
        err "could not start a second dashboard container; falling back to an in-place restart"
        $compose up -d --no-deps web
        return 0
    fi

    # Both containers are routed by the edge while they overlap, and the edge drops a
    # router whose definition differs between them ("Router defined multiple times
    # with different configurations") - which would 404 the dashboard for the whole
    # rollover instead of serving it from either container. So when a release changes
    # those labels, the previous container goes first and the gap is the price.
    if [ "$(edge_labels "$first")" != "$(edge_labels "$new")" ]; then
        log "this release changes how the edge routes the dashboard; retiring the previous container first"
        for id in $old; do
            retire "$id"
        done
        old=""
    fi

    log "waiting for it to pass its healthcheck (up to ${READY_TIMEOUT}s)"
    if ! wait_ready "$new"; then
        err "the new dashboard did not become healthy; keeping the current one and rolling back"
        err "logs from the build that failed to start:"
        docker logs --tail 40 "$new" 2>&1 || true
        docker rm -f "$new" >/dev/null 2>&1 || true
        return 1
    fi

    if [ -n "$(printf '%s' "$old" | tr -d ' ')" ]; then
        log "the new dashboard is serving; retiring the previous one"
        for id in $old; do
            retire "$id"
        done
    fi
    return 0
}

# A container's edge-routing labels, as one sorted block to compare against another's.
edge_labels() {
    docker inspect --format '{{range $key, $value := .Config.Labels}}{{$key}}={{$value}}{{"\n"}}{{end}}' "$1" 2>/dev/null \
        | grep '^traefik\.' | sort
}

# Take a container out of service.
#
# Deliberately a plain stop. Disconnecting it from the edge's network first looks
# like the gentler way to drain it, and measurably is not: the edge keeps the
# backend in its pool for about a second after the address goes away, so every
# request it round-robins there in that second fails outright. Stopping it leaves
# it answering until the moment it exits, which the edge learns from the container
# dying - measured over 60 requests through a rollover, one failed against four.
retire() {
    id="$1"
    docker stop -t 20 "$id" >/dev/null 2>&1 || true
    docker rm -f "$id" >/dev/null 2>&1 || true
}

main() {
    need docker "install Docker Engine: https://docs.docker.com/engine/install/"
    compose="$(compose_cmd)"

    source=$(update_source)

    # Keep the deployment's own files current. This is a fast-forward of a checkout
    # that is already here, never a clone, and it is not how the new code arrives on
    # an image update - the compose stack, the settings template and this script all
    # live in the checkout rather than in any image, so a release that changes how
    # the deployment is wired only reaches it through here.
    #
    # Which is why a checkout that cannot be advanced is only reported on an image
    # update and goes on with what CI published, but is fatal on a source build:
    # there, the checkout IS the update, and building an unchanged one would report
    # success having installed nothing.
    if git -C "$dash_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        log "syncing the deployment files"
        before=$(git -C "$dash_dir" rev-parse HEAD 2>/dev/null || true)
        if git -C "$dash_dir" pull --ff-only; then
            after=$(git -C "$dash_dir" rev-parse HEAD 2>/dev/null || true)
            # The pull may have replaced this very script. A shell keeps running the
            # copy it already parsed, so re-exec once (guarded against a loop) to be
            # sure the newest updater does the work.
            if [ "$before" != "$after" ] && [ -z "${POLARIS_UPDATE_REEXEC:-}" ]; then
                log "the updater itself changed; continuing with the new one"
                POLARIS_UPDATE_REEXEC=1
                export POLARIS_UPDATE_REEXEC
                trap - EXIT
                exec sh "$dash_dir/scripts/update.sh" "$@"
            fi
        elif [ "$source" = "build" ]; then
            err "could not fast-forward the checkout, and this deployment builds its own image"
            err "resolve the checkout at $repo_root, or switch Settings back to the published build"
            exit 1
        else
            err "could not fast-forward the checkout; continuing with the published images"
        fi
    elif [ "$source" = "build" ]; then
        err "this deployment builds its own image, but $repo_root is not a git checkout"
        exit 1
    fi

    cd "$dash_dir/docker"

    # New settings introduced by this release are added to .env automatically, with
    # their secrets generated, so an update never asks the operator to edit a file.
    if [ -f ".env" ]; then
        log "reconciling .env with this release's settings"
        seed_store_from_env ".env"
        reconcile_env ".env.example" ".env"
        sync_database_url ".env"
    else
        err "no .env in $(pwd); run the installer first"
        exit 1
    fi

    # Re-derive the edition's generated values, keeping the edition it already has.
    # This is how a deployment picks up a better updater: the update command hostd
    # runs lives in .env, so a release that improves it rewrites it here.
    profiles=$(sed -n 's/^COMPOSE_PROFILES=//p' .env | head -n1)
    case "$profiles" in
        *full*) configure_edition "yes" ".env" ;;
        *) configure_edition "no" ".env" ;;
    esac

    COMPOSE_PROFILES=$(sed -n 's/^COMPOSE_PROFILES=//p' .env | head -n1)
    export COMPOSE_PROFILES

    # Before the edge is brought up below, so a deployment that has been running
    # without a certificate contact address gets one and can finally be issued a
    # certificate. Takes it from the administrator's account; never overwrites one.
    sync_acme_email ".env" || true

    tag=$(sed -n 's/^POLARIS_IMAGE_TAG=//p' .env | head -n1)
    web_image="${WEB_IMAGE_REPO}:${tag:-latest}"

    # The dashboard image is the update, however it is obtained. Either way it is
    # done on its own first and stops the run when it fails - otherwise the rollover
    # would find the image unchanged, correctly report nothing to do, and read as an
    # update that succeeded and changed nothing.
    if [ "$source" = "build" ]; then
        # Stamped with the commit being built, exactly as CI stamps a published
        # image, so the deployment reports the build it is actually running and the
        # update check can place it. Compose tags what it builds with the service's
        # `image:`, so the rollover below finds it under the same name a pull would
        # have left; `never` is what stops the following `up` replacing it with a
        # registry `latest` that may lag this checkout.
        target=$(head_sha)
        [ -n "$target" ] && { POLARIS_BUILD_SHA="$target"; export POLARIS_BUILD_SHA; }
        POLARIS_WEB_PULL_POLICY="never"; export POLARIS_WEB_PULL_POLICY
        log "building the dashboard image from this checkout${target:+ (${target})}"
        if ! $compose build web; then
            err "the dashboard image could not be built; nothing has been changed"
            exit 1
        fi
    else
        log "pulling the published dashboard image"
        if ! docker pull "$web_image"; then
            err "could not fetch ${web_image}; nothing has been changed"
            exit 1
        fi
    fi

    # Everything but the dashboard first, so the rollover is the last thing that
    # happens and nothing recreates the web container behind it. --no-deps keeps
    # `depends_on: web` from pulling the dashboard into this step.
    others=$($compose config --services 2>/dev/null | grep -v '^web$' | tr '\n' ' ')

    # The supporting images, best-effort: one the registry cannot serve right now
    # must not abort an update whose point has already been fetched or built. The
    # dashboard is excluded by name - it has just been dealt with, and on a source
    # build pulling it would fetch the very image the build replaced.
    if [ -n "$(printf '%s' "$others" | tr -d ' ')" ]; then
        log "pulling the supporting images"
        # shellcheck disable=SC2086 # deliberate word splitting: a service list
        $compose pull $others || err "some supporting images could not be pulled; continuing with what is here"

        log "updating the supporting services"
        # shellcheck disable=SC2086 # deliberate word splitting: a service list
        $compose up -d --no-deps $others || err "some supporting services did not come up; the dashboard is updated below"
    else
        err "could not list the stack's services; only the dashboard is being updated"
    fi

    # Postgres only reads POSTGRES_PASSWORD when it first initializes its volume, so
    # keep the role's password in step with .env before the new dashboard tries to
    # connect with it (the classic P1000 auth failure).
    align_db_password

    log "rolling the dashboard over to the new build"
    if ! roll_dashboard "$web_image"; then
        err "the update did not complete; the previous dashboard is still serving"
        exit 1
    fi

    # Reclaim what this update superseded - the previous `:latest` each pull leaves
    # untagged - so many updates cannot creep the disk to full. Conservative and
    # best-effort: tagged images (including deployed apps') are all kept, and
    # cleanup must never fail an otherwise-successful update.
    docker image prune -f >/dev/null 2>&1 || true

    running=$($compose ps -q web 2>/dev/null | head -n1)
    build=$(docker inspect "$running" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
        | sed -n 's/^POLARIS_BUILD_SHA=//p' | head -n1)
    log "update complete${build:+ - now running ${build}}"
}

main "$@"
