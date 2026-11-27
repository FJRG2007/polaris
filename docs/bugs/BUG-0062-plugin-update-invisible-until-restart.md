---
id: BUG-0062
title: A device plugin's new version stays invisible until the desktop app is restarted
status: fixed-watching
area: device-plugins
location: clients/desktop/src/main/plugins/manager.ts
related:
  - clients/desktop/src/main/plugins/catalog.ts
  - clients/desktop/src/main/plugins/updates.ts
  - clients/desktop/src/main/plugins/electron.ts
  - dashboard/apps/web/src/app/(app)/account/plugins/plugins-view.tsx
  - clients/desktop/test/main/plugins/manager.test.ts
  - clients/desktop/test/main/plugins/catalog.test.ts
  - dashboard/apps/web/test/account/plugin-store-cards.test.tsx
reported: 2026-11-26
fixed: 2026-11-27
fix_commit:
---

## What was seen

The published plugin list already offered the Stream 100 plugin 0.1.8, but the
Device plugins screen kept showing 0.1.6 with no update. Opening the screen
again changed nothing; the update appeared only after quitting the desktop app
completely and starting it again.

## Cause

The desktop app kept the plugin list it had fetched for six hours: a store read
looked again only once the copy was older than `CATALOG_FRESH_MS` (6 h), and the
background schedule (`CHECK_EVERY_MS`) also waited six hours. A restart was the
only thing that cleared the in-memory fetch time. The store had no way to ask
for a look either, so nothing on screen could end it.

## Fix

- Every store read draws the list on the device at once and looks at the
  published one behind it (stale-while-revalidate); a newer list reaches the
  screen through the change event, so the Update action shows without a
  restart. A burst of reads within 30 s (`STORE_REVALIDATE_MS`) makes one look.
- Looks are conditional: the held list's ETag goes as `If-None-Match`, and a
  304 is taken only while that same list is held, so it costs no download.
- The background schedule is one hour; the retry backoff on failure is kept.
- The store has a visible Check for updates action: "Checking...", then how many
  updates were found, "Everything is up to date", or that the list could not be
  reached. `refresh()` now answers whether the list was reached, so the screen
  never says "up to date" without having looked.

## Verification

`manager.test.ts` publishes a newer list while the app runs and sees it on the
next store read without a restart, checks that a burst of reads makes one look,
and that Check for updates answers updated / unchanged / failed.
`catalog.test.ts` covers the ETag round trip. `plugin-store-cards.test.tsx`
covers the Check for updates states and the Update action showing at once.
Not exercised against GitHub's release download (whether it answers 304 there
is not verified; without an ETag the look is a plain download as before).
