---
id: BUG-0033
title: With Polaris unreachable, only the chat opens - every other app shows the offline page
status: partly-fixed
area: dashboard / offline
location: dashboard/apps/web/public/sw.js
related:
  - dashboard/apps/web/src/lib/offline/offline-shell.ts
  - dashboard/apps/web/src/components/app-locks.tsx
  - dashboard/apps/web/src/lib/account-switch.ts
  - dashboard/apps/web/test/app/installable.test.ts
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "feat(offline): every app opens from the device when Polaris cannot be reached"
---

## What was seen

With the host unreachable (the machine off, the laptop on another network), the
installed app and the desktop window opened onto "Polaris is not reachable" for
everything except the chat. Notes, documents, tasks, mail, Settings: nothing that
had been open a minute earlier could be read again.

Expected (owner, like WhatsApp): what is on the device stays viewable with no
time limit, and only what genuinely needs the host says so in place.

## Cause (confirmed in code)

The service worker kept a page that loaded only under `/chat`
(`isChatPage`). Every other navigation went to the network and, failing it,
answered with `offline.html`.

## Fix

The app-shell technique (Workbox "network first, cache fallback" for
navigations): every page of the signed-in app that loads is kept, and used only
when the network cannot answer, never in place of an answer.

- Kept: the `(app)` route group's sections (`KEPT_SECTIONS`), held to the route
  group by a test so a new app is not left out. Never the Vault, the PIN screen,
  a public page, an API answer or a redirect.
- A page never opened on this device falls back to the nearest kept page above it
  in its own section (a note to the notes list), then to the offline page.
- Bounded: at most `PAGES_KEPT` (80) pages, the least recently loaded dropped
  first. Deleted whole on sign-out and account change, as before.
- An app behind the PIN is never kept: the page, which knows the locks, deletes
  that app's kept pages whenever the locks are read or change
  (`lib/offline/offline-shell`), so the lock cannot be walked around offline.

## Not fixed here

- Writes made offline outside the chat are not queued yet: a note's autosave
  fails with an error and its text lives only in the open tab; documents and
  tasks likewise. The shared outbox is the next slice.
- A page that fetches its data after it opens shows that region's own failure
  state, not the last value, unless it already keeps a snapshot.
- Service workers exist only on a secure origin (HTTPS or localhost). A Polaris
  reached over plain HTTP on a home network has no worker, so nothing opens
  offline there. iOS WKWebView does not run the site's worker either.
