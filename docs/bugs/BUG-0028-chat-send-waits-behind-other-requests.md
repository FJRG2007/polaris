---
id: BUG-0028
title: A message with a link is not shown as sent until its preview has loaded
status: fixed-watching
area: chat
location: dashboard/apps/web/src/app/(app)/chat/outbox.ts
related:
  - dashboard/apps/web/src/app/api/chat/send/route.ts
  - dashboard/apps/web/src/lib/chat/link-preview.ts
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(chat): a message goes out at once, the @ list starts from who is here, and the phone docks it"
---

## What was seen

On the web version on an iPhone, a message containing a link stayed on its
clock (not sent) until the link's card had loaded, and the card took a long time.

## Cause (confirmed in code)

Two separate things.

1. **The send queued behind other requests.** The message is drawn at once
   (optimistic draft), but it is marked sent only when `sendAction` answers, and
   `sendAction` was a Next server action. A tab's server actions run one at a
   time, behind its navigations, so the send waited for whatever the screen had
   sent before it: the typing ping fired while writing, read marks, and the
   `router.refresh()` that follows every send. The server itself never waited on
   the preview (`unfurlLater` is not awaited in `messages.send`).
2. **The card fetched the page twice.** `unfurlLater` (the warm-up the send
   starts) and `linkPreviewFor` (the reader's own screen asking a second later)
   each read the whole page and the site's oEmbed independently, racing for the
   same site, so the card waited on the slower of two identical fetches.

Not confirmed: which exact request was in the queue on the owner's phone; the
mechanism is confirmed in code, the specific request was not observed.

## Fix

- The send goes through a route, `POST /api/chat/send` (`actionRoute`, which
  runs `sendAction` unchanged: same validation, permission and idempotency key).
  `outbox.ts` (`postMessage`) uses it for the outbox drain and the direct send,
  so thread answers go the same way.
- `unfurl` joins a look already running for the same address in this process
  (`joinLook`), so the reader's request waits on the warm-up instead of fetching
  again.

## Verified

- Unit: `test/rich-text/mention-known.test.ts` (shared with BUG-0029/0030);
  existing `test/chat/link-preview.test.ts` and `test/chat/offline/outbox.test.ts` pass.
- `tsc --noEmit` on apps/web: 0 errors.
- Not exercised: a real iPhone, and the queue on a live server (no Docker here).
