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
| 5 | An update started in the middle of a service or a call. | Fixed in the same branch: a scheduled install steps back while an order line or payment was taken in the last ten minutes or a call has somebody on it, for at most two hours (`lib/update-busy.ts`). The quietest hour itself now counts orders, payments and calls. "Immediately" and the Update button never wait. |
| 6 | Retrying a mutation the connection dropped. | Not done, deliberately: a server action is not idempotent in general, and replaying one blind can take a payment twice. A retry needs an idempotency key per action; Hospitality has its own offline queue with keys, built separately. Everything else surfaces the failure and keeps the field unsaved (finding 4). |
| 7 | Postgres, hostd, Traefik restarting in the same update. | Out of scope here. They are restarted in place only when their own definition changed, and the dashboard's Prisma client reconnects on the next query. |

## Not exercised

There is no Docker on the development machine, so none of this has been run
against real containers. Verified by tests only:

- `test/platform/shutdown-streams.test.ts`: a stream opened with the shutdown
  signal ends when it fires; the request's own signal is untouched.
- `test/updates/quiet-hour-install.test.ts`: an install steps back while a venue
  is serving or a call is on, installs once it is quiet, installs anyway at the
  cap, and never holds back "immediately".

Not verified: the time Traefik takes to drop a dying container, the real
drain time with streams closed, and EventSource reconnect timing in each
browser. Measuring them needs a rollover on a real host.
