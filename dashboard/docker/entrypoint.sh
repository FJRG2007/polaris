#!/bin/sh
# Polaris dashboard entrypoint: validate required config, apply database
# migrations (retrying until Postgres is reachable), then hand off to the
# Next.js standalone server as PID 1.
set -eu

SCHEMA="/app/packages/db/prisma/schema.prisma"

# --- Fail loudly if required configuration is missing -----------------------
missing=""
for var in POLARIS_DATABASE_URL POLARIS_AUTH_SECRET POLARIS_MASTER_KEY; do
    eval "value=\${$var:-}"
    if [ -z "$value" ]; then
        missing="$missing $var"
    fi
done
if [ -n "$missing" ]; then
    echo "polaris: missing required environment:$missing" >&2
    echo "polaris: set them in your .env (see docker/.env.example)" >&2
    exit 1
fi

# --- Apply migrations, waiting out a not-yet-ready Postgres -----------------
# compose gates start on the Postgres healthcheck, but retry anyway so a slow
# first boot or a restarted database does not crash the container.
#
# Only a database that is not there yet is retried. Everything else - a migration
# that failed, a schema that has drifted - is reported once and stopped on, and
# that distinction is the whole point of the case below: this loop used to treat
# every failure as "not ready", so a broken migration was printed thirty times
# under a line saying the database was still starting, and the actual error
# scrolled past between two of the copies. The reader was told the wrong thing
# thirty times and the right thing never.
#
# The `|| status=$?` is load-bearing. Under `set -e` a bare `out=$(...)` ends the
# script the moment the command inside it fails, so everything below - the
# retry, the case, and all of the explanation written to be read - was
# unreachable. A Postgres two seconds from ready took the whole deployment down
# with Prisma's own error and none of the sentences meant to make sense of it.

# Migrations named from here on are required to be rerunnable - every statement a
# no-op when its object is already there - which is written down in
# packages/db/prisma/migrations/README.md and enforced by
# apps/web/test/updates/migrations-rerunnable.test.ts. That is the whole reason
# one that failed half way through can be cleared and run again below: the second
# run picks up where the first stopped instead of failing on the same statement.
# Anything older than this was written before the rule and is not touched.
RERUNNABLE_FROM=20260930110001

# The migration is Prisma's `<14-digit timestamp>_<name>`; anything that does not
# parse as one is treated as not covered, because guessing wrong here means
# re-running a migration that was never written to survive it.
is_rerunnable() {
    stamp=${1%%_*}
    case "$stamp" in
        ""|*[!0-9]*) return 1 ;;
    esac
    [ "${#stamp}" -eq 14 ] || return 1
    [ "$stamp" -ge "$RERUNNABLE_FROM" ]
}

attempts=30
i=1
cleared=0
while [ "$i" -le "$attempts" ]; do
    status=0
    out=$(prisma migrate deploy --schema "$SCHEMA" 2>&1) || status=$?
    printf '%s\n' "$out"
    if [ "$status" -eq 0 ]; then
        break
    fi
    case "$out" in
        # P1001/P1002: cannot reach the server, or it timed out answering. Those
        # are the two that mean "not yet"; every other Prisma error is about the
        # database's contents and will say the same thing in two seconds' time.
        *P1001*|*P1002*) ;;
        *P3009*)
            # A change that failed half way through on some earlier boot.
            # Postgres kept whatever part of it went in, the history records it
            # as failed, and every later change is refused until somebody says
            # what happened to that one. Nothing about that state clears itself,
            # so a container that kept restarting would repeat it forever.
            #
            # Named, because "found failed migrations" is equally true of a
            # database with one and a database with nine, and the name is the
            # only part of it anybody can act on.
            failed=$(printf '%s\n' "$out" |
                sed -n 's/.*The `\([^`]*\)` migration started at.*/\1/p' |
                head -n 1)
            # A migration written under the rerunnable rule can be finished by
            # running it again, and the only thing standing in the way is the
            # history row saying it failed - which nothing else in Polaris ever
            # clears, and the operator has no terminal to clear it from. So it is
            # cleared here, once per boot: if the second run stops at the same
            # statement the migration was not as rerunnable as the rule requires,
            # and the refusal below is what the reader gets.
            if [ "$cleared" -eq 0 ] && [ -n "$failed" ] && is_rerunnable "$failed"; then
                resolved=0
                prisma migrate resolve --rolled-back "$failed" --schema "$SCHEMA" || resolved=$?
                if [ "$resolved" -eq 0 ]; then
                    echo "polaris: the \"$failed\" change did not finish. It is written to be safe" >&2
                    echo "polaris: to run again, so Polaris is retrying it once." >&2
                    cleared=1
                    continue
                fi
            fi
            echo "polaris: the database has a change that did not finish." >&2
            if [ -n "$failed" ]; then
                echo "polaris: it is \"$failed\", and it is holding up every later one." >&2
            fi
            if [ "$cleared" -eq 1 ]; then
                echo "polaris: it was already retried once on this boot and stopped again." >&2
            fi
            echo "polaris: Polaris will not start against a half-changed database, because" >&2
            echo "polaris: it would read and write columns that may not be there. Restore" >&2
            echo "polaris: the database from its last backup and update again." >&2
            exit 1
            ;;
        *)
            echo "polaris: the database refused these migrations - see the error above." >&2
            echo "polaris: this is not a startup delay, so it is not being retried." >&2
            exit 1
            ;;
    esac
    if [ "$i" -eq "$attempts" ]; then
        echo "polaris: database still unreachable after $attempts attempts" >&2
        exit 1
    fi
    echo "polaris: database not ready (attempt $i/$attempts), retrying in 2s..." >&2
    i=$((i + 1))
    sleep 2
done

# --- Refuse to serve a database that is missing what this build reads -------
# "Was every migration applied" is not the same question as "does this database
# have the columns this code reads". A restore from an older dump, a table
# somebody edited by hand, and a half-applied change that was marked resolved
# all pass the loop above and then fail one screen at a time, hours later, as
# columns that are not there - which is the worst way to find out.
#
# Only what is missing counts, and that is not the same as "the database differs
# from the datamodel". The migrations deliberately create objects the datamodel
# has no syntax for - the partial unique indexes on UserModelKey, the
# VaultOrganization one-owner CHECK - so a correct database differs from it by
# design, on every install in the world. Gating on any difference would refuse
# all of them on the very update that delivered the gate. A plan that only drops
# things is therefore that design showing through; a plan that has to create a
# table or add a column is a database this build cannot read.
#
# The check failing to run is evidence of nothing, so it is not a reason to hold
# an instance down: Polaris only stops when it got an answer.
lacking=""
plan=$(prisma migrate diff \
    --from-schema-datasource "$SCHEMA" \
    --to-schema-datamodel "$SCHEMA" \
    --script 2>/dev/null) || plan=""
if [ -n "$plan" ]; then
    lacking=$(printf '%s\n' "$plan" | grep -iE 'CREATE TABLE|ADD COLUMN' || true)
fi
if [ -n "$lacking" ]; then
    echo "polaris: the database is missing tables or columns this version of Polaris" >&2
    echo "polaris: reads. Starting anyway would fail one screen at a time, so it is" >&2
    echo "polaris: stopping instead. Restore the database from its last backup and" >&2
    echo "polaris: update again." >&2
    echo "polaris: what is missing:" >&2
    printf '%s\n' "$lacking" >&2
    exit 1
fi

# --- Deploy terminal sidecar (best-effort) ----------------------------------
# The interactive-terminal WebSocket server runs alongside the Next server on an
# internal port (the reverse proxy forwards /api/deploy/ws to it). Started in the
# background and non-fatally: if it is not present or exits, the dashboard still
# serves - only live terminals are affected.
if [ -f apps/web/ws-server.bundle.cjs ]; then
    echo "polaris: starting deploy terminal sidecar on :${POLARIS_WS_PORT:-3001}"
    node apps/web/ws-server.bundle.cjs &
fi

# --- Start the server -------------------------------------------------------
# exec so the Node process becomes PID 1 and receives container signals.
echo "polaris: starting dashboard on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec node apps/web/server.js
