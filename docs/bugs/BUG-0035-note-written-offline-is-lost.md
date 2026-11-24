---
id: BUG-0035
title: A note written while Polaris is unreachable is never saved, and is gone on reload
status: partly-fixed
area: dashboard / offline
location: dashboard/apps/web/src/app/(app)/notes/notes-view.tsx
related:
  - dashboard/apps/web/src/lib/offline/outbox.ts
  - dashboard/apps/web/src/lib/offline/write-queue.ts
  - dashboard/apps/web/src/lib/offline/app-writes.ts
  - dashboard/apps/web/src/app/(app)/notes/offline-writes.ts
  - dashboard/apps/web/src/lib/notes/note-service.ts
  - dashboard/apps/web/src/components/offline-writes.tsx
  - dashboard/apps/web/test/offline/note-writes.test.ts
  - dashboard/apps/web/test/notes/note-text-save.test.ts
reported: 2026-11-23
fixed: 2026-11-24
fix_commit: "feat(offline): a note written offline is kept on the device and saved when Polaris is back"
---

## What was seen

With the host unreachable, the notes opened from the device (BUG-0033), but
typing into one showed "The request could not be completed" after every pause.
The text lived only in the open tab: a reload, a closed laptop or a crashed tab
lost it.

Expected (owner, like WhatsApp): what is written offline stays on the device,
looks saved, and is sent when the connection comes back.

## Cause (confirmed in code)

The autosave called `updateNoteAction` directly and only showed the rejection.
Only the chat had a queue of unsent writes (`lib/chat/offline/outbox`), and it
was chat's own.

## Fix

One write queue for every app (IndexedDB outbox with client keys, replayed in
order, the technique WhatsApp Web and Linear use):

- `lib/offline/outbox` - the ordering rules, shared: oldest first, the first one
  that finds no server stops the rest, a refusal or five unanswered attempts
  marks an entry failed for the reader. Chat's outbox is now one kind of it.
- `lib/offline/write-queue` - the device half: kept in the account's own local
  store, one tab drains at a time under a Web Lock, flushed on open, when the
  network returns, when Polaris answers again after not answering, and when the
  app comes back to the foreground.
- `lib/offline/app-writes` - the queue notes (and next documents and tasks)
  share, in `polaris-offline`. Bounded (2,000 writes, a year), never made
  unreadable by an update, dropped on sign-out with the rest of the account.
- Notes: the autosave keeps the text on the device first, then sends it. Only
  the newest text of a note waits. A reload opens the note with the unsent text.
  The status line shows a clock and "Saved on this device" while it waits.
- Conflicts: each save carries the note's version the device last saw (its own
  earlier writes included). The server writes only over that version, in one
  statement (`saveNoteText`). If the note changed elsewhere, both are kept: the
  device's text becomes a note of its own beside it, with the write's key as its
  id so a replay never makes a second copy, and the screen links to it. Where
  the reader cannot add notes (a note shared to edit), the save is shown as a
  conflict with "Keep mine" and "Discard mine".

## Not fixed here

- Documents and tasks are not on the queue yet.
- Text typed less than a second before the tab closes (inside the autosave
  pause) is not kept.
- Creating, moving or deleting a note offline still needs the host.
