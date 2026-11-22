---
id: BUG-0018
title: The conversation list shows an older chat above one with a newer message
status: fixed-watching
area: chat
location: dashboard/apps/web/src/lib/chat/conversation-list.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/chat-context.tsx
  - dashboard/apps/web/src/app/(app)/chat/chat-sidebar.tsx
  - dashboard/apps/web/src/app/(app)/chat/chat-shell.tsx
  - dashboard/apps/web/src/app/(app)/chat/use-chat-stream.ts
  - dashboard/apps/web/src/lib/shared-stream.ts
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: "fix(chat): the conversation list stays in order of the latest message, also after a phone wakes up"
---

## What was seen

On a phone, in the web app, the direct messages list had a conversation whose
last message was from 6 pm at the top, and below it one whose last message was
a minute old. Reloading the page put them in the right order.

## Cause

Three things, any of which leaves the list out of order:

- **Nothing caught up after the tab slept.** The list only moved on a stream
  frame (`posted` -> `refreshChannels`). A phone suspends a background tab and
  drops its event stream; `EventSource` reconnects on its own when the screen
  comes back, but the server does not replay what was sent meanwhile and
  nothing on the client read the list again. Every message from that gap left
  its row where it was until a reload.
- **The newest answer was whichever arrived last.** A full refresh
  (`/api/chat/lists`) and the conversations-only read (`listChannelsAction`)
  both replaced the whole list. A slow read asked for before a message landed
  could arrive after a newer one and put the old order back.
- **The order and the row read different fields.** The rail sorted by the
  channel's `lastMessageAt`, but the time and preview on a direct message or
  group row come from `last` (the newest top-level message this reader can
  see). A thread reply, a whisper meant for somebody else, a message that
  vanished or one hidden for this reader moves the first and not the second,
  so a row could sit on top showing an old message. This one survives a
  reload, which is why it was fixed alongside the others.

## Fix

- `lib/chat/conversation-list.ts` holds the list: one sort key, `activityAt`
  (`last.at`, falling back to `lastMessageAt` where no message is drawn), used
  by the rail, the server rail's "newest conversation" pick and the activity
  invite list.
- Every read takes a ticket when it is sent; an answer older than the one on
  screen is dropped, so a stale response never moves a row back.
- The list is read again when the tab returns after being hidden for 5 s or
  more, on `pageshow` from the back-forward cache, on `online`, and whenever
  the shared stream reopens after a gap (`subscribeSharedStream` gained an
  `onReopen` callback, relayed to the other tabs of the device).

## Verified

- `test/chat/conversation-list-order.test.ts`: order after an incoming
  message, after an own send, after a stale response, and after a reconnect.
- `test/chat/conversation-list-live.test.tsx`: the provider reads again on a
  wake-up and on `online`, not on a quick look away, and keeps the newer order
  when an older read lands last.
- `test/notifications/shared-stream.test.ts`: the reopen signal.

Not verified on a real phone.

## If it happens again

Note how long the phone was locked, whether the stream reconnected (the
connection banner), and whether the wrong row's preview also looked stale. A
wrong order that survives a reload points at the server's `last` row, not the
client.
