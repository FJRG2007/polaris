# A share mounted again restarted services that had never lost it

**Found:** October 2026. **Fixed in:** `dashboard/apps/web/src/lib/deploy-service.ts`,
`dashboard/apps/web/src/lib/deploy/nas-binding.ts`,
`dashboard/apps/web/src/lib/deploy/volume-watch.ts`.
**Guarded by:** `dashboard/apps/web/test/deploy/nas-binding.test.ts`,
`dashboard/apps/web/test/deploy/nas-remount-restarts.test.ts`,
`dashboard/apps/web/test/deploy/volume-watch.test.ts`.

## What was seen

Every time a NAS share was mounted again on a machine, every running app bound
to it restarted and its owner was told it had just reconnected - even an app
that had never lost the mount and had been answering file reads the whole
time. An update that recreated the host daemon, or a session the kernel had
already reconnected by itself, was enough to trigger it: nothing about the
share or the app had actually failed.

## What it actually was

`restartAppsOnShare` runs whenever something re-establishes a connection's
mount - a deploy, Drive, or the boot reconcile calling `ensureMount` - and it
restarted every app bound to that `connectionId` unconditionally. That is the
right thing to do after the NAS genuinely went away: a container's bind
resolves once, at start, so a mount that died and came back under the same
path leaves every earlier container pointed at the dead one, with every file
on it answering "Host is down" until something restarts the container. But a
remount is not only raised by that. `ensureMount` also runs, and reports the
same "I just mounted it" outcome, when the host daemon itself was recreated
against a share that was never unmounted, or when the kernel had already
reconnected a dropped session on its own - and in both of those cases every
running container's existing bind is still the live one. Nothing told
`restartAppsOnShare` the difference, so it treated every remount as the first
kind.

## The fix

- `dashboard/apps/web/src/lib/deploy/nas-binding.ts` (new) adds `nasBinding`,
  which asks a running service - from inside it - where its own NAS volumes
  are bound, instead of assuming. `cat /proc/self/mountinfo` says whether each
  volume's mount path is on a network filesystem (`mountTypes`, `boundToShare`);
  `ls -d` on the paths says whether the share actually answers. It resolves to
  `"share"` (alive - leave it running), `"dead"` (answers like a mount that
  died: "Host is down", `ESTALE`, and the other spellings coreutils, busybox,
  and the kernel use for it), `"local"` (not a network filesystem at all - the
  service started before the share was mounted and is writing into a folder on
  the machine's own disk), or `"unknown"` (no `cat`/`ls` in the image, or the
  probe did not answer in time - a hard NFS mount that died hangs instead of
  failing). `mountTypes` also decodes the octal escapes the kernel writes into
  `mountinfo` for a path with a space or other special character in it.
- `restartAppsOnShare` calls `nasBinding` for each app before restarting it and
  skips the restart when the answer is `"share"`. An `"unknown"` answer is
  restarted, the same as every app was treated before this existed.
- `volume-watch.ts`'s periodic check (`answers`) is rewritten on the same
  helper, so it now also catches a service that is `"local"` - started while
  the share was not mounted - and restarts it onto the share, which the old
  check (a plain `ls` against the mount) never looked for.

## What stops it coming back

`nas-binding.test.ts` covers `mountTypes` (a stacked mount, and the escape
decoding) and `boundToShare`, and all four of `nasBinding`'s outcomes,
including a probe that hangs resolving to `"unknown"` rather than hanging the
caller. `nas-remount-restarts.test.ts` asserts a service still on a live mount
of the share is left running and never told anything, while one whose mount is
dead or whose volume is on the machine's own disk is restarted. The
`volume-watch.test.ts` cases for a service writing to the machine's own disk
assert it is restarted onto the share and its owner told once, not on every
pass.

## The general rule

A share being mounted again is evidence that the mount now exists, not that
every service bound to it needs restarting onto it - the two line up only
when the share had actually gone away. Whether a given service needs the new
mount depends on where its own bind already points, and only the service
itself can answer that from inside. Ask it before acting, on its behalf, on an
event that can be raised for reasons that have nothing to do with it.
