# What an update does to work in progress

An installed Polaris updates itself: the Update button, or the schedule in
Admin > Updates. This page is the audit of what that does to somebody in the
middle of something, what was fixed, and what has not been exercised.

## How the dashboard container is replaced

`dashboard/scripts/update.sh` rolls the `web` service over rather than
restarting it in place: it starts a second container next to the running one
(`compose up --scale web=2 --no-recreate`), waits for it, then retires the old
one with `docker stop -t 20` (SIGTERM, then SIGKILL after 20 seconds). The edge
(Traefik) drops a container from its pool when the container dies, not when it
is told to stop, so the old container keeps receiving its share of requests
until it exits.

On SIGTERM, Next.js 15 (`next/dist/server/lib/start-server.js`) calls
`server.close()`, waits for the connections still open, then closes the app
and exits 0. Ordinary requests in flight, server actions included, therefore
finish before the process leaves, as long as they finish within the 20 seconds.

## Findings

| # | Finding | State |
|---|---|---|
| 1 | A live stream (chat, notifications, tasks, mail, a call's room, Polar Code boards, MCP over SSE, deck state, metrics) never ends on its own, so it kept the old container's drain open for the whole 20 seconds. In that window the old container's listener is already closed while the edge still routes to it, so requests sent there failed. | Fixed: `apps/web/src/lib/shutdown.ts`. Each streaming route listens on `untilShutdown(request.signal)`, which also aborts on SIGTERM. The stream closes at once, the browser's EventSource reconnects to the new container, and the old one exits as soon as its ordinary requests finish. |
| 2 | Background work (automations) on the old container. | Already handled: `lib/automations/job.ts` stops claiming new steps on SIGTERM and lets the ones in flight finish. Work is held under database leases (`lib/cron/lease.ts`), so anything a killed process held is taken by the new container once the lease expires. Nothing is dropped. |
| 3 | The update watcher and its quiet-hour install. | Already handled: its state is database rows (the first-seen and installed rows in `Setting`), not a timer's memory, so a restart reads it back on the first tick. Other in-process timers were not audited one by one. |
| 4 | The tab's own update reload. | Already handled: `lib/reload-safety.ts` refuses to reload while a field is unsaved, a dialog is open, a file is moving, media plays, or any non-GET fetch is in flight. Server actions are POSTs through `fetch`, so they are counted by `lib/work-in-progress.ts`. A write refused or lost is marked unsaved again, so the update waits for it. |
| 5 | An update started in the middle of a service or a call. | Fixed in the same branch: a scheduled install steps back while an order line or payment was taken in the last ten minutes or a call has somebody on it, for at most two hours (`lib/update-busy.ts`). The quietest hour itself now counts orders, payments and calls. "Immediately" and the Update button never wait. Polaris does not recommend one install time over another: the quiet hour is an ordinary choice in Admin > Updates, and staying up through a restart is each app's own job (Hospitality: finding 8). A deployment that already moved every severity to the quiet hour keeps that schedule and its recorded acceptance. |
| 6 | Retrying a mutation the connection dropped. | Not done, deliberately: a server action is not idempotent in general, and replaying one blind can take a payment twice. A retry needs an idempotency key per action; see "Mutations without an idempotency key" below. Everything else surfaces the failure and keeps the field unsaved (finding 4). |
| 7 | Postgres, hostd, Traefik restarting in the same update. | Out of scope here. They are restarted in place only when their own definition changed, and the dashboard's Prisma client reconnects on the next query. |
| 8 | A handheld taking orders through a dashboard restart. | Fixed: the queue dropped a write the server failed on. Orders, lines, sends and payments go through the device's queue (`apps/hospitality/src/model/offline-queue.ts`, kept in IndexedDB by `screens/offline.ts`), each with ids the device made, and the server stores each id once (`createMany` with `skipDuplicates` in `lib/orders.ts` and `lib/till.ts`; a replayed payment on a paid order answers what it already stored). A request with no answer (the edge's 502 while no container is up, a reset connection) rejects and stays queued. But a failure inside the action (the database restarting under the update) answered `{ ok: false }` like a refusal, and the queue dropped the order. `lib/outcome.ts` now marks those `retry`, and `deliveryOf` keeps them queued for up to ten minutes (`RETRY_WINDOW_MS`) before handing them back to the waiter. |

## Every critical surface when something fails

"Tested" names what proves it in this repository. "Not verified here" means it
was read in the code but no test or rollover in this audit exercised it.

| Surface | What fails | What keeps working | How it recovers | What the screen says | Tested |
|---|---|---|---|---|---|
| Update rollover (`scripts/update.sh`) | The new build never turns healthy | The old container keeps serving; the new one is removed | Nothing to recover; the next update tries again | Admin > Updates shows the failed run and offers a bug report | Not verified here (needs Docker) |
| Dashboard container stop | SIGTERM during an update | Requests in flight finish (Next.js drain, 20 s) | Streams end at once and reconnect to the new container | Nothing; a stream reconnects without a message | `test/platform/shutdown-streams.test.ts` |
| Dashboard pages | A page throws, or the network drops for a moment | The shell, nav and every other app stay; the failing panel only | `app/(app)/error.tsx` retries a network failure by itself (`useNetworkRetry`) with the page skeleton up, and reloads once for a stale build | A card about the connection, or the error with a retry that asks the server again | Existing error-boundary tests; not re-run in this audit |
| Sign-in and session | Database down | Nothing that needs an account: every session read is a database read | Prisma reconnects on the next query once Postgres is back | The page error card | Not verified here |
| Database (Postgres) | Down or restarting | Static assets; `/api/health` answers 503, so a rollover will not swap to a new container that cannot reach it | Container `restart: unless-stopped`; Prisma reconnects | Page error cards | Not verified here |
| Chat and calls | Dashboard restart | A call's media is LiveKit's, a separate container, so audio and video carry on; the chat stream reconnects | EventSource reconnects; call heartbeats resume | Chat shows nothing; the call keeps going | Not verified here |
| Hospitality | Dashboard restart in service | Handhelds keep taking orders: each write waits in the device's queue (IndexedDB, survives a closed tab) and replays in order without duplicates once the dashboard answers. Scheduled installs also step back while orders or payments are live (`lib/update-busy.ts`) | The queue sends again on `online`, when the screen is shown, and every 15 s; a tab on the old build cannot send until it reloads, and its queue is still there after | The count of orders waiting on the device | `test/hospitality/model/offline-queue.test.ts`, `test/hospitality/lib/outcome.test.ts`, `test/updates/quiet-hour-install.test.ts` |
| Drive | Restart during an upload or download | The tab will not reload itself while a transfer is moving (`lib/reload-safety.ts`) | The transfer has to be started again if the container went away under it | The transfer's own error | Not verified here |
| Deploy edge (Traefik) | A malformed dynamic file | Traefik keeps its last good configuration | `writeDynamicFile` writes atomically; the health probe republishes app routes when it finds one unrouted | The app's health shows down, not up | Existing traefik-dynamic and health-probe tests |
| hostd | Daemon not answering | Every screen that only reads the database; host actions answer `null`, "busy" or "timeout" instead of hanging (`packages/hostd-client`) | Retried on the next action | The action's own message | Not verified here |
| Redis or queues | Not part of the platform: Redis is only a data-browser driver. Background work runs under database leases (`lib/cron/lease.ts`) | Everything | A lease a dead process held expires and another container takes it | Nothing | Existing automations tests |
| Container registry or GitHub | Unreachable | The running build; the update check keeps its last answer | The watcher asks again on its next tick; offline it does not ask | Admin > Updates shows the last known state | Not verified here |
| DNS or Let's Encrypt | Unreachable | Certificates already issued keep serving until they expire | Traefik's ACME client retries on its own schedule | Domain security in Admin lists the problem | Not verified here |

## Remaining findings, by impact

1. **Database outage takes every signed-in screen down.** There is no read
   replica and no cached session, so a Postgres restart is an outage for its
   duration. A cached, read-only shell (last known pages from the client cache)
   is the cheapest way to degrade rather than fail; it is a design change across
   the data layer, not a fix here.
2. **No idempotency key on server actions.** A write the connection dropped
   cannot be retried safely, so it is surfaced and kept unsaved instead
   (finding 6 above). Hospitality carries its own keys.
3. **A Drive transfer cut by a restart may not resume.** Whether an upload
   picks up where it stopped after the container went away was not traced in
   this audit; resumable uploads (tus, or chunks with offsets) are what would
   make it survive a rollover.
4. **Rollover timing is unmeasured with streams closing early.** The 20 s stop
   is now normally a few seconds, but that has not been measured on a host.
5. **A handheld on the old build holds its queue until it reloads.** After an
   update the server no longer knows the old tab's action ids, so every queued
   write is rejected as unanswered and kept. Nothing is lost or doubled, but
   nothing reaches the kitchen either until the tab takes the new build: the
   new-build banner offers Reload, and a page in sight is not reloaded by
   itself (`components/new-build-banner.tsx`). Reloading the service screen
   on its own when the queue meets a stale build, with nothing typed and no
   dialog open, would close the gap.

## Mutations without an idempotency key

A mutation is safe to retry after a dropped connection only when the client
sends a key it made and the server answers a repeat with what it already
stored. Where that exists today:

- **Chat messages**: `chatSendSchema.clientKey`; a repeat returns the stored
  message (`lib/chat/messages.ts`). The composer keeps each message in an
  on-device outbox with its key and sends it again when it can.
- **Mail**: sending goes through the draft and `/api/mail/outbox`
  (`lib/mailbox/outbox-answer`), keyed by the draft id.
- **Hospitality orders, lines and payments**: ids made on the device, stored
  once by the server, replayed by the device's queue (finding 8).

Without one, ranked by what a duplicate costs. "No key" means the action
file has no client-supplied key, idempotency or dedupe field in its input; it is
a lead to fix, not a proven double write, since some writes are naturally
idempotent (a set, not an insert).

| Rank | Mutation | File | Duplicate on a retry |
|---|---|---|---|
| 1 | Create a task, list, folder, status, tag | `app/(app)/tasks/actions.ts` (`createTaskAction` and the other `create*Action`) | A second task with the same title, its own reference number and its own notifications |
| 2 | Forward a chat message into another room | `app/(app)/chat/actions.ts` (`forwardAction`); the composer sends it without the outbox | The same message posted twice |
| 3 | Create a note, space or folder | `app/(app)/notes/actions.ts` (`createNoteAction`, `createSpaceAction`, `createFolderAction`) | A second note or folder |
| 4 | Create a Drive file or a share link | `app/(app)/drive/actions.ts` (`createFileAction`), `share-actions.ts` (`createShareAction`) | A second file or a second share link |
| 5 | Create an Office document | `app/(app)/office/actions.ts` (`createDocumentAction`) | A second document |

The pattern to apply is the chat one: a UUID made by the client per attempt,
stored in a unique column with the author, and a repeat answered with the row
already there. That is a schema change per table and was not done here.

## Not exercised

There is no Docker on the development machine, so none of this has been run
against real containers. Verified by tests only:

- `test/platform/shutdown-streams.test.ts`: a stream opened with the shutdown
  signal ends when it fires; the request's own signal is untouched.
- `test/updates/quiet-hour-install.test.ts`: an install steps back while a venue
  is serving or a call is on, installs once it is quiet, installs anyway at the
  cap, and never holds back "immediately".
- `test/hospitality/model/offline-queue.test.ts`: a write the server failed on
  during a restart stays queued and goes out once, in order, with no line
  added twice; a refusal is handed back at once.
- `test/hospitality/lib/outcome.test.ts`: a failure inside an action is marked
  for retry, a refusal is not.

Not verified: the time Traefik takes to drop a dying container, the real
drain time with streams closed, and EventSource reconnect timing in each
browser. Measuring them needs a rollover on a real host.
