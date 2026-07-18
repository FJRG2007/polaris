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
attempts=30
i=1
while [ "$i" -le "$attempts" ]; do
    if prisma migrate deploy --schema "$SCHEMA"; then
        break
    fi
    if [ "$i" -eq "$attempts" ]; then
        echo "polaris: database still unreachable after $attempts attempts" >&2
        exit 1
    fi
    echo "polaris: database not ready (attempt $i/$attempts), retrying in 2s..." >&2
    i=$((i + 1))
    sleep 2
done

# --- Start the server -------------------------------------------------------
# exec so the Node process becomes PID 1 and receives container signals.
echo "polaris: starting dashboard on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec node apps/web/server.js
