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
attempts=30
i=1
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
            echo "polaris: the database has a change that did not finish." >&2
            if [ -n "$failed" ]; then
                echo "polaris: it is \"$failed\", and it is holding up every later one." >&2
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

# --- Refuse to serve a database that is not the one this build expects ------
# "Was every migration applied" is not the same question as "does this database
# have the columns this code reads". A restore from an older dump, a table
# somebody edited by hand, and a half-applied change that was marked resolved
# all pass the loop above and then fail one screen at a time, hours later, as
# columns that are not there - which is the worst way to find out.
#
# Exit 2 is the two being different. Exit 1 is the check itself failing, which
# is evidence of nothing: an instance does not get held down because Polaris
# could not ask the question.
drift=0
prisma migrate diff \
    --from-url "$POLARIS_DATABASE_URL" \
    --to-schema-datamodel "$SCHEMA" \
    --exit-code >/dev/null 2>&1 || drift=$?
if [ "$drift" -eq 2 ]; then
    echo "polaris: the database does not match this version of Polaris." >&2
    echo "polaris: starting anyway would mean reading columns that are not there," >&2
    echo "polaris: so it is stopping instead. Restore the database from its last" >&2
    echo "polaris: backup and update again." >&2
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
