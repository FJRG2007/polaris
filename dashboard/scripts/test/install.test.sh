#!/bin/sh
# Exercises the installer helpers that only matter against a live Docker engine,
# which cannot be started on this development machine. `docker` is faked as a
# shell function and the real function bodies are pulled out of install.sh with
# sed, so the test runs the current source verbatim rather than a copy of it.
#
# Run with: sh dashboard/scripts/test/install.test.sh
set -eu

self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_sh="$self_dir/../install.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok - %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'not ok - %s\n' "$1"; }

extract() {
    sed -n "/^$1() {/,/^}/p" "$install_sh"
}

eval "$(extract ensure_networks)"

if ! command -v ensure_networks >/dev/null 2>&1; then
    printf 'setup failed: ensure_networks was not extracted from %s\n' "$install_sh" >&2
    exit 2
fi

# Every docker invocation the code under test makes, recorded rather than run.
created=""
docker() {
    case "$1 $2" in
        "network create") created="$created $3" ;;
    esac
}

# Both networks are declared `external` in the compose file, and compose resolves
# every network of every service it starts BEFORE starting one: whichever is
# missing fails the whole `up`, not just the service that named it. hostd creates
# polaris-proxy as well, and that is not enough - it is started by the same `up`,
# and the limited edition has no hostd at all.
ensure_networks
case "$created" in
    *polaris-proxy*) ok "ensure_networks: creates the shared proxy network" ;;
    *) bad "ensure_networks: polaris-proxy was not created (created:$created)" ;;
esac
case "$created" in
    *polaris-hub*) ok "ensure_networks: creates the web<->hub network" ;;
    *) bad "ensure_networks: polaris-hub was not created (created:$created)" ;;
esac

# A network that already exists makes `docker network create` exit non-zero. The
# installer runs under `set -e`, so a helper that does not swallow that failure
# aborts every re-run and every update.
docker() {
    case "$1 $2" in
        "network create") created="$created $3" ;;
    esac
    return 1
}
created=""
if (set -e; ensure_networks); then
    ok "ensure_networks: an existing network is not an error"
else
    bad "ensure_networks: an existing network aborted the install"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
