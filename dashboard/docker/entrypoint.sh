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
attempts=30
i=1
while [ "$i" -le "$attempts" ]; do
    out=$(prisma migrate deploy --schema "$SCHEMA" 2>&1)
    status=$?
    printf '%s
' "$out"
    if [ "$status" -eq 0 ]; then
        break
    fi
    # P1001/P1002: cannot reach the server, or it timed out answering. Those are
    # the two that mean "not yet"; every other Prisma error is about the
    # database's contents and will say the same thing in two seconds' time.
    case "$out" in
        *P1001*|*P1002*) ;;
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
