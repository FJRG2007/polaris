#!/bin/sh
# Exercises the two update.sh code paths that only run against a live Docker
# engine: the dashboard rollover's compose-hash comparison, and the
# absent-service retry. Docker cannot be started on this development machine,
# so this fakes `docker` and the compose command as shell functions and pulls
# the real function bodies out of update.sh with sed, so the test runs the
# current source verbatim rather than a reimplementation of it.
#
# Run with: sh dashboard/scripts/test/update.test.sh
set -eu

self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
update_sh="$self_dir/../update.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok - %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'not ok - %s\n' "$1"; }

log() { :; }
err() { :; }

extract() {
    sed -n "/^$1() {/,/^}/p" "$update_sh"
}

eval "$(extract compose_hash)"
eval "$(extract container_hash)"
eval "$(extract container_image)"
eval "$(extract container_ref)"
eval "$(extract image_id)"
eval "$(extract container_ready)"
eval "$(extract wait_ready)"
eval "$(extract edge_labels)"
eval "$(extract retire)"
eval "$(extract roll_dashboard)"
eval "$(extract roll_service)"

for fn in compose_hash container_hash container_image container_ref image_id container_ready wait_ready edge_labels retire roll_dashboard roll_service; do
    if ! command -v "$fn" >/dev/null 2>&1; then
        printf 'setup failed: %s was not extracted from %s\n' "$fn" "$update_sh" >&2
        exit 2
    fi
done

READY_TIMEOUT=3
compose=compose

# --- fakes -------------------------------------------------------------
# Controlled per test via the globals below; every docker/compose call the
# code under test makes is answered from here, nothing hits a real engine.
scaled=0
started=""
retired=""
IMG_OLD=img-a
IMG_TARGET=img-a
HASH_OLD=hash-a
HASH_WANT=hash-a

compose() {
    case "$1 ${2:-}" in
        "ps -q")
            if [ "$scaled" = "1" ]; then
                printf 'old1\nnew1\n'
            else
                printf 'old1\n'
            fi
            ;;
        "config --hash")
            printf 'web %s\n' "$HASH_WANT"
            ;;
        "up -d")
            started="$started $*"
            case "$*" in
                *--scale*) scaled=1 ;;
            esac
            ;;
    esac
}

docker() {
    case "$1 ${2:-}" in
        "inspect --format")
            fmt="$3"
            id="$4"
            case "$fmt" in
                *.Image*)
                    case "$id" in
                        old1) printf '%s' "$IMG_OLD" ;;
                        new1) printf '%s' "$IMG_TARGET" ;;
                    esac
                    ;;
                *config-hash*)
                    case "$id" in
                        old1) printf '%s' "$HASH_OLD" ;;
                        new1) printf '%s' "$HASH_WANT" ;;
                    esac
                    ;;
                *State.Status*) printf 'running' ;;
                *State.Health*) printf 'healthy' ;;
                *range*) printf 'traefik.enable=true\n' ;;
            esac
            ;;
        "image inspect")
            printf '%s' "$IMG_TARGET"
            ;;
        "stop -t")
            retired="$retired ${4:-}"
            ;;
        "rm -f") : ;;
        "logs --tail") : ;;
    esac
}

reset_fakes() {
    scaled=0
    started=""
    retired=""
    IMG_OLD=img-a
    IMG_TARGET=img-a
    HASH_OLD=hash-a
    HASH_WANT=hash-a
}

# --- roll_dashboard: unchanged image, unchanged compose definition ---------
# Both the image and the definition compose would create the service from
# agree with what the running container has, so nothing should be started.
reset_fakes
roll_dashboard "repo/web:tag" >/dev/null
if [ -z "$started" ]; then
    ok "roll_dashboard: matching image and hash starts nothing"
else
    bad "roll_dashboard: matching image and hash started:$started"
fi

# --- roll_dashboard: unchanged image, DIFFERENT compose definition ---------
# This is the call-server fault: the image is byte-identical but the release
# changed the service's wiring (e.g. added a volume mount), so the container
# has to be recreated even though the image comparison alone would say no.
reset_fakes
HASH_WANT=hash-b
roll_dashboard "repo/web:tag" >/dev/null
case "$started" in
    *--scale*) ok "roll_dashboard: changed compose hash triggers a rollover despite an unchanged image" ;;
    *) bad "roll_dashboard: changed compose hash did not start a new container (started:$started)" ;;
esac
case "$retired" in
    *old1*) ok "roll_dashboard: the stale-wiring container is retired once the new one is healthy" ;;
    *) bad "roll_dashboard: old container was not retired (retired:$retired)" ;;
esac

# --- roll_dashboard: compose too old to report a hash ----------------------
# An empty answer from compose_hash cannot prove the wiring is unchanged, so
# the "nothing to roll over" skip must not fire - the rollover goes ahead,
# which the code's own comment calls the harmless direction to be wrong in.
reset_fakes
HASH_WANT=""
HASH_OLD=""
roll_dashboard "repo/web:tag" >/dev/null
case "$started" in
    *--scale*) ok "roll_dashboard: an unreadable compose-hash does not short-circuit the rollover" ;;
    *) bad "roll_dashboard: an unreadable compose-hash started:$started" ;;
esac

# --- absent-service retry ---------------------------------------------------
# The retry block lives inline in main() rather than in its own function, so
# it is pulled out by line range and run against a fake compose whose `ps -aq`
# reports one of two services as never having gotten a container - exactly
# the call-server fault, where a batch `compose up` silently skips a service
# this release adds.
retry_block=$(sed -n '/^        absent=""$/,/^        fi$/p' "$update_sh")
if [ -z "$retry_block" ]; then
    printf 'setup failed: could not extract the absent-service retry block from %s\n' "$update_sh" >&2
    exit 2
fi

others="web callserver"
build_flag=""
retry_started=""
retry_absent=""
compose() {
    case "$1 ${2:-}" in
        "ps -aq")
            [ "${3:-}" = "callserver" ] && return 0
            printf 'existing-id\n'
            ;;
        "up -d")
            retry_started="$retry_started ${*}"
            ;;
    esac
}
err() { retry_absent="$retry_absent|$1"; }

eval "$retry_block"

case "$retry_started" in
    *callserver*) ok "absent-service retry: a service with no container is retried on its own" ;;
    *) bad "absent-service retry: callserver was not retried (started:$retry_started)" ;;
esac
case "$retry_started" in
    *"web "*|*" web"*)
        bad "absent-service retry: a service that already has a container was retried too (started:$retry_started)" ;;
    *) ok "absent-service retry: a service that already has a container is left alone" ;;
esac
case "$retry_absent" in
    *"no container for: callserver"*|*"no container for:"*callserver*) ok "absent-service retry: the missing service is named in the log" ;;
    *) bad "absent-service retry: missing service was not named (logged:$retry_absent)" ;;
esac

# --- roll_service -----------------------------------------------------------
# What decides whether a supporting service is recreated. The service this is
# really about is the call server: it is host-networked and carries every call in
# the deployment, so recreating that container drops all of them mid-sentence.
# Doing it because some other service moved - or because a stale local image made
# it look necessary - is a cost nobody agreed to pay.
#
# The fakes below are their own, because the ones above answer `*.Image*` for any
# inspect format and that pattern also matches `.Config.Image`, which is the
# reference rather than the digest. Here the two are told apart, which is the
# whole mechanism being tested.
svc_started=""
SVC_CONTAINER=live1
SVC_WANT_HASH=hash-a
SVC_HAVE_HASH=hash-a
SVC_REF="livekit/livekit-server:v1.13"
SVC_RUNNING=sha-a
SVC_RESOLVES=sha-a

compose() {
    case "$1 ${2:-}" in
        "ps -q") [ -n "$SVC_CONTAINER" ] && printf '%s\n' "$SVC_CONTAINER" ;;
        "config --hash") printf '%s %s\n' "${3:-}" "$SVC_WANT_HASH" ;;
        "up -d") svc_started="$svc_started $*" ;;
    esac
}

docker() {
    case "$1 ${2:-}" in
        "inspect --format")
            case "$3" in
                *Config.Image*) printf '%s' "$SVC_REF" ;;
                *config-hash*) printf '%s' "$SVC_HAVE_HASH" ;;
                *.Image*) printf '%s' "$SVC_RUNNING" ;;
            esac
            ;;
        "image inspect") printf '%s' "$SVC_RESOLVES" ;;
    esac
}

reset_service() {
    svc_started=""
    SVC_CONTAINER=live1
    SVC_WANT_HASH=hash-a
    SVC_HAVE_HASH=hash-a
    SVC_REF="livekit/livekit-server:v1.13"
    SVC_RUNNING=sha-a
    SVC_RESOLVES=sha-a
}

build_flag=""

# An update that changed nothing about this service must not touch it. This is
# the case that matters most: every call in the deployment is riding on that
# container staying up.
reset_service
roll_service livekit >/dev/null
if [ -z "$svc_started" ]; then
    ok "roll_service: an unchanged service is left running"
else
    bad "roll_service: an unchanged service was recreated (started:$svc_started)"
fi

# A patch upstream. `v1.13` is a moving tag - that is how patches are meant to
# arrive - so the same name now resolves to a different image and the service has
# to be recreated to pick it up.
reset_service
SVC_RESOLVES=sha-b
roll_service livekit >/dev/null
case "$svc_started" in
    *livekit*) ok "roll_service: a genuinely newer image is picked up" ;;
    *) bad "roll_service: a moved tag did not recreate the service (started:$svc_started)" ;;
esac

# The release changed the service's wiring. The image can be byte-identical and
# the container still has to be recreated - this is the fault that shipped the
# call server with no key, because nothing recreated it to mount the volume the
# release had added.
reset_service
SVC_WANT_HASH=hash-b
roll_service livekit >/dev/null
case "$svc_started" in
    *livekit*) ok "roll_service: changed wiring recreates it despite an identical image" ;;
    *) bad "roll_service: changed wiring did not recreate the service (started:$svc_started)" ;;
esac

# A service this release adds, which has no container to compare against.
reset_service
SVC_CONTAINER=""
roll_service livekit >/dev/null
case "$svc_started" in
    *livekit*) ok "roll_service: a service with no container is started" ;;
    *) bad "roll_service: a service with no container was not started (started:$svc_started)" ;;
esac

# Compose too old to report a hash. It cannot prove the wiring is unchanged, so
# the skip must not fire - the same harmless direction the rollover takes.
reset_service
SVC_WANT_HASH=""
SVC_HAVE_HASH=""
roll_service livekit >/dev/null
case "$svc_started" in
    *livekit*) ok "roll_service: an unreadable hash does not short-circuit the update" ;;
    *) bad "roll_service: an unreadable hash skipped the service (started:$svc_started)" ;;
esac

# An image the engine cannot resolve is no evidence that anything changed, and
# restarting on no evidence is exactly what this exists to stop.
reset_service
SVC_RESOLVES=""
roll_service livekit >/dev/null
if [ -z "$svc_started" ]; then
    ok "roll_service: an unresolvable image leaves the container running"
else
    bad "roll_service: an unresolvable image recreated the service (started:$svc_started)"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
