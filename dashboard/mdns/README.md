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

## The host's neighbour table

Because it runs with `network_mode: host`, this is also the only Polaris
container that can read `/proc/net/arp` - the host's own view of which hardware
address answers for which IP on the LAN. Neither the web container nor the host
daemon sees that: both sit on Docker bridges, whose own neighbour tables list
only the bridge gateway. So when a storage on the network (an SMB share, a NAS)
needs to be found again after its address changed, the host daemon execs a
read-only `awk` in this container to read it
(`lib/storage-whereabouts/neighbours.ts` in the web app). The same table is how
Places follows a device given by its hardware (MAC) address to the IP it
answers on now (`apps/places/src/lib/integrations/mac-locate.ts`), reached
through `host.hostNetwork.readNeighbourTable()` rather than reading it twice. An
install with no `mdns` container running - the limited edition, or host
networking unavailable - simply has no neighbour table to read, and a storage
is then identified by its SMB answer alone, and a device by MAC only where its
own driver can scan for it.
