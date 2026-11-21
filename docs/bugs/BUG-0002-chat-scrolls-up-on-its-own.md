---
id: BUG-0002
title: A conversation scrolls up into older messages on its own
status: fixed-watching
area: chat / message list
location: dashboard/apps/web/src/app/(app)/chat/channel-view.tsx
related:
  - dashboard/apps/web/src/app/(app)/chat/reading-position.ts
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(chat): the conversation no longer scrolls up into older messages on its own"
---

## What was seen

Reported by the operator and by users: every so often, a conversation jumps up
to older messages without anybody touching it.

## Cause (confirmed in code)

Two separate ways the list moved the reader:

1. **The anchor counted the wrong change.** When a page of older messages is
   loaded into a window that is already full (`MAX_WINDOW`), the newest messages
   are trimmed off the bottom at the same time, and loading newer messages trims
   the top. The reader was put back by the change in the list's
   `scrollHeight`. That difference counts the part that was added and the part
   that was let go of, so the reader moved by exactly the trimmed part. Loading
   older messages therefore sent them up.
2. **A stale reading position.** The line the reader was on (`readingAt`) was
   remembered the last time they were away from the bottom, and nothing cleared
   it while they followed the end. Later, when the list had grown or been
   trimmed under that line, their first scroll away from the bottom put the old
   line back and jumped them by the difference.

## Fix

- Loading a page now saves the line the reader is on (`readingPosition`) and
  scrolls that line back to where it was (`keepReading`), whatever was added or
  trimmed above or below it.
- `readingAt` is cleared while the reader follows the end, and is read fresh
  the moment they leave it.

## Verified

- Regression test in `test/chat/reading-position.test.ts`: a page arrives above
  while the same height is let go below, and the reader stays on the same line.
- The chat suites pass (483 files).

## Not verified

- Not reproduced or watched in a real browser. jsdom has no layout, so the tests
  fake row positions.
- Other things that could move the list are not ruled out: a focus without
  `preventScroll` inside a message, `scrollIntoView` from a nested panel, or the
  viewport resizing (phone keyboard, call band).

## If it happens again

Collect:

1. Desktop or phone, the browser, and whether a call, a thread or search was
   open.
2. What was happening: idle at the bottom, reading further up, a message just
   arriving, an image or link preview just loading, returning to the tab.
3. How far it jumped (a few lines, or a page or more) and whether it settled
   back.
4. The conversation's size: a busy one past 200 loaded messages trims the
   window, which was the first cause.

A page or more points at the window being trimmed (`loadOlder` / `loadNewer` /
`catchUp`). A few lines point at the reading position or at content changing
height.
