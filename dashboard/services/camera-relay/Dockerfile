# The camera relay: go2rtc with its API closed.
#
# go2rtc is the part of Home that holds one connection per camera and re-serves
# it to everybody watching without re-encoding anything. What it does not do is
# arrive with credentials on its API, and that API can add a stream that reads a
# file off the machine - so an open one on a home network is not something to
# ship. Its configuration comes only from a file, and Polaris cannot write a file
# into a volume on a machine it deploys to, so the entrypoint here writes that
# file from the environment Polaris already sets at install time.
#
# Pinned rather than tracking latest: this is a media server on somebody's own
# network, and an image that moves under a running house is how a camera stops
# working on a Tuesday for no reason anybody can trace.
FROM alexxit/go2rtc:1.9.14

COPY services/camera-relay/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# tini stays in front, as in the base image, so a stopped container actually
# stops rather than waiting out a timeout.
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["go2rtc", "-config", "/config/go2rtc.yaml"]
