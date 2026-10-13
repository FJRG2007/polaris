# A stalled camera stream stayed stalled, and every tile kept asking it for a frame

**Found:** October 2026. **Fixed in:** `dashboard/apps/places/src/lib/relay.ts`,
`dashboard/apps/places/src/lib/warm.ts`,
`dashboard/services/camera-relay/entrypoint.sh`.
**Guarded by:** `apps/web/test/home/camera-relay-stall.test.ts`,
`apps/web/test/home/camera-frame-gate.test.ts`.

## What was seen

A camera that had been working for days would stop delivering a picture
without anything else about it changing: the relay still listed its stream
as connected, Polaris still called it reachable, and a viewer opening the
camera just sat on the last still forever. Nothing in the stream record said
why, and the camera kept working if the whole relay happened to restart for
an unrelated reason - which made it look, each time, like a one-off that had
already gone away on its own.

## What it actually was

A camera's connection to the relay can stop delivering frames without ever
closing the socket: the producer stays listed in `GET /api/streams`, its
reported byte count simply stops moving, and every request for a frame or a
stream from it waits forever for a keyframe that is never coming. Replacing
or deleting the relay's record of that stream does not close the underlying
connection - the relay only forgets the name - and most cameras cap how many
sessions they will hold open at once, so the still-open stalled one is what
then made the camera refuse the _next_ connection too.

On top of that, nothing paced how often a frame was asked for. Every tile
and wall refresh fired its own request at `/api/frame.jpeg`, and the relay
holds each one open until a keyframe arrives or the caller gives up - so
against a stalled stream, every refresh added one more waiting request
rather than replacing the one already out, and dozens of them piled up on
the relay for a camera that was never going to answer any of them.

## The fix

The relay's streams are now compared across two passes of the warm sweep
(`streamTraffic`, `stalledStreams`): a stream that is connected, has
somebody waiting on it, and whose byte count has not moved between the two
looks is stalled. A relay with a stalled stream is restarted outright
(`restartRelay`, through the relay's own `/api/restart`, newly allowed in
`entrypoint.sh`) rather than having its stream record touched, because a
restart is what actually closes the dead connection and reopens every camera
from the relay's file - and restarts back off (`relayRestartCooldownMs`)
the longer a relay keeps stalling instead of fixing it, since restarting
drops every other camera on that relay too.

Frame requests are now deduplicated and paced per stream (`askFrame`,
`FRAME_PAUSE_MS`): one request out to a given stream at a time, shared by
every caller waiting on it, and once one of those times out the stream is
left alone for twenty seconds before it is asked again.

## What stops it coming back

`camera-relay-stall.test.ts` asserts a stream is only called stalled once
its byte count has failed to move across two looks, that a restart is not
due again before its cooldown, and that the cooldown backs off on a relay
that keeps stalling through its restarts. `camera-frame-gate.test.ts`
asserts a stalled stream never has more than one frame request in flight at
once and is left alone for a while after one of those times out.

## The general rule

A connection that "is listed" is not the same claim as "is delivering."
Where a protocol lets a producer stay registered while sending nothing, the
only reliable signal is whether its own counters are still moving, and the
only reliable recovery is whatever actually tears the connection down -
which, for a relay that does not expose closing one connection on its own, is
restarting the whole thing. And fan-out that is paced by how many tiles are
on screen rather than by how many requests the far end can usefully hold at
once will pile those requests up the moment the far end stops answering any
of them.
