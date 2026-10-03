# A NeoForge metadata change crash-looped every server left on "latest"

**Found:** October 2026. **Fixed in:** `apps/game-servers/src/lib/minecraft/loader-pin.ts`,
`apps/game-servers/src/lib/minecraft/loader-pin-service.ts`,
`apps/game-servers/src/lib/crash-loop.ts`, `apps/game-servers/src/lib/games-health.ts`,
`apps/game-servers/src/lib/games-reset.ts`, `apps/game-servers/src/screens/installed/minecraft-actions.ts`,
`apps/game-servers/src/screens/installed/minecraft-loader.tsx`,
`apps/web/src/lib/deploy/desired-state.ts`, `apps/web/src/lib/app-extensions/registry.ts`,
`apps/web/src/lib/deploy/portless.ts`, `apps/web/src/lib/deploy-service.ts`.
**Guarded by:** `apps/web/test/apps/crash-loop-loader.test.ts`,
`apps/web/test/apps/game-crash-loop-resume.test.ts`,
`apps/web/test/apps/minecraft-loader-pin.test.ts`,
`apps/web/test/apps/minecraft-loader-pin-sweep.test.ts`,
`apps/web/test/apps/minecraft-loader-card.test.tsx`,
`apps/web/test/deploy/desired-state-adopt.test.ts`,
`apps/web/test/deploy/portless-forwarder.test.ts`.

## What was seen

Every NeoForge server left on the default "latest" loader crash-looped on its
next start. The server's files were untouched and the loader it had been
running for weeks was still sitting on disk - nothing about the server itself
had changed. The same server, restored from the same disk by hand outside
Polaris, ran. Forge, Fabric and Quilt servers left on "latest" were exposed to
the same failure, just not yet hit by it.

Once the guard stopped a looping server, its page kept saying "Stopped" even
after somebody repaired it and started it again from outside Polaris - and on
some of those, twenty minutes later, the server was stopped again by itself,
healthy and with a player on.

## What it actually was

On 2026-10-03 NeoForge's repository started answering `maven-metadata.xml`
with a `modelVersion` attribute that the server image's helper
(`itzg/mc-image-helper`) could not parse. Left on "latest", the image asks that
repository which version "latest" is on *every single start* - even when the
answer is the version already on disk - so the helper's `install-neoforge` step
failed before Java ever ran, on every server that had not pinned an exact
version by hand.

That surfaced two bugs that had been waiting for exactly this kind of outage:

- The crash-loop guard stops a looping server through the same switch an
  operator's own stop uses, so the service was then recorded as "stopped" with
  nothing to tell the two apart. A server repaired and brought back up outside
  Polaris stayed marked "stopped" forever - and the pass that force-stops
  services recorded as stopped (`runDesiredStatePass`) took that record at face
  value and stopped the repaired, running server again.
- A Minecraft server on private networking carries a port-80-to-game-port
  `socat` forwarder meant for HTTP services. It shares the service's network
  namespace, so it was restarting with every restart of the service - every
  few seconds beside a server stuck in this crash loop - for a port nobody was
  ever going to call on a game server in the first place.

## The fix

- **Loader pin** (`loader-pin.ts`, `loader-pin-service.ts`): a NeoForge, Forge,
  Fabric or Quilt server whose loader version is empty or "latest" is held at
  the version its own manifest records (`/data/.<loader>-manifest.json`), so a
  restart resolves nothing over the network. The health job pins existing
  servers once they finish installing; a version somebody set by hand is left
  alone; changing the release or the software lets the held version go so the
  new one resolves its own. Settings shows the held version with an "Update
  loader" action that unpins once and restarts.
- **Detection** (`crash-loop.ts`): an `mc-image-helper install-*` failure is
  named on the crash banner and convicts on the first sighting instead of
  waiting for a second minute of restarts, and the guard pins the installed
  version as it stops the server so pressing Start runs it offline. The banner
  also offers "Pin the installed version and start" directly.
- **Taking the stop back** (`games-health.ts`, `app-extensions/registry.ts` +
  `types.ts`): the crash record now says whether the stop was Polaris's own
  (`stoppedByPolaris`). A server that comes back up healthy is set back to
  "running" within one health pass, the moment RCON answers on its own page, or
  when the stopped-service pass finds it running and asks the game-servers
  extension first (`adoptsRunningService`) instead of stopping it again. An
  operator's own stop is never taken back.
- **The stopped-service pass** (`deploy/desired-state.ts`): before stopping a
  container under a service recorded as stopped, it now asks first whether some
  app adopts it as running again, and writes what it does stop into the
  service's history and the audit log with nobody as the actor.
- **The port-80 forwarder** (`deploy/portless.ts`, `deploy-service.ts`): planned
  only for a service whose main port actually speaks HTTP - not one with a
  pinned host port (every game server), not one published on UDP, and not a
  catalogue app that declares its port as TCP or UDP.

## What stops it coming back

`minecraft-loader-pin.test.ts` and `minecraft-loader-pin-sweep.test.ts` assert
the pin is read from each loader's own manifest shape and that the sweep holds
every server still following "latest" without touching one somebody pinned by
hand. `crash-loop-loader.test.ts` asserts a failed `install-*` step is named and
convicted immediately. `game-crash-loop-resume.test.ts` replays the whole
2026-10-03 sequence end to end: stop, repair, and the server taken back as
running rather than stopped a second time. `desired-state-adopt.test.ts` asserts
the stopped-service pass asks an app before stopping a container under a
service it finds recorded as stopped. `portless-forwarder.test.ts` asserts the
forwarder is withheld from a pinned host port, a UDP port, and a catalogue app
declaring TCP or UDP, and kept for everything else.

## The general rule

A server start must never depend on a third party's web server answering, in a
format a tool you do not control can parse, when the information that start
needs is already sitting on the disk it is about to boot from. Where that
information exists - an installed version, a resolved build, a cached
manifest - read it from there and make refreshing it an explicit, deliberate
action instead of something every restart does by itself. And a guard that
stops a service through the same switch an operator uses has to record that
it, not the operator, is why the service is off - otherwise nothing can ever
tell a repaired service from one somebody meant to leave down, and the next
pass that enforces "off" undoes the repair.
