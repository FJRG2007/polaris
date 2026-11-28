---
id: BUG-0076
title: "More apps" on the Overview rail opens the search instead of the app menu
status: fixed-watching
area: navigation
location: dashboard/apps/web/src/components/favorite-apps.tsx
related:
  - dashboard/apps/web/src/lib/search/open-search.ts
  - dashboard/apps/web/test/navigation/favorite-apps.test.tsx
reported: 2026-11-28
fixed: 2026-11-28
fix_commit:
---

## What was seen

On the Overview rail (desktop) and in the phone sheet, "More apps" opened a
search instead of the menu with every app.

## Cause

Commit 0ab3b1828c ("every search in the window opens the launcher") routed
`openLauncher` through `openDesktopLauncher`, meant for search buttons. In Polaris
Desktop that opened the desktop launcher window, a search, for "More apps" too.

## Fix

`openLauncher` opens the in-page app menu again, in every surface. The search
button and shortcut still use `openDesktopLauncher`. Regression test: clicking
"More apps" shows the grid and never calls the desktop bridge's `showLauncher`.

## Not verified

The desktop window itself was not run; the test stands in for its bridge.
