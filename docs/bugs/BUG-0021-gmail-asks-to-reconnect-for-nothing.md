---
id: BUG-0021
title: A Gmail mailbox asks to be connected again when its authorization still works
status: fixed-watching
area: mail
location: dashboard/apps/web/src/lib/mailbox/credentials.ts
related:
  - dashboard/apps/web/src/lib/mailbox/imap.ts
  - dashboard/apps/web/src/lib/mailbox/send.ts
  - dashboard/apps/web/src/lib/mailbox/refusals.ts
  - dashboard/apps/web/src/lib/mailbox/refused.ts
  - dashboard/apps/web/src/lib/mailbox/sync.ts
  - dashboard/apps/web/src/app/(app)/mail/settings/accounts/accounts-view.tsx
  - dashboard/packages/db/prisma/migrations/20271231000000_mail_grant_refused/migration.sql
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(mail): an authorized mailbox gets a fresh token before anybody is asked to reconnect it"
---

## What was seen

Every so often Polaris sent "<address> needs connecting again - Its
authorization was refused or withdrawn, so Polaris paused checking it" for a
Gmail mailbox. Pressing Reconnect asked nothing (no Google consent screen) and
the mailbox worked again straight away, so the stored authorization had been
fine all along.

## Cause (confirmed in code)

An authorized mailbox logs in to IMAP and SMTP with an access token that is
cached in memory for most of an hour (`googleAccessToken`,
`microsoftAccessToken`). When Gmail turned that token away - a token it had
dropped early, or one of its occasional `AUTHENTICATIONFAILED` answers to a good
one - the chain was:

1. `openImap` / `sendMime` read the refusal as `MailAuthError` on the first
   answer, without asking Google whether the grant still worked.
2. `recordCredentialRefusal` paused the mailbox (`state = "auth"`).
3. `refusalCause` returned `authorization` for every authorized mailbox, with
   none of the "is it the server?" checks a password mailbox gets, so the bell
   rang at once.
4. The paused mailbox then waited a backoff of 30 minutes up to a day before it
   was tried again by itself.

A forced try (Reconnect, or Try now) minted a token or logged in again and
worked, which is what the owner saw.

## Fix

- `withMailCredential` (`credentials.ts`) runs every IMAP and SMTP login. For
  an authorized mailbox whose login is refused it drops the cached token, asks
  the provider for a fresh one, and logs in once more. Password mailboxes are
  tried once, as before.
- `MailAuthError.grantRefused` says whether the provider refused the grant
  itself (`invalid_grant`, consent or sign-in required, client gone, or no link
  or refresh token left). A refused refresh with any other reason
  (`temporarily_unavailable`, `server_error`) is a retry, never a refusal.
- The flag is stored on the mailbox (`MailAccount.grantRefused`).
  `refusalCause` only calls an authorized mailbox `authorization` - the bell,
  the rail and the account list's "reconnect" - when it is set. A fresh token
  the server still turns away pauses the mailbox quietly as "recent" ("may be
  the server, Polaris tries again by itself").
- An authorized mailbox in `auth` is retried every 30 minutes instead of on the
  backoff of up to a day; a working pass clears the flag and settles the notice
  (`recordAccountState` -> `settleRefusalNotices`).
- Retroactive: the migration backfills the flag for mailboxes paused today, set
  for every authorized mailbox whose recorded refusal is not the mail server's
  own. Mailboxes paused by the server's refusal (this bug) become quiet and are
  retried within half an hour, which ends their notice once they log in.

## Verified

- `test/mail/oauth-refusal-checks-the-grant.test.ts`: a refused token is
  followed by a fresh one and a second login; a refused fresh token is a quiet
  refusal; `invalid_grant` on the refresh is the owner's; an unreachable token
  endpoint and a dropped socket are never refusals; a password mailbox is
  refused on the first answer.
- `test/mail/refused-mailbox.test.ts`, `refusal-cause.test.ts`,
  `oauth-token-failure.test.ts`: only a refused grant rings the bell, the
  30-minute retry for authorized mailboxes, the reason-based reading of a
  refused refresh.
- `npm run build` of the dashboard, and `prisma migrate diff` against the
  schema for the new column.

## Not verified

- Against a live Gmail account: the exact moments Gmail refuses a cached token
  were not reproduced. The fix does not depend on why it refuses.
- The migration was not applied to a running database (no Postgres or Docker
  on the development machine).

## If it happens again

Collect the mailbox's row (`state`, `stateDetail`, `grantRefused`,
`refusedSince`, `lastRefusedAt`) and the dashboard log lines starting with
`mail sync failed` or `polaris: google did not answer a mail token request`
around the notification's time. A notice with `grantRefused = true` means
Google itself refused the refresh token; one without it should not exist.
