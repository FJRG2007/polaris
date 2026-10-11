# An inbox of three thousand messages showed two

**Found:** October 2026. **Fixed in:** `dashboard/apps/web/src/lib/mailbox/sync.ts`,
`dashboard/apps/web/src/lib/mailbox/folder-window.ts`,
`dashboard/apps/web/src/app/api/mail/threads/route.ts` (#541, #544).
**Guarded by:** `apps/web/test/mail/folder-window.test.ts`,
`apps/web/test/mail/mail-arrives-whole.test.ts`.

## What was seen

An IMAP account whose inbox held 3104 messages on the server showed 2 in
Mail. Nothing had been deleted by anybody, the other folders looked normal,
and new mail still arrived - so it looked like a display or filter problem,
not a sync one. Scrolling to the end of the list ended there too: there was no
way to reach anything older than what Polaris already held.

## What it actually was

Mail is a cache of the server, kept by uid. A pass fetches what arrived past
the last uid it read, and `reconcileDeletions` drops a cached row the server
no longer lists. Two things together made that lose mail for good:

1. **One command decided a deletion.** A single uid search over the folder
   was taken as the truth. A search answered short - a server under load, a
   connection cut mid-answer - listed fewer uids than the folder had, and every
   row it left out was deleted from the cache.
2. **Nothing ever fetched a dropped row again.** The row's uid was behind the
   cursor, so no later pass asked for it, and the only refill there was trusted
   a count of the folder: once older rows were held, a count could not see a
   gap in the newest ones.

On top of that the list of a folder only ever read the cache, so once it ran
out there was no path to older mail on the server either.

It was there from the first IMAP sync (September 2026): the deletion pass
trusted one search from the start, and nothing asserted what a short answer
does to the cache. On most mailboxes a short answer is rare enough that a few
lost rows go unnoticed, so it showed only once a whole inbox had gone.

## How it was proved

The live database held 2 inbox rows for the account against 3104 on the
server. After #541 and #544 deployed, the same query counted 400 inbox rows -
the whole newest window, refilled by the sync passes with no new mail
arriving - and the operator saw the messages back in Mail. Anything older than
that window is fetched from the server as the list is scrolled to its end.

## The fix

- `confirmedGone` (`folder-window.ts`): a row is dropped only when the uid
  search left it out AND a fetch of exactly those uids, a different command,
  does not return it either. Either command failing drops nothing.
- `refillWindow` (`sync.ts`): every pass lists the uids of the newest window
  and fetches any the cache is missing (`missingFromWindow`). It also repairs a
  cache that lost rows before the fix. What it brings back is stored as old
  mail: no rules, no junk filter, no away reply.
- `fetchOlder` / `reachForOlder` (`sync.ts`, called from the threads route): a
  plain newest-first list that reaches the end of the cache asks the server for
  the next 200 older messages and answers the page again, only for the
  reader's own mailboxes (`reachesForOlder` decides when).

## What stops it coming back

`folder-window.test.ts` asserts a row the second command still returns is
never dropped, that every uid missing from the newest window is found, and
when a list may reach for older mail. `mail-arrives-whole.test.ts` covers the
older fetch being serialized against a running pass.

## The general rule

In a cache that only moves forward by cursor, deleting a row is permanent:
nothing behind the cursor is ever fetched again. So a deletion needs a second,
independent confirmation, a failure must mean "keep", and there must be a pass
that compares what is held against the server by id - never by count - and
fetches what is missing.
