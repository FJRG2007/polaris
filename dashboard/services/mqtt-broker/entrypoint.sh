#!/bin/sh
# Writes the broker's configuration and its one account from the environment,
# then runs Mosquitto. Refuses to start without a password rather than coming up
# open on somebody's network.
set -eu

if [ -z "${BROKER_PASSWORD:-}" ]; then
    echo "mqtt-broker: BROKER_PASSWORD is not set; refusing to start an open broker" >&2
    exit 1
fi
user="${BROKER_USERNAME:-polaris}"

mkdir -p /mosquitto/config /mosquitto/data
passwords=/mosquitto/config/polaris.passwd
rm -f "$passwords"
touch "$passwords"
chmod 0700 "$passwords"
mosquitto_passwd -b "$passwords" "$user" "$BROKER_PASSWORD"
chown mosquitto:mosquitto "$passwords" /mosquitto/data 2>/dev/null || true

cat > /mosquitto/config/polaris.conf <<CONF
listener 1883
allow_anonymous false
password_file $passwords
persistence true
persistence_location /mosquitto/data/
log_dest stdout
CONF

exec "$@"
