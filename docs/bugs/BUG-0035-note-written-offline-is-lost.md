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

## The last second before the tab closes (2026-11-24)

A note saves 0.8 s after typing stops and the device store answers
asynchronously, so text typed in that pause was lost when the tab closed. What
a screen holds unsaved is now written synchronously to localStorage when the
page is hidden or closed (`keepOnUnload` in `lib/offline/app-writes`), moved
into the queue the next time any Polaris page opens for that account, replaced
by any later save of the same note so older text never comes back, and dropped
on sign-out. Leaving a note for another note or screen saves it at once.

## Documents (2026-11-24)

The office editors (`office/use-office-document.ts`) keep every change on the
queue first (`office/offline-writes.ts`, kind `office.update`). A change is a
Yjs update, so what waits for a document is merged into one update and needs
no conflict copy: applied twice or beside somebody else's it gives the same
document. A reopened document shows the changes still on the device; the text
editor says "Saved on this device" while they wait, and "Try again" when the
server refused them or did not answer five times. A 5xx or 429 answer is
retried; any other 4xx is shown as not saved. What a closing tab left is put
beside what already waited, never over it.

## Chat edits, reactions and deletes

An edit, a reaction or a delete that finds no server is kept in the chat's
own outbox line (`app/(app)/chat/outbox.ts`, `changeMessage`), behind the
messages and changes already waiting, and sent in order when Polaris answers.
The row is drawn with the change meanwhile, with the same clock a waiting
message has (`withChanges`); one the server refuses goes to the not-sent bar
with "Send again" and "Delete". An edit behind an edit, or the same reaction
behind itself, replaces the waiting one; a delete takes what waited for its
message with it. A reaction is sent as the state wanted (`on`), not a press,
so sending it twice never takes it back. A sealed message's edit is sealed
again through the device's MLS group when it is sent, from the version it
replaced.

The words of everything waiting in the chat outbox (messages and edits) are
sealed at rest under a non-extractable AES-256-GCM key kept in the same store
(`lib/offline/at-rest.ts`), dropped with it at sign-out. Where the browser has
no WebCrypto and sealed chat is on, nothing is kept: the message is sent at
once, as before. Entries kept in the clear by an earlier version still send.

Spreadsheets, slides and drawings now show the text editor's saving line
(`office/saving-note.tsx`).

## Not fixed here

- Sharing, publishing, exporting or saving as a template a note the server
  does not have yet still needs the host.

## Making, moving and deleting notes offline

A note made, moved or deleted while Polaris cannot be reached is kept on the
device (`notes/offline-writes.ts`, kinds `note.create`, `note.move`,
`note.delete`) and sent in order when Polaris answers. A note made here carries
its id (`noteCreateSchema.id`), so a replay after a lost answer makes it once; a
replayed delete of a note already gone answers done. The tree draws the kept
writes over what the server sent (`notes/offline-tree.ts`) with a clock, or an
alert when Polaris refused one, and a note made offline opens from the device.

## Renaming, pinning and archiving offline; templates

A note renamed in the tree, pinned, unpinned, archived or restored while
Polaris cannot be reached is kept as `note.update` with the values it ends with
(never a toggle), folded into a change waiting right before it, and drawn at
once: renamed, pinned to the top, out of the tree or out of the archive. A
move or change of a note made here waits behind its create instead of being
folded into it, since a create already on its way would be sent without it,
and a delete of such a note is kept and sent even though its create is
dropped, for the same reason; a delete of a note that is not there answers
done.

A note made offline from a template now starts from it: each visit to Notes
keeps the title and text of the templates it lists on the device
(`notes/offline-templates.ts`, one request for the ones whose version changed,
none otherwise), and the note made offline is drawn from that copy. The server
still applies the template when the note reaches it.

## Mail sent offline

A message sent while Polaris cannot be reached (no answer, or the proxy's
502/503/504) is kept on the device (`mail/offline-sends.ts`, kind `mail.send`)
instead of failing in the composer, which closes as on any send and says so.
It waits above the mailbox with a clock (`mail/kept-sends.tsx`), or with
Polaris's reason, Try again and Discard when it was refused, and goes into the
server's outbox when Polaris answers, from whichever screen is open. Each kept
send carries a key of its own (`sendKey` on `mailComposeSchema`); the server
claims it before queueing (`queueSendOnce`, table `MailSendKey`, kept 30 days),
so a replay whose answer was lost is answered with the message already queued
and it goes once. Once taken it waits out the reader's undo window like any
send. Files cannot be attached offline.

## Mail drafts closed offline

A draft closed while its save could not reach Polaris used to be lost with the
composer. Now whatever the server does not hold yet (`DraftSaves.pending`) is
kept on the device (`mail/offline-drafts.ts`, kind `mail.draft`, newest words
only per draft), and so is what a tab closed mid-draft held (`keepOnUnload`).
It sits above the mailbox with a pencil, can be opened again (the kept copy
leaves the queue and the composer saves it from there, files and From
included) or discarded, and is saved to Drafts when Polaris answers. A new
message carries the composer's key (`draftKey` on `mailDraftSchema`):
`saveDraftOnce` claims it in `MailSendKey`, so a save repeated after a lost
answer writes over the same draft, and a draft that has since been queued or
sent is left alone rather than put back to being a draft. A save the composer
gets through itself, or a send, forgets any older kept copy.
