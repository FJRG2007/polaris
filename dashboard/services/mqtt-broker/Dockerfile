# The broker the locks on this network publish to: Mosquitto with a password.
#
# A Nuki Smart Lock with MQTT connects only to a broker on its own LAN, on port
# 1883, unencrypted (its firmware has no room for TLS), and with a username and
# password typed into the Nuki app. The stock image arrives with no account and
# reads its accounts only from files, and Polaris cannot write a file into a
# volume on a machine it deploys to, so the entrypoint writes both from the
# environment Polaris sets at install time.
#
# Pinned rather than tracking latest: a broker that moves under a running house
# is how a door stops reporting on a Tuesday for no reason anybody can trace.
FROM eclipse-mosquitto:2.0.20

COPY services/mqtt-broker/entrypoint.sh /polaris-entrypoint.sh
RUN chmod +x /polaris-entrypoint.sh

ENTRYPOINT ["/polaris-entrypoint.sh"]
CMD ["/usr/sbin/mosquitto", "-c", "/mosquitto/config/polaris.conf"]
