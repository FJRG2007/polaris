---
id: BUG-0012
title: Signing in on the web jumps to the desktop app halfway through
status: fixed-watching
area: auth / open in app
location: dashboard/apps/web/src/components/open-in-app.tsx
related:
  - dashboard/apps/web/src/lib/open-in-app.ts
  - dashboard/apps/web/src/app/oauth/layout.tsx
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: "fix(auth): a sign-in started in the browser finishes in the browser"
---

## What was seen

Signing in on the web (vault included) opened the desktop app in the middle of
the flow.

## Cause (from code)

"Open links in the app" hands a page reached from outside Polaris to the app.
It judged "from outside" by the document's referrer and navigation type, but
by the current path. A sign-in moves on to the app with the router, not a page
load: the document still had the sign-in screen's empty referrer and
`navigate` type, while the path was already the app's, so the handoff fired.
A sign-in through a provider's screen came back from another site and read as
a link followed from outside for the same reason.

## Fix

The handoff checks the path the document was loaded on as well, and the
sign-in screens mark the tab so the page a sign-in lands on is never handed
over.

## Verified

`test/mobile/open-in-app.test.ts`. Not exercised in a browser with the desktop
app installed.
