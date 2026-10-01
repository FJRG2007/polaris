# A picture in chat said "0 seconds left" and never arrived

**Found:** October 2026. **Fixed in:**
`dashboard/apps/web/src/lib/storage-target.ts`,
`dashboard/apps/web/src/lib/storage-alert.ts`,
`dashboard/apps/web/src/lib/storage-refusal.ts`,
`dashboard/apps/web/src/components/transfers/move-file.ts`,
`dashboard/apps/web/src/app/(app)/chat/outgoing.tsx`,
`dashboard/apps/web/src/app/(app)/chat/composer.tsx`,
`dashboard/apps/web/src/app/(app)/chat/channel-view.tsx`.
**Guarded by:** `dashboard/apps/web/test/admin/storage-fallback.test.ts`,
`dashboard/apps/web/test/chat/attachment-not-sent.test.tsx`,
`dashboard/apps/web/test/transfers/sending-a-file.test.ts`.

## What was seen

Several people, on the same day, could not send a picture in chat. The
composer's upload bar counted down to "0 seconds left" and stayed there -
no message arrived, no error appeared, and the box had already emptied as
if the send had gone through.

## What it actually was

The storage behind uploads is a network share (SMB, on a NAS). That NAS had
gone unreachable. Opening it goes through the host daemon's mount request
first and, when that fails, a userspace connect - and neither side of that
had a time limit. A storage that is switched off does not answer quickly: it
holds the request for as long as the kernel's own connect retries take,
which is minutes, not seconds.

The local-disk fallback that exists for exactly this case never ran,
because the open it was supposed to fall back from had not failed yet - it
was still hanging. On the client, the composer had already cleared the box
on send and had nothing to show while the request sat there, so there was
nothing on screen to say the file had not gone, and no way to retry it
short of reloading and hoping.

## The fix

Every wait in the open-and-write path now has a bound: opening a storage
gives up after 20 s (`OPEN_TIMEOUT_MS` in `storage-target.ts`), the host
daemon's own mount request after 15 s, and a write that has stopped moving
bytes - including the final wait on the storage's own close - after 60 s of
silence (`STALL_MS`, via `watchStream`). A storage that just failed is not
retried for 60 s afterward (`FAILED`/`RETRY_AFTER_MS`), so a share that is
down does not cost every following upload its own full timeout.

Past any of those bounds, `openForWriting` falls back to the disk the
dashboard itself runs on, the way it already did for an outright refusal -
`placeFile`/`streamFile` never had a path that left a message without its
files. An administrator is told once per storage per 6 hours
(`storage-alert.ts`, the new `storage.unreachable` notification), so a NAS
down for an afternoon is one notice, not one per photo somebody sent. A
sender gets a readable "storage X is not reachable" instead of a raw driver
error (`storage-refusal.ts`), with the driver's own message appended only
for an administrator.

On the client, `outgoing.tsx` keeps a sent-but-not-landed message visible
under the composer - which stays empty, because what people do next is
write the next line - showing progress, then "Saving it on the server" once
every byte is through and the storage has not answered yet, and finally
"This was not sent" with **Try again** and **Remove** if the 2-minute
client-side wait (`ANSWER_WITHIN_MS` in `move-file.ts`) runs out. **Remove**
puts the words back in the box; pressing send never throws a message away
for a file that did not make it.

## What stops it coming back

`storage-fallback.test.ts` asserts the open and write timeouts, the local
fallback, the once-per-6-hours notification, and that a storage which has
answered again is announced as reachable rather than staying silently
marked down. `attachment-not-sent.test.tsx` asserts the composer keeps a
failed upload on screen with its words intact and that **Remove** restores
them to the box. `sending-a-file.test.ts` covers the stalled-write case.

## The general rule

A request to something outside the process - a kernel mount, a network
share, a socket that may simply never answer - is not done until it has
either succeeded or been given up on by a clock this side controls. Without
that bound, every fallback and every error state written for the failure
case is dead code, because the request never reaches the branch that would
run it; it is still waiting. The client side of the same story: a UI that
clears its input optimistically needs somewhere durable to keep what it
cleared until the operation it represents has actually finished one way or
the other.

A related, separately diagnosed fault on the daemon side of this same
outage - two concurrent mount requests for one share deleting each other's
credentials file - is written up in
`hostd-concurrent-mounts-delete-each-others-credentials.md`, in this same
directory.
