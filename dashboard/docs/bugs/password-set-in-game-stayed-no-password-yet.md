# A password set in game stayed "no password yet" on the players table

**Found:** October 2026. **Fixed in:**
`dashboard/apps/game-servers/src/screens/installed/minecraft-polaris-login.tsx`,
`dashboard/apps/game-servers/src/screens/installed/minecraft-panel.tsx`,
`dashboard/apps/game-servers/src/screens/installed/minecraft-join-password.tsx`.
**Guarded by:**
`dashboard/apps/web/test/apps/minecraft-players-password-live.test.tsx`.

## What was seen

A player who joined and ran `/register` still showed "no password yet" on
the players table, though the same row - fed by the five-second roster poll

- already said they were online. The row only caught up after the page was
  reloaded, or after up to a minute passed on its own.

## What it actually was

The players table reads who has a Polaris login password from the login
state the panel keeps, and that state was read again on a fixed one-minute
`setInterval` (`LOGIN_REFRESH_MS`) no matter what it held, with no way to
notice a tab that had gone hidden or come back into view. An operator who
switched to the game, watched a player register, and switched back could
find the row still stale for most of that minute. The join-password card's
own read (used when no shared login handle is passed in) was worse: it had
no interval at all, so it never refreshed after its first read.

## The fix

`useLoginState` now schedules its next read from the end of the previous one
rather than on a fixed interval, asks nothing while the tab is hidden, and
reads at once when the tab becomes visible again or the window regains focus
from the game - the same way the panel's own server-status poll already
behaves. The interval can be a function of what is currently held: the new
`awaitingPassword()` checks whether anyone in the online roster is missing
from the login state's player list, and the panel passes a function that
reads again every `LOGIN_LIVE_MS` (5 s) while that is true and every
`LOGIN_IDLE_MS` (30 s) otherwise, so the row catches up within a few seconds
of somebody actually standing at the prompt without polling that fast all
the time. An answer identical to what is already held keeps the same object
(nothing that draws it re-renders), an answer that lands after a newer one
already has is dropped, and a read that throws leaves the row as it was. The
join-password card's own read now refreshes on the same idle cadence instead
of only once.

A second pass found that returning to the tab a moment after a read had just
landed - inside `RETURN_GAP_MS` of it - was silently dropped without
scheduling anything to pick it up later, which could leave the beat stalled
until the next focus or visibility event. Coming back inside that gap now
re-arms a timer for whatever is left of it instead of doing nothing.

## What stops it coming back

`minecraft-players-password-live.test.tsx` covers the live transition from
"no password yet" to "password set" with no reload, the slowdown once
everybody online has a password without asking twice for it, a read that is
still in flight or that fails, reading at once on visibility and focus
changes and nothing while hidden, the gap-timer re-arm case, and
`awaitingPassword`'s name-folding and `useLoginState`'s same-answer and
stale-answer handling.

## The general rule

A screen polling for a change somebody is actively watching for needs a
cadence that reacts to what it already holds - fast while the thing watched
for has not happened yet, slow once it has - and to the tab's own
visibility, not one fixed interval chosen up front. A flat interval is
either too slow for the moment that matters or wastes reads for the rest of
the time.
