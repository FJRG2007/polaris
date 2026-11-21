---
id: BUG-0003
title: Polar's messages are named "somebody who has left", and its delete preview has no face or AI tag
status: fixed-watching
area: chat / message authors
location: dashboard/apps/web/src/lib/chat/author-name.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/author-face.tsx
  - dashboard/apps/web/src/app/(app)/chat/delete-message.tsx
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(chat): Polar, apps and webhooks are named and drawn as themselves wherever a message of theirs is shown"
---

## What was seen

- A reply quoting one of Polar's answers said "somebody who has left" above
  the quote.
- Deleting one of Polar's messages showed a preview with initials instead of
  Polar's face, and without its AI tag.

## Cause (confirmed in code)

The message list named an author from the account (`authorId`) or, for a
message with no account (Polar, an app, a webhook), from its `authorLabel`. The
other places that show a message second-hand - a reply's quote, a reference
card, a toast, a report - read only the account, so every message no account
wrote came out as somebody who had left. The delete preview drew every author
as a person's avatar and never drew a tag.

## Fix

- `authorNameOf` (`lib/chat/author-name.ts`) is the one rule, used by the
  message list, quotes, reference cards, toasts and reports.
- `AuthorFace` and `AuthorTag` (`author-face.tsx`) draw Polar, an app and a
  webhook as themselves; the delete preview and the message list share them.

## Verified

- `test/chat/author-name.test.ts` and a delete-preview test that renders a
  Polar message: its name and AI tag, never "somebody who has left".
- Chat, Polar and i18n suites pass.

## Not verified

- Not watched in a browser.

## If it happens again

Say where the name was wrong (a quote, a search result, a pin, a toast, a
report) and who wrote the message (Polar, an app, a webhook). A place not
listed above reads the author some other way and should use `authorNameOf`.
