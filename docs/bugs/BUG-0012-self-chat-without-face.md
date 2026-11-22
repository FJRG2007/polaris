---
id: BUG-0012
title: The conversation with yourself shows initials instead of your picture
status: fixed-watching
area: chat
location: dashboard/apps/web/src/app/(app)/chat/conversation-face.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/chat-sidebar.tsx
  - dashboard/apps/web/src/app/(app)/chat/channel-header.tsx
  - dashboard/apps/web/src/app/(app)/chat/conversation-info.tsx
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: 2f5c5007d6 "fix(chat): the conversation with yourself shows your own picture and decorations"
---

## What was seen

The conversation with yourself ("Name (you)") was drawn with generic initials,
with no profile picture and no decorations.

## Cause (confirmed in code)

A conversation is drawn as one person when exactly one other person is in it.
The conversation with yourself has nobody else in it, so its list of others is
empty and it fell through to a group's initials.

## Fix

One rule, `conversationFace()`: a one-to-one is the person on the other end;
the conversation with yourself is the reader. The conversation list (with
decorations), the header and the conversation's info use it.

## Verified

- `test/chat/conversation-face.test.ts`, the 23 suites that read the three
  screens, and the web typecheck.

## Not verified

- Seen on screen after the next dashboard update.

## If it happens again

Which screen it is on, and whether the conversation is marked `self` in the
conversation list the browser receives.
