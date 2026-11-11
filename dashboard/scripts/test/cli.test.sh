#!/bin/sh
# Exercises the host CLI (`cli/polaris`) the way an operator meets it: `doctor`
# on a hand-edited .env, `lan-access`, and the installed copy handing over to the
# checkout's. Docker cannot be started on the development machine, so `docker` is
# a stub on PATH that answers with canned logs and records what it was asked.
#
# Run with: sh dashboard/scripts/test/cli.test.sh
set -eu

self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cli="$self_dir/../../cli/polaris"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok - %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'not ok - %s\n' "$1"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
install="$work/install"
mkdir -p "$install/dashboard/docker" "$install/dashboard/cli" "$work/bin"
cp "$cli" "$install/dashboard/cli/polaris"

# A stub docker: `logs` prints a refused sign-in, `ps` finds the web container,
# and `compose ... psql` records the statement and answers with $PSQL_ANSWER.
cat >"$work/bin/docker" <<'STUB'
#!/bin/sh
case "$1" in
    logs) printf '%s\n' "2026-11-11T19:40:51.925Z ERROR [Better Auth]: Invalid origin: https://192.168.1.172" ;;
    ps) echo abc123 ;;
    compose)
        printf '%s\n' "$*" >>"$DOCKER_CALLS"
        echo "${PSQL_ANSWER:-off}" ;;
esac
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"
export DOCKER_CALLS="$work/calls"
export POLARIS_SECRETS_FILE="$work/secrets.env"
export POLARIS_INSTALL_DIR="$install"

write_env() {
    printf 'POSTGRES_PASSWORD=pw\nPOLARIS_DATABASE_URL=postgresql://polaris:pw@postgres:5432/polaris\nPOLARIS_APP_URL=http://polaris.local\nPOLARIS_MASTER_KEY=%s\nPOLARIS_AUTH_SECRET=%s\n' \
        "$1" "$2" >"$install/dashboard/docker/.env"
}

good_key=$(openssl rand -base64 32)
long_secret=$(openssl rand -base64 48)
short_key="abcdefghijklmnopqrstuvwxyz012345"

# A 32-character key typed by hand decodes to 24 bytes.
write_env "$short_key" "short"
out=$(sh "$cli" doctor 2>&1 || true)
case "$out" in *"POLARIS_MASTER_KEY decodes to 24 bytes"*) ok "doctor names a master key of the wrong length" ;; *) bad "doctor missed the 24-byte master key: $out" ;; esac
case "$out" in *"openssl rand -base64 32"*) ok "doctor says how to make a new key" ;; *) bad "doctor gave no way to fix the key" ;; esac
case "$out" in *"POLARIS_AUTH_SECRET is 5 characters"*) ok "doctor warns about a short auth secret" ;; *) bad "doctor missed the short auth secret" ;; esac
case "$out" in *"refused on https://192.168.1.172"*"polaris lan-access on"*) ok "doctor names the refused address and the fix" ;; *) bad "doctor missed the refused sign-in: $out" ;; esac

# The installer's copy of the key wins over a new one.
printf 'POLARIS_MASTER_KEY=%s\n' "$good_key" >"$POLARIS_SECRETS_FILE"
out=$(sh "$cli" doctor 2>&1 || true)
case "$out" in *"The installer kept the original in $POLARIS_SECRETS_FILE"*) ok "doctor points at the kept original" ;; *) bad "doctor did not offer the kept key: $out" ;; esac
case "$out" in *"$good_key"*) bad "doctor printed a secret" ;; *) ok "doctor never prints the key" ;; esac

write_env "$good_key" "$long_secret"
out=$(sh "$cli" doctor 2>&1 || true)
case "$out" in *"MASTER_KEY"*|*"AUTH_SECRET"*) bad "doctor flagged good keys: $out" ;; *) ok "doctor accepts keys the installer would write" ;; esac

# lan-access writes the one setting, and only that.
: >"$DOCKER_CALLS"
out=$(PSQL_ANSWER=on sh "$cli" lan-access on 2>&1)
case "$(cat "$DOCKER_CALLS")" in *"INSERT INTO \"Setting\""*"'auth.lanSignIn', 'on'"*) ok "lan-access on stores the setting" ;; *) bad "lan-access on sent: $(cat "$DOCKER_CALLS")" ;; esac
case "$out" in *"Sign-in by local IP is on."*) ok "lan-access on says it is on" ;; *) bad "lan-access on said: $out" ;; esac
: >"$DOCKER_CALLS"
out=$(PSQL_ANSWER=off sh "$cli" lan-access off 2>&1)
case "$(cat "$DOCKER_CALLS")" in *"DELETE FROM \"Setting\" WHERE key = 'auth.lanSignIn'"*) ok "lan-access off forgets the setting" ;; *) bad "lan-access off sent: $(cat "$DOCKER_CALLS")" ;; esac
case "$out" in *"is off. Sign in on http://polaris.local"*) ok "lan-access off names where to sign in" ;; *) bad "lan-access off said: $out" ;; esac
if sh "$cli" lan-access maybe >/dev/null 2>&1; then bad "lan-access accepted an unknown word"; else ok "lan-access refuses an unknown word"; fi

# An installed copy hands over to the checkout's, so an update's commands arrive.
printf '#!/bin/sh\necho "checkout copy: $*"\n' >"$install/dashboard/cli/polaris"
out=$(sh "$cli" doctor 2>&1)
case "$out" in "checkout copy: doctor") ok "the installed copy runs the checkout's" ;; *) bad "no hand-over: $out" ;; esac

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
