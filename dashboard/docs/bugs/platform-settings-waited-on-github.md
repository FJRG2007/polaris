# Opening Management > Platform took a while to show anything

**Found:** November 2026. **Fixed in:**
`dashboard/apps/web/src/lib/update-service.ts`,
`dashboard/apps/web/src/lib/network-service.ts`,
`dashboard/apps/web/src/lib/app-bundles/releases.ts`.
**Guarded by:** `apps/web/test/updates/status-without-waiting.test.ts`.

## What was seen

Pressing Platform in Management (the Updates & settings screen) sat on its
placeholders for several seconds before the update line, the addresses and
the app versions drew. Most visits were quick; the slow ones came right after
an update and then every so often.

## What it actually was

The page's shell and skeletons were never the problem - they paint at once.
What the regions waited on was three answers that each go out to the internet,
cached with a lifetime and **blocking whenever the cache was empty or old**:

- the update status (`getUpdateStatus`) asks GitHub and the registry. Its cache
  lived only in memory for ten minutes, so it was empty after every restart -
  and an update is a restart, so the visit made to see an update land was
  always the slow one - and expired every ten minutes after that;
- the public address (`detectPublicIp`) asks up to three echo services in turn
  once its six hours are up;
- each installed app's newest build (`latestRelease`) asks the registry, up to
  fifteen seconds per app, once its ten minutes are up.

The settings overview answers all of them in one request, so the slowest of
them held every region. Locally none of this showed: with no network the
lookups fail at once.

## The fix

Stale-while-revalidate for all three. A known answer is returned immediately
and, when it is old, refreshed in the background for the next read; only a
deployment that has never had an answer waits. The update status is also kept
in a setting across restarts, and used only when it was made by the build that
is running, so the visit after an update is instant and never shows the old
version as current. "Check now" still waits for a fresh answer, because that
is what pressing it asks for.

## The rule this leaves

A read that a screen waits on never waits on a network call to somebody else's
service when an earlier answer exists. Serve the earlier answer, refresh it
behind the render, and show when it was checked. A cache with a lifetime that
blocks on expiry is the same bug on a timer: it is fast in testing and slow for
whoever lands on the expiry. Lookups that only run when somebody presses a
button (an install command, a "check now") may wait, because that is the wait
they asked for.
