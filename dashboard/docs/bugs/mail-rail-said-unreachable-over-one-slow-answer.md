# The mail rail said "cannot reach this mail server" over one slow answer

**Found:** October 2026. **Fixed in:** `dashboard/apps/web/src/lib/mailbox/imap.ts`,
`dashboard/apps/web/src/lib/mailbox/refusals.ts`,
`dashboard/apps/web/src/lib/mailbox/sync.ts`,
`dashboard/apps/web/src/lib/mailbox/accounts.ts`,
`dashboard/apps/web/src/lib/cron/jobs.ts`.
**Guarded by:** `apps/web/test/mail/one-timeout-is-not-an-outage.test.ts`.

## What was seen

A Gmail mailbox that had synced a minute earlier would, every so often, show
"Polaris cannot reach this mail server" on the rail - and then sync normally
again on the very next pass. Read on its own, the message said the server was
down; read against the mailbox's own history, the server had been fine the
whole time.

## What it actually was

Two things stacked on each other.

First, every IMAP connection shared one socket timeout, sixty seconds, on the
strength of a comment that turned out not to hold: "a server that has not
answered a single command in a minute is not going to." Gmail answers the
odd `FETCH` or `STATUS` a minute and more late on an ordinary day, with
nothing else wrong - and at sixty seconds, that one slow command threw away
the whole pass and recorded the mailbox as unreachable, which is what the
rail read from.

Second, a mailbox that failed for any reason at all - including that one slow
command - was marked `unreachable` on the spot, with nothing between "it
answered" and "it didn't" for the rail to read. A connection dropped half way
through a sync and a server that had actually gone away looked identical
after a single pass.

The scheduled sweep made the second part worse than it had to be: mailboxes
were synced one after another, so a server that really was slow to answer
held up its own connection for the full timeout before the next mailbox in
the queue even started.

## The fix

The socket timeout is now five minutes during an ordinary sync pass (the
account-check form, which a person is actively waiting on, keeps the short
one). A failed pass is only written to the rail as `unreachable` once the
mailbox has kept failing past a grace period (`failureIsNews`,
`UNREACHABLE_GRACE_MS` = 15 minutes) or never worked in the first place; a
failure still inside the grace only records that a pass was tried
(`recordAccountAttempt`), which keeps the mailbox's own retry interval
instead of being retried on the very next tick. The scheduled sweep
(`syncMailboxes`) now works a few mailboxes at a time instead of one after
another, so one slow server no longer holds up everybody else's mail behind
it in the queue. The failure log line also records which step of the pass was
running and for how long, so a report of "it failed" says whether that was
the login, the folder list, or one folder's fetch.

## What stops it coming back

`one-timeout-is-not-an-outage.test.ts` asserts `failureIsNews` stays quiet
over one failed pass of a mailbox that was working, reports it once the
grace has passed, and reports it at once for a mailbox that never worked or
is already shown as unreachable.

## The general rule

A comment that states a server's behaviour as a fact ("not going to answer
after X") is a claim about a system Polaris does not control, and providers
change without telling anybody who wrote that comment. Treat a slow but
occasional answer as weather, and only turn a repeated one into an incident
after it has stayed bad for longer than any one provider's odd day - and keep
the two states, "trying" and "reporting", recorded separately so the second
can wait on the first instead of being written on each attempt.
