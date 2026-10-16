# An update interrupted deployed services long after zero downtime was declared

**Found:** October 2026, by an operator who had been told since July that an
update no longer took anything down. **Fixed in:** `dashboard/docker/docker-compose.yml`,
`dashboard/scripts/update.sh`, `dashboard/services/edge-guard/src/shutdown.ts`,
`dashboard/apps/web/src/instrumentation.ts`,
`dashboard/apps/web/src/lib/deploy/dashboard-peers.ts`,
`dashboard/apps/web/src/lib/traefik-dynamic.ts`,
`dashboard/apps/web/src/lib/app-bundles/lifecycle.ts`,
`dashboard/apps/web/src/lib/app-bundles/store.ts`.
**Guarded by:** `dashboard/apps/web/test/storage/host-daemon-network.test.ts`,
`dashboard/scripts/test/update.test.sh`,
`dashboard/services/edge-guard/test/shutdown.test.ts`,
`dashboard/apps/web/test/deploy/dashboard-peers.test.ts`,
`dashboard/apps/web/test/deploy/zero-downtime-cutover.test.ts`,
`dashboard/apps/web/test/deploy/dynamic-write.test.ts`,
`dashboard/apps/web/test/app-bundles/bundles.test.ts`.

## Why this page exists

Zero downtime on an update was announced as done four separate times, and each
time it was true of the one path that had been fixed:

| When | What was fixed | What it left open |
|---|---|---|
| July 2026 (`9d36ffd335`) | The dashboard is rolled over: the new container starts beside the old and must pass its healthcheck before the old is retired. | Every other container the update touched. |
| August 2026 (`83159c216d`) | Supporting services are recreated only when their definition or the image their tag resolves to changed, instead of as one batch. | A moving tag that moved still recreated the edge, the database, the call server and the game router. |
| October 2026 (`e8b150d412`, #310) | A redeploy of an app switches the edge only once the new release serves, then drains the old. | Nothing about an update of Polaris itself. |
| October 2026 (`5804cf78b3`, #626) | A share mounted again restarts only the services whose own mount is dead (see `share-mounted-again-restarted-services-that-never-lost-it.md`). | A service whose image has no `cat` or `ls` answers `"unknown"`, and is still restarted. |

None of them was wrong. What was wrong was the claim: each was reported as
"an update causes no downtime" when it meant "this one container causes no
downtime". The rest of the update path was never walked as a whole, so the
remaining causes stayed in place behind a fix that looked complete.

## What was seen

Every update from Settings restarted a deployed service whose volumes live on
a NAS share, and its owner was told the share had reconnected - on every
update, with nothing wrong with the NAS. Less visibly, the same update could
fail requests to every deployed domain while the edge guard was replaced,
restart the call server and the edge when upstream had published a patch, and
mark a deploy that was still running as failed.

## What it actually was

Five independent causes, all on the update path, none covered by the earlier
fixes:

1. **The host daemon's network namespace held the NAS sessions.** The kernel
   keeps an SMB/NFS mount's connection in the network namespace of the process
   that mounted it. The daemon ran on a container network, so recreating it on
   an update took that namespace's interface away: the old session stopped
   answering (the kernel logged it as "has not responded in 180 seconds"), the
   new daemon mounted the share again (`created=true`), and
   `restartAppsOnShare` restarted every service on it. The #626 check could
   not save a service whose image has no shell tools, because its answer was
   `"unknown"`, which is restarted by design. Proven from the kernel log on a
   real host: a fresh "Attempting to mount" at the second the update
   recreated the daemon, then the old session timing out.
2. **The edge guard was recreated in place.** Every router in the deployment
   asks it before forwarding (forwardAuth), so the seconds between the old
   container stopping and the new one listening were failed requests on every
   domain, and requests in flight when it stopped were cut.
3. **A moving tag that moved recreated core services.** The August fix still
   recreated `traefik`, `postgres`, `livekit` and `mc-router` whenever their
   tag resolved to a new image - a database restart, every call dropped, and
   every Minecraft player disconnected for an upstream patch nobody asked for.
4. **The new dashboard ran its boot tasks while the old one was still
   serving.** For the length of the rollover two processes were alive, and the
   new one closed out "abandoned" deploys that were the old one's live work
   (failing them on screen and on GitHub while they went on to finish),
   reconciled NAS mounts and tunnels the old one was also holding, retired
   releases the old one was draining, started the auto-deploy poller, runners,
   certificate renewal and the installed apps' boot work a second time, and
   deleted the previous build of an installed app's code from under the
   process still loading it.
5. **Every boot rewrote the edge's dynamic files.** Both dashboards
   republished identical route files, and each rename made Traefik reload a
   configuration that had not changed.

## How it was proved

Cause 1 from the kernel and dashboard logs of a real host across one update,
lined up to the second with the daemon's recreation. Causes 2 to 5 by reading
the update script and `instrumentation.ts` end to end, as one sequence, for
every container and every task that runs while two dashboards overlap. No
container was exercised on the development machine, which has no Docker; the
update script's decisions are asserted by `update.test.sh`, which runs the real
functions from `update.sh` against fakes.

## The fix

1. `hostd` runs with `network_mode: host`, so the mounts it makes live in the
   host's namespace and survive the daemon being recreated. It reaches nothing
   by container name; it only listens on its unix socket.
2. The edge guard is rolled over like the dashboard (`roll_over` in
   `update.sh`): a second guard starts beside the running one, must pass a
   healthcheck on both of its listeners, and only then is the old one
   retired. On SIGTERM the old guard keeps answering for a few seconds with
   `Connection: close`, then closes its listeners and waits for what is in
   flight, bounded under docker's stop timeout (`shutdown.ts`). A guard that
   never becomes healthy is removed and the old one keeps serving.
3. `traefik`, `postgres`, `livekit` and `mc-router` are recreated only when
   their definition changed. A moved tag is written to the update log as a
   pending patch and goes in with the next release that changes them. Every
   replaced container rejoins the private networks its predecessor was on.
4. `afterPredecessor()` / `whenAlone()` (`dashboard-peers.ts`) ask the engine,
   by the container's compose labels, whether another dashboard is still
   running. Every boot task that acts on its own waits for it to be retired;
   route publishing still runs at once (both write the same file) but leaves
   held releases alone until then. The limited edition has no daemon and is
   never rolled over, so it reads as alone at once.
5. `writeDynamicFile` leaves a file that already holds the same content
   untouched, so only a real change reaches the edge. The health probe's
   repair of an edge that is not serving what its file says forces the write.

## What still has a gap

- A release that changes the definition of `traefik`, `postgres`, `livekit` or
  `mc-router` still recreates that container: a few seconds without the edge,
  the database, calls or the game router. Those are single instances with
  state or host ports that cannot be run twice side by side.
- The first update that carries cause 1's fix still restarts services on a
  NAS share one last time, because the daemon being replaced is the old one
  on its container network. Every update after it does not.

## What stops it coming back

`host-daemon-network.test.ts` fails if `hostd` loses `network_mode: host`.
`update.test.sh` asserts the edge guard is rolled over, retired only once the
new one is healthy, left serving when the new one is not, and that a moved tag
alone does not recreate a core service. `shutdown.test.ts` asserts the drain
order and deadline. `dashboard-peers.test.ts` asserts the wait for the
predecessor; `zero-downtime-cutover.test.ts` asserts a boot route sync beside
it publishes and retires nothing; `bundles.test.ts` asserts an installed app's
previous build is kept until then. `dynamic-write.test.ts` asserts an
unchanged file is not rewritten.

## The general rule

Downtime on an update is a property of the whole update, not of one container
in it. Before saying an update causes none, walk every container the update
can recreate and every task the new process starts while the old one still
runs, and name for each why it cannot interrupt anything. A fix to one of them
is reported as a fix to that one.
