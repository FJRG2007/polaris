# polaris-mdns

An mDNS/zeroconf responder that advertises **polaris.local** on the local
network, the same way Home Assistant publishes `homeassistant.local`.

It answers multicast A queries for `polaris.local` with the host's LAN IP and
advertises an `_http._tcp` service so Polaris appears in network discovery. It
runs as the `mdns` compose service with `network_mode: host`, because multicast
does not cross a bridged Docker network. This works on Linux hosts (and WSL);
Docker Desktop on macOS/Windows restricts host networking, so there `polaris.local`
falls back to the hosts-file entry the installer adds on the local machine.

Configure the advertised name with `POLARIS_MDNS_HOSTNAME` (default `polaris`)
and the port with `POLARIS_MDNS_PORT` (default `80`, where Caddy listens).
