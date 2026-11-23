---
id: BUG-0029
title: Typing @ in a group DM shows only Polar, @here and @everyone at first
status: fixed-watching
area: chat
location: dashboard/apps/web/src/components/rich-text/suggestion.tsx
related:
  - dashboard/apps/web/src/components/rich-text/rich-text-editor.tsx
  - dashboard/apps/web/src/app/api/mentions/search/route.ts
  - dashboard/apps/web/src/app/(app)/chat/known-people.ts
  - dashboard/apps/web/src/app/(app)/chat/channel-view.tsx
  - dashboard/apps/web/src/app/(app)/chat/thread-panel.tsx
  - dashboard/apps/web/src/app/(app)/chat/meeting-chat.tsx
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(chat): a message goes out at once, the @ list starts from who is here, and the phone docks it"
---

## What was seen

Typing @ in a group DM listed only Polar, @here and @everyone; the members
appeared only after several tries and some waiting.

## Cause (confirmed in code)

The picker had nothing of its own to draw: the first list was the room words
plus the last search answer, which on the first "@" is empty, so everything
waited on `searchMentionsAction`. That was a server action, and typing "@" also
sends the typing ping (`typingAction`), so the search queued behind it and
behind any other action or refresh in flight. Meanwhile the page already held
the conversation's members (`channel.others`), the authors on screen and, in a
call, the roster.

## Fix

- The search goes through `POST /api/mentions/search` (runs
  `searchMentionsAction` unchanged), so it never queues.
- `RichTextEditor` takes `knownPeople`; the @ list draws them at once
  (`mergeKnown`) and a search answer only replaces their line in place and
  appends people not yet known - it never removes or reorders a known row.
- Sites changed for "use what the page already has":
  - `channel-view.tsx` (DM, group DM, server channel, forum channel):
    `channel.others` + authors on screen, most recent first.
  - `thread-panel.tsx` (threads and forum posts): the root's author + replies.
  - `meeting-chat.tsx` (meeting chat): admitted call participants + line authors,
    before `mentionsInMeetingAction` answers.
- Checked, not changed in this change (reported as remaining): channel "#"
  (no "#" channel picker exists; "#" finds tasks/docs/notes, which the page does
  not hold), "who reacted", forward/share targets, member lists and the person
  card were not audited in the time available.

## Verified

- Unit: `test/rich-text/mention-known.test.ts` (`mergeKnown`, `seededPeople`,
  `knownPeopleOf`).
- Not exercised: a live group DM in a browser.
