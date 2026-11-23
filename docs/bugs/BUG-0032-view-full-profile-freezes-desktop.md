---
id: BUG-0032
title: In Polaris desktop, pressing "View full profile" in a direct message froze the window for a while
status: open-not-reproduced
area: chat
location: dashboard/apps/web/src/app/(app)/chat/profile-details.tsx
related:
  - dashboard/apps/web/src/app/(app)/chat/person-card.tsx
  - dashboard/apps/web/src/app/(app)/chat/direct-profile.tsx
  - dashboard/apps/web/src/app/(app)/chat/profile-activity-pane.tsx
  - dashboard/apps/web/src/lib/chat/profiles.ts
reported: 2026-11-23
fix_commit: "feat(chat): every name in a call, a meeting, pins, search, a forum and a member list opens the same card"
---

## What was seen

In the desktop app, in a direct message, pressing "View full profile" in the
column beside the conversation left the window unresponsive for a while with the
busy cursor. The owner could not say whether something else on the machine was
busy at the same moment.

## What the button does (confirmed in code)

It does not navigate. It opens `PersonProfileDialog` (`person-card.tsx`) over
the conversation, which asks `/api/chat/profile` again with `recent=1`. On the
server that is `chatProfile` (`lib/chat/profiles.ts`): the reader's access to the
conversation, the person, the block list and two privacy checks in parallel,
then mutuals, role, friendship, badges and `recentActivityFor` in parallel. The
dialog draws `ProfileDetails` at full size and `ProfileActivityPane`; the mutual
lists are bounded server-side (they come back with a total, not every row). The
only link on it, to `/u/<username>`, is a `next/link` that prefetches the page
in the background.

Before this change the dialog started from nothing: the column beside the
conversation had already read the profile, but the dialog's read used a
different request (`recent=1`) and showed skeletons until it answered.

## Measured

Nothing. It was not reproduced and not traced: the development machine has no
Docker and no database, so a production build cannot be served with a signed-in
session to open a direct message in, and a headless performance trace of the
dialog was not taken. No cause is confirmed. Nothing in the code path above does
synchronous work proportional to anything unbounded on the client.

## What was changed

`useChatProfile` keeps the last answer for each person and place for the
session (bounded to 200 entries, refusals never kept) and draws it at once,
reading again in the background. The larger view starts from the card's or
the column's answer and only waits for what they did lately. Opening it now
draws the whole profile immediately instead of a skeleton.

## If it happens again

Collect, from the desktop app's developer tools on the frozen window: a
Performance recording across the press (long tasks and what they are), the
Network panel's `/api/chat/profile` timing, and the machine's CPU use at the
time. A long task on the main thread points at the client; a slow request with a
responsive window points at the server reads listed above.
