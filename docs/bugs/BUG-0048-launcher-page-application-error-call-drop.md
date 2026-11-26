---
id: BUG-0048
title: Opening a page from the launcher shows "Application error" and drops the call on screen
status: fixed-watching
area: desktop
location: clients/desktop/src/main/page-router.ts
related:
  - clients/desktop/src/main/index.ts
  - clients/desktop/src/main/ipc.ts
  - clients/desktop/src/main/perf-log.ts
  - clients/desktop/src/main/perf-watch.ts
  - clients/desktop/src/preload/app.ts
  - clients/desktop/src/shared/bridge.ts
  - dashboard/apps/web/src/components/call-holder.tsx
  - dashboard/apps/web/src/app/global-error.tsx
  - dashboard/apps/web/src/app/api/client-error/route.ts
  - dashboard/apps/web/src/lib/client-error.ts
  - dashboard/apps/web/test/search/launcher-targets.test.ts
reported: 2026-11-25
fixed: 2026-11-26
fix_commit:
---

## What was seen

On the desktop app, during a call, opening "Game servers" (and an installed
Minecraft server, typed as "mc") from the launcher:

- A. the window showed Next.js's own "Application error" screen instead of the
  page, and
- B. the call that was up in that window ended.

## Cause

- B: the launcher, the settings route, `openPath` and a notice click opened the
  page with `loadURL` on the main window - a full load, which replaces the page
  and everything it holds. The call lives in `CallHolder`, above the dashboard's
  routes, so it survives a move through the page's own router but not a reload.
- A: **not found.** The screen seen is Next.js's built-in global error, which
  only appears when the dashboard's own `global-error.tsx` throws or the router
  itself throws outside it; an ordinary page error shows Polaris's card. The
  server's log for the day had no matching error, so it happened in the window.
  Every launcher and palette target was checked to resolve to a route
  (`launcher-targets.test.ts`), so it is not a missing page. The old
  `global-error.tsx` read `error.message` and so broke on a thrown `null` or
  `undefined`, which is one way to reach that screen; whether it was this one is
  not known.

## Fix

- The page says its router takes paths (`navigateReady`, through the bridge's
  `fromPolaris` check), and the desktop hands it the path (`navigate`) instead
  of reloading it (`openInPage`), only on a dashboard screen of the same
  Polaris. A dashboard older than this never says so and is loaded as before.
- `global-error.tsx` turns any thrown value into an error before reading it.

## What now records part A

- The page that cannot be drawn posts what it failed with to
  `/api/client-error`, logged on the server as one `polaris: page error` line
  (name, first line, digest, path, first frames; addresses and tokens masked).
- The desktop app writes a window's console errors and a preload that failed to
  `perf.log` (`page-error`, `preload-error` lines).

If it happens again, those two lines name what threw.

## Unverified

Not run in a real Electron window on this machine (no GUI launches here), and
the call surviving the launcher was not exercised in a live call.
