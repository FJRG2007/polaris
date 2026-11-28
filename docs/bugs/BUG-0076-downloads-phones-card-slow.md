---
id: BUG-0076
title: The "Polaris for phones" card on Downloads takes seconds to show its files
status: fixed-watching
area: downloads
location: dashboard/packages/ui/src/downloads/account/app-releases.ts
related:
  - dashboard/packages/core/src/stale-while-revalidate.ts
  - dashboard/packages/ui/src/downloads/account/store-listings.ts
  - dashboard/apps/web/test/account/downloads-instant.test.tsx
  - dashboard/packages/core/test/cache/stale-while-revalidate.test.ts
reported: 2026-11-28
fixed: 2026-11-28
fix_commit:
---

## What was seen

Account > Downloads: the "Polaris for phones" card (Android APK 0.1.17, iOS
planned) sat on its skeleton for seconds before the APK row drew. The rest of
the page was already there.

## What it actually was

The card's files wait on two outside lookups, both cached with a lifetime that
BLOCKED on expiry:

- the GitHub release list (`app-releases.ts`): two minutes, then the next
  viewer waited on a fresh walk of up to three serial pages (six-second cap).
  In memory only, so every restart - every update - started cold;
- Google Play and F-Droid (`store-listings.ts`): six hours, then the next
  viewer waited up to five seconds; while a store refused, every five minutes.

The same bug the Platform screen had (`docs/bugs/platform-settings-waited-on-github.md`),
in a module written as its own cache instead of reusing a shared one.

## The fix

`@polaris/core/stale-while-revalidate`: one shared read cache. A held answer is
served at once; past its freshness one refresh runs in the background, shared by
every concurrent caller; a failure keeps the held answer and retries; only a key
with nothing held waits, bounded. Both lookups use it, and the release list and
store listings are read at boot so the first visit after an update is warm.

The same helper now serves the Runners page's GitHub access notice and the
Integrations GitHub note, and the code review list no longer waits on GitHub
workflow writes before drawing.

## The rule this leaves

A screen read never waits on somebody else's service when an earlier answer
exists. Use `staleWhileRevalidate` instead of a hand-rolled TTL map.
