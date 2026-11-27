---
id: BUG-0051
title: Typing in a task while Polaris updates says "The request could not be completed. Try again."
status: fixed-watching
area: dashboard
location: dashboard/apps/web/src/lib/offline/try-now.ts
related:
  - dashboard/apps/web/src/lib/run-action.ts
  - dashboard/apps/web/src/components/connection-banner.tsx
  - dashboard/apps/web/src/app/(app)/tasks/offline-writes.ts
  - dashboard/apps/web/src/app/(app)/notes/offline-writes.ts
  - dashboard/apps/web/src/app/(app)/drive/offline-changes.ts
  - dashboard/apps/web/src/app/(app)/drive/drive-explorer.tsx
  - dashboard/apps/web/src/app/(app)/chat/outbox.ts
  - dashboard/apps/web/src/lib/offline/app-action-writes.ts
  - dashboard/apps/web/test/offline/update-window-writes.test.ts
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

While Polaris was updating from the Update button in Settings (the dashboard
container restarting), typing in a task showed "The request could not be
completed. Try again." The same happened to any save made in that window.

## Cause

Writes were only kept on the device and sent later when the request got no
answer at all (`isNetworkFailure`). An update has a second phase that was not
covered: once the new dashboard is up, it answers this tab's server actions
with `Server Action "..." was not found on the server`, because Next mints new
action ids per build. `tryNow` treated that as a server failure, so the write
was not kept and the generic sentence was shown. Every queued kind (tasks,
notes, drive changes, chat edits, app actions) had the same gap.

Saves that are not queued (settings forms, dialogs) went through `runAction`,
which reported any failure at once, including the seconds where the dashboard
is restarting and nothing answers.

## Fix

- `canKeepForLater` (`lib/offline/try-now.ts`): a write is kept when nothing
  answered or when a newer build answered. The server never ran it in either
  case. `tryNow`, chat `changeMessage`, drive `orKeep` and trash, and
  `attemptAppAction` for app actions all use it.
- `undelivered`: a queued write the old tab cannot send counts as `held`, not
  `unreachable`, so it uses up no attempts and is never marked "not sent". The
  page loaded after the reload sends it. The queue key and the task's own id
  are unchanged, so it is written once. The reload offer is raised at the same
  time (`checkForNewBuild({ failed: true })`).
- `runAction`: when a call got no answer and a probe confirms Polaris is not
  answering, the call waits (up to `OUTAGE_WAIT_MS`, 10 minutes) and is sent
  again once Polaris answers. Meanwhile the connection banner adds "Your
  changes are saved as soon as it is back." If only that request failed and
  Polaris still answers, it is reported as before, because sending it again
  blind could repeat something the server took. A newer build answering a
  non-queued save says "Polaris was just updated. Reload the page, then try
  again." instead of the generic sentence.
- The text of that save survives the reload. A refused `runAction` call puts
  back what a submitted form held (`noteWriteRefused`), so it counts as unsaved
  again. An update then waits for it, and the Reload button on the update card
  writes it down and puts it back on the new page. A box with no id or name,
  such as a dialog's own input, is found again by its label or placeholder,
  but only when no other box on the page shares it.

This follows the Linear, Replicache and Slack approach: the edit stays applied
locally, it is queued under a client-made id that the server deduplicates, and
it is retried until the server accepts or rejects it.

## Verification

- `dashboard/apps/web/test/offline/update-window-writes.test.ts`: a task edit
  answered by a newer build is kept with no error and stays pending with zero
  attempts across repeated flushes, then is sent once after the reload. A task
  made while the edge answers for the restarting dashboard is created once
  under the same id. A `runAction` save with Polaris down waits, is sent again
  when the probe gets through, and reports nothing. It fails at once when
  Polaris still answers, says to reload after an update, and gives up after
  the outage limit.
- Not exercised against a real container restart: Docker is not available on
  the development machine.
- `test/lib/work-in-progress.test.ts`: a form that was sent and refused is unsaved
  again, and one that was accepted stays saved. A box is found by a unique
  placeholder, never by one that two boxes share.
  `test/components/new-build-auto-reload.test.tsx`: after a click failed for
  the update, the card's Reload button reloads.
- A save that is not queued and lands on the new build is still not sent by
  itself. Its text is kept across the reload, but the reader presses Save
  again on the new page. A box with no id, name, label or placeholder, or one
  that shares them with another box, is not restored.
