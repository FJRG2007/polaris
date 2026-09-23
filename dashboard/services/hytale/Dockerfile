# The Hytale server, run from the files its owner puts in.
#
# **Polaris cannot fetch the server itself, and that is the vendor's decision
# rather than a gap here.** The files are behind a Hytale account that owns Early
# Access: the official downloader signs in with that account, stores its token,
# and only then hands over `HytaleServer.jar` and `Assets.zip`. Nothing Polaris
# could put in an image would be allowed to do that on somebody else's behalf,
# and shipping the files themselves would be redistributing a game nobody bought
# from us.
#
# So this image is the runtime and nothing else: Java, an entrypoint, and a
# volume the operator drops two files into - which since the container file
# browser is writable is a drag into Files rather than a terminal. It is the same
# bargain FiveM already makes with its key, and the screen says so in as many
# words rather than starting and dying.
#
# Java 25, because that is what the server is built for. `-jre` rather than the
# full kit: nothing here compiles.
FROM eclipse-temurin:25-jre

# Everything the server writes - worlds, its config, and the two files it is run
# from - lives here, so a container replaced by an update keeps all of it.
WORKDIR /data

# `tini` reaps what the JVM leaves behind and passes signals through, so a stop
# from the dashboard is a clean shutdown rather than a kill after ten seconds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY services/hytale/entrypoint.sh /usr/local/bin/hytale-entrypoint
RUN chmod +x /usr/local/bin/hytale-entrypoint

# QUIC over UDP, which is the whole of how a Hytale client reaches a server.
# There is no TCP listener to publish, and a deployment that forwarded TCP would
# be a server nobody can join for a reason nothing reports.
EXPOSE 5520/udp

ENV HYTALE_PORT=5520 \
    HYTALE_MEMORY=3G

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hytale-entrypoint"]
