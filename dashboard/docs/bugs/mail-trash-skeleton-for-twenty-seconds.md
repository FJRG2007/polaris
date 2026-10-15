# Opening Trash showed its skeleton for twenty seconds or more

**Found:** October 2026. **Fixed in:**
`dashboard/apps/web/src/app/api/mail/threads/route.ts`,
`dashboard/apps/web/src/lib/mailbox/sync.ts`.
**Guarded by:** `apps/web/test/mail/first-page-never-waits.test.ts`.

## What was seen

Opening Trash - or any folder holding only a few messages here - sat on its
skeleton for twenty seconds or more before anything drew. Other folders with
a full window of mail answered at once; a sparse one did not.

## What it actually was

A folder's first page is asked with no cursor. When what is held here ran out
before a full page and `reachesForOlder` said the mailbox was the reader's own,
the route went straight to `reachForOlder` - a real IMAP reach for the next
older batch - and only answered once that returned, before the page had drawn
anything at all. That reach waits on the mailbox's own running sync pass and
then on a connection of its own, which is where the twenty seconds went. A
folder that already held a full page never took this path, which is why it
looked like a Trash-only problem rather than what it was: the first page of
any thin folder.

## The fix

The first page (`cursor === ""`) no longer reaches the server before
answering. It answers at once with what is held, and `olderOnServer` - a plain
count of stored rows against the folder's own `total`, read from the database
alone - says whether the server holds more without opening a connection. When
it does, the page is handed a cursor so the list's own bottom-of-the-list
fetch, already on screen for a short list, is what goes and gets the rest
behind what already drew. Asking past the first page (a real cursor already in
hand) still reaches the server before answering, as before - that path was
never the slow one.

A follow-up review pass fixed the cursor itself: it had been a bare sentinel
(`"older"`) on every first page that needed one, which reads as no cursor to
the list and so re-lists from the top on the next fetch. That drops nothing
for a folder that fits on one page, but a folder holding several pages here
would restart its own list at row one instead of continuing past what had
already drawn. `olderCursor` now builds the real cursor past the last held row
(`mailCursorOf`) when there is one, and only falls back to the sentinel for a
folder with nothing held at all.

## What stops it coming back

`first-page-never-waits.test.ts` asserts the first page never calls
`reachForOlder`, that it still answers with what is held when the server holds
more, that an empty folder gets the sentinel cursor, and that continuing past
several held pages picks up past the last row drawn rather than the top of the
folder.

## The general rule

A page's first answer has to come from state already on hand. Reaching
upstream to decide whether to reach upstream again blocks the one request a
person is actually waiting on behind the same latency the pagination was meant
to hide; a local check (a count, a cached flag) can say "there is more" cheaply
enough to let the request that already has a reason to go fetch it - the next
scroll, a background pass - do that instead. And a synthetic "there is more"
cursor has to point at the true next row, not a generic sentinel, the moment
local state can already hold more than one page: a sentinel that reads as "no
cursor" quietly restarts the list instead of continuing it.
