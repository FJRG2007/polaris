---
id: BUG-0077
title: Account > Add a successor accepts your own additional address as a search and still asks for a code
status: fixed-watching
area: account
location: dashboard/apps/web/src/lib/successor-service.ts
related:
  - dashboard/apps/web/src/app/(app)/account/security/successor-card.tsx
  - dashboard/apps/web/src/app/(app)/account/security/successor-actions.ts
  - dashboard/apps/web/src/app/(app)/account/step-up-actions.ts
  - dashboard/apps/web/test/account/successor-self.test.ts
  - dashboard/apps/web/test/account/successor-dialog.test.tsx
reported: 2026-11-28
fixed: 2026-11-28
fix_commit:
---

## What was seen

Typing one of the account's own additional email addresses into "Search by
username, full name, or email address" answered that no account matches, yet the
dialog still offered the confirmation code, sent it, and showed "Add successor".

## Cause

The dialog had no lookup: the typed text was a plain field, the confirmation code
was requested as soon as the dialog opened, and the text was only resolved on
submit, after the code was checked. The resolver compared the text with the
primary address and proved additional addresses, so an unproved own address
matched nothing, and the "you cannot succeed yourself" refusal only existed after
the code had been sent and spent.

## Fix

A lookup (`lookupSuccessor`) answers before anything else: it is you (primary
address, any additional address proved or not, username, or a name only you
carry), nobody, ambiguous, or one other account, shown by name and handle only.
The code, the consent text and the add are offered only for that other account;
the add button stays focusable and says why it is unavailable. The code is minted
per picked account and the server refuses to send it for the caller's own id or
an unknown one. The add re-resolves what was typed, refuses the caller's own id
whichever identifier led to it, and refuses an id the text did not resolve to,
all before the proof is checked.
