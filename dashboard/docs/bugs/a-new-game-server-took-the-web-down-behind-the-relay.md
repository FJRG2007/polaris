# A new game server took the web down behind the relay

## What happened

On a deployment serving through its own relay, creating a game server made the whole
dashboard and every deployed site unreachable for a short while: pages stopped
loading, then came back on their own, with nothing on screen to say why. It happened
more than once, and each time it looked like a coincidence, because the server being
created was not the thing that broke.

## Why

The relay is two WireGuard ends (wireproxy) joined by one link: a container on the
relay server and one at the house. That link carried every port the relay forwards -
the web ports, and also each game server's port, the call media ports and the
tunnels' listen ports - and the relay end published every one of them.

Docker cannot add a published port to a running container. So any change to the set
of ports changed both ends' compose specs, compose recreated both link containers,
and every hostname behind the relay dropped until the two ends had come back up and
dialled each other again. Adding or removing a game server is exactly such a change:
in the case that was traced, the link's containers were recreated about thirty
seconds after the game server's own container was created.

The code read as deliberate - one link carrying "everything the relay carries" - and
nothing tied the outage to the game server, which is why it was reported twice before
it was traced.

## How it was proved

- The container start times on the house showed the link's containers recreated right
  after the new game server, and nothing else in the stack restarted.
- `warmRelay` marks the relay `changed` whenever the forwarded ports differ from the
  stored ones, and `keepUp` then runs `compose up` on both ends with specs whose link
  containers included those ports.
- The new layout was run with throwaway containers on a real Docker host: a port
  carried through the link and frp, frps recreated (and moved to a different address)
  while the link stayed up, and `docker compose up -d` recreating only the changed frp
  service, never the container whose network it shares.

## The fix

The link now carries only what never changes with installs: ports 80 and 443 and
frp's control connection. Every other port rides frp in containers of its own
(`relaySpec` in `apps/web/src/lib/backup-access/relay.ts`):

- On the relay end, frps runs in its own container, publishes the side ports, and is
  reached by name on the project's own network. wireproxy resolves that name on every
  connection, so a recreated frps with a new address is found again.
- At the house, frpc shares the link helper's namespace, where the link's end of the
  control connection listens on loopback.

Adding or removing a game server now recreates only frp. The web does not move; the
side ports blink for the few seconds frpc takes to log in again. `RELAY_SPEC` was
raised to 4, so both ends are recreated once, on the update that brings this in.

## What stops it coming back

`test/backup-access/relay.test.ts` renders both ends for several different port sets
and fails if the link's containers differ between any of them ("adding or removing a
game server leaves the link's containers exactly as they were"). Anything that varies
with what is installed belongs in the frp containers, never in the link's spec.

## What this does not cover

Players and calls that ride the relay still drop for a few seconds when a game server
is added or removed, because frps has to be recreated to publish a new port. Avoiding
that too would need frps on the host network or a fixed published range, neither of
which the relay server's shapes allow today.
