# A click on another app from Mail did nothing until reload

**Found:** September 2026. **Fixed in:** `dashboard/apps/web/src/lib/concurrency-gate.ts`,
`dashboard/apps/web/src/lib/safe-fetch.ts`,
`dashboard/apps/web/src/app/api/mail/face/[address]/route.ts`.
**Guarded by:** `apps/web/test/lib/concurrency-gate.test.ts`,
`apps/web/test/lib/safe-fetch-lookups.test.ts`.

## What was seen

Open Mail, click another app in the switcher, and nothing happens - no
navigation, no error, the click just does not register. Reloading the page
lands on the new app as if the click had worked all along. It looked like the
app switcher or the client-side router had dropped the click, and a mailbox
with only a handful of senders in it never showed it - only a cold mailbox,
full of newsletters, did.

## What it actually was

Every row in the mail list asks the server for the sender's mark - a small
`<img>` at `/api/mail/face/[address]` - and a screenful of rows is a
screenful of requests, all made by the browser at once. Each of those hunts up
to three outside hosts before giving up, and each of those resolves a hostname
first. `dns.lookup` is `getaddrinfo`, which Node runs on libuv's thread pool -
four threads, shared by the whole process for everything that is not plain
network I/O: signing and checking the session cookie, compressing a response,
reading a file. A name that does not answer holds its thread for the whole of
the resolver's timeout, and a mailbox with a dozen or two slow-to-resolve
senders on screen was enough to put every thread in the pool on one at once.

Once that happened, the click on another app was an ordinary request like any
other on the server, and it queued behind the same four threads - which is why
it looked like the switcher, not Mail, and why reloading (a fresh request that
eventually got a thread) always "fixed" it.

## The fix

`concurrency-gate.ts` is new and holds two primitives used at both ends of the
chain: a `Gate` that lets at most `max` tasks run at once and queues the rest,
and a shared flight that turns several concurrent asks for the same key into
one. `safe-fetch.ts`'s name resolver now runs through a gate of two - leaving
two of the four pool threads free for the rest of the server - and dedupes a
hostname asked for twice while the first lookup is still out. The face route
dedupes and bounds hunts the same way, per domain, so a hundred messages from
one shop are one hunt rather than a hundred.

A follow-up review pass added a deadline to both: a caller waiting behind a
full gate or an in-flight resolution now gives up after a bound instead of
waiting forever, and a wait that every caller has abandoned is cancelled
rather than left to run for nobody - the gate takes the task out of its queue,
and a shared lookup with no callers left has its own lookup aborted.

## What stops it coming back

`concurrency-gate.test.ts` asserts the gate never runs more than `max` tasks at
once, that a shared flight collapses concurrent callers into one run, and that
both cancel cleanly once every caller has given up. `safe-fetch-lookups.test.ts`
asserts `resolveName` never exceeds `LOOKUP_SLOTS` concurrent `dns.lookup`
calls and dedupes a hostname asked for twice at once.

## The general rule

A request handler that reaches out to an address nobody chose is spending a
resource the whole server shares, not a cost paid only by the request that
asked for it. Anywhere a page can ask for several of those at once - a row per
message, a tile per sender - the fan-out has to be bounded and deduplicated at
the point where it leaves the process, not left to however many rows are on
screen.
