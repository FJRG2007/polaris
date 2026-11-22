---
id: BUG-0019
title: A conversation you are reading, or have just answered, stays unread for a while
status: fixed-watching
area: chat
location: dashboard/apps/web/src/lib/chat/read-marks.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/channel-view.tsx
  - dashboard/apps/web/src/app/(app)/chat/chat-context.tsx
  - dashboard/apps/web/src/app/(app)/chat/chat-shell.tsx
  - dashboard/apps/web/src/app/(app)/chat/chat-sidebar.tsx
  - dashboard/apps/web/src/components/chat-unread.tsx
  - dashboard/apps/web/src/lib/chat/chat-service.ts
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: "fix(chat): a conversation you are reading stops counting as unread the moment you are in it"
---

## What was seen

With a conversation open, and even after replying in it, its unread badge in
the conversation list, the Chat entry's count and the tab icon took a noticeable
moment to go away.

## Cause (confirmed in code)

No unread number was ever changed on the client. Every one waited for the
server to count again, at the end of this chain:

1. The open conversation sent the read as a server action
   (`markReadAction`). The App Router runs server actions one at a time, so
   the read queued behind whatever the screen had in flight - the message
   page load (`readChannelAction`), a send (`sendAction`), the list refresh
   (`listChannelsAction`).
2. The server wrote the mark and published a `read` frame on the live channel.
3. The rail waited out `CHANNELS_SETTLE_MS` (300 ms), then asked for the list
   again through `listChannelsAction` - another queued action.
4. The app-wide badge (`ChatUnreadProvider`) waited out its own 400 ms settle,
   then fetched `/api/chat/unread`.

A message arriving while the conversation was open was worse: the `posted`
frame made the rail and the badge count it first (the read had not been sent
yet), so the badge came up and only went back down after the whole chain above.
A reply moved the server's mark past everything but announced no `read`, so the
count fell only on the `posted` refresh, behind the same queue.

## Fix

`lib/chat/read-marks.ts` holds what this tab has read ahead of the server:

- **A mark per conversation** - the newest message read, by the server's own
  timestamp. A count whose conversation has nothing newer than the mark is
  drawn as zero, so the rail and the totals drop it in the same frame, and a
  stale list or count that set off before the read cannot bring it back (the
  mark only moves forward).
- **Being read now** - the open conversation registers a check (at the newest
  line, tab visible and in front, not put back to unread from here). While it
  holds, that conversation is never counted, whichever request answers first,
  so an arriving message never bumps it. A hidden tab still counts.
- The read goes to the server through `POST /api/chat/channels/:id/read` (a
  plain request, not the action queue), one at a time per conversation and only
  the newest asked for; a refusal puts the mark back to the last read the
  server took.

Wired into: the rail (`ChatProvider` settles each conversation's count), the
app-wide totals (`ChatUnreadProvider` settles against a new `waiting` list the
server now sends with the totals, newest 200 conversations, additive), the
tab icon, the app switcher, the rail entry and the phone tabs (all read the
same totals). Sending a message reads everything on screen first. "Mark as
unread" (from the list, the message menu, or a `read` frame with
`unread` from another device) drops the mark. Other tabs and devices still
clear on the server's `read` / `posted` frames, as before.

Mail already had its own optimistic overlay (`lib/mailbox/unread-overlay`);
Tasks keeps no unread count. Neither needed this change.

## Verified

- `test/chat/optimistic-read.test.ts`: clear on open, own send clears, an
  arriving message while reading never bumps, a stale answer does not bring the
  badge back, a refusal rolls back (to the last confirmed read), reads coalesce,
  a whole-conversation read is undone on refusal, "Mark as unread" drops the
  mark.
- `tsc`, the chat test folder and a production build.

## Not verified

- Not exercised in a running deployment or a browser; the timing is reasoned
  from the code path above.
- A conversation whose newest activity is a thread reply has a `lastMessageAt`
  past the mark, so a stale count for it after leaving falls back to the
  server's number until the read lands (the old behaviour, briefly).

## If it happens again

Note whether the tab was in front, whether the reader was at the newest line,
and whether the badge that lingered was the list row, the Chat entry or the tab
icon. In the browser's network panel, check that `POST /api/chat/channels/<id>/read`
answered 204 and how long `/api/chat/unread` and the list request took.
