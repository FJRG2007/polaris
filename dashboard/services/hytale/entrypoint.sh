#!/bin/sh
# Start the Hytale server, or say exactly what is missing.
#
# The two files this needs are the operator's own - see the Dockerfile for why
# Polaris cannot fetch them - so the interesting path here is the one where they
# are not there yet. A container that exits with a stack trace tells the screen
# nothing; one that says which file is missing, where to put it, and then waits
# is a server somebody can finish setting up from the dashboard.
#
# It waits rather than exits for a second reason: a container that dies is
# restarted, and a restart loop is what Polaris reports as a broken server. This
# one is not broken, it is unfinished, and the difference is the whole message.
set -eu

JAR=${HYTALE_JAR:-/data/HytaleServer.jar}
ASSETS=${HYTALE_ASSETS:-/data/Assets.zip}
PORT=${HYTALE_PORT:-5520}
MEMORY=${HYTALE_MEMORY:-3G}

missing=""
[ -f "$JAR" ] || missing="HytaleServer.jar"
if [ ! -f "$ASSETS" ]; then
    [ -z "$missing" ] && missing="Assets.zip" || missing="$missing and Assets.zip"
fi

if [ -n "$missing" ]; then
    echo "polaris: waiting for $missing"
    echo "polaris: put the Hytale server files in this server's Files, in the top folder."
    echo "polaris: they come from your own Hytale account - the launcher's installation, or the official downloader."
    # Checked rather than slept through: the moment both arrive the server starts,
    # with nobody having to restart anything.
    while [ ! -f "$JAR" ] || [ ! -f "$ASSETS" ]; do
        sleep 5
    done
    echo "polaris: both files are here, starting the server"
fi

# `--bind` on every address inside the container: the only way in is the port the
# deployment publishes, and binding to a name the container resolves for itself
# is how a server ends up reachable from nowhere.
exec java "-Xmx${MEMORY}" -jar "$JAR" --assets "$ASSETS" --bind "0.0.0.0:${PORT}" "$@"
