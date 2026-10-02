# A NAS that changed address kept being dialled at the old one

**Found:** October 2026. **Fixed in:**
`dashboard/apps/web/src/lib/storage-whereabouts/follow.ts`,
`dashboard/apps/web/src/lib/storage-whereabouts/identity.ts`,
`dashboard/apps/web/src/lib/storage-whereabouts/neighbours.ts`,
`dashboard/apps/web/src/lib/storage-whereabouts/smb-probe.ts`,
`dashboard/apps/web/src/lib/storage-alert.ts`,
`dashboard/apps/web/src/lib/storage-service.ts`,
`dashboard/apps/web/src/lib/storage-target.ts`,
`dashboard/apps/web/src/lib/storage-returns.ts`,
`dashboard/apps/web/src/app/(app)/admin/uploads/network-card.tsx`,
`dashboard/apps/web/src/app/(app)/admin/uploads/actions.ts`,
`dashboard/apps/web/src/app/(app)/drive/actions.ts`,
`dashboard/apps/web/src/app/api/cron/storage-whereabouts/route.ts`,
`dashboard/apps/web/src/app/api/cron/storage-returns/route.ts`.
**Guarded by:** `dashboard/apps/web/test/storage/credentials-follow-identity.test.ts`,
`dashboard/apps/web/test/storage/device-identity.test.ts`,
`dashboard/apps/web/test/storage/smb-identity-probe.test.ts`,
`dashboard/apps/web/test/storage/storage-follows-device.test.ts`,
`dashboard/apps/web/test/storage/network-storage-card.test.tsx`,
`dashboard/apps/web/test/storage/unreachable-notice-outcome.test.ts`,
`dashboard/apps/web/test/storage/fallback-files-return.test.ts`,
`dashboard/apps/web/test/admin/storage-fallback.test.ts`.

## What was seen

A NAS on the local network took a new DHCP lease. Uploads to it
started failing, and every profile photo that lived on it broke - not for one
person, for everybody, all at once, with nothing in the deploy or the
configuration having changed.

## What it actually was

A storage connection on the local network is a fixed address in
`StorageConnection.config` (`{"host": "10.0.1.30", ...}`), and nothing ever
revisited it. The box itself had not gone anywhere: it was still on the shelf,
still answering SMB, just on a different address its router had handed it.
Polaris kept dialling the old one, which nothing answered, so every upload fell
back to the disk the dashboard itself runs on. The operator has no terminal and
no way to open `.env` or a config file, so there was no screen to go and type
the new address into even if they had known it - and nothing told them the
address had changed at all.

The sharper version of the same gap: a router is also free to lend that old
address to a **different** device. Before this fix, whatever answered there
would have been handed the stored password - an address is not an identity, and
nothing checked that it still belonged to the box the credentials were for.

## The fix

A storage connection now remembers **who** answered, not just where
(`lib/storage-whereabouts/identity.ts`): the hardware address the host's own
neighbour table saw it under, and what its SMB server volunteers about itself
before anyone signs in - its server GUID and its NetBIOS/DNS names, read from
an unauthenticated SMB2 NEGOTIATE and NTLM NEGOTIATE/CHALLENGE
(`lib/storage-whereabouts/smb-probe.ts`). The exchange stops before the
AUTHENTICATE message that would carry a password, so probing an address Polaris
is unsure about never risks it. A name alone never counts as proof - only a
matching hardware address or server GUID does (`compareIdentity`).

Three points this is enforced:

- **Before credentials go anywhere** (`confirmBeforeCredentials`, called from
  `storage-service.ts`'s `buildDriver`, `resolveMountTarget`,
  `getUnasMetrics` and `discoverUnasShares`), the device at the configured
  address is asked who it is. One that cannot prove it is the remembered device
  refuses the sign-in (`DeviceNotConfirmed`) instead of sending the password.
- **After credentials work** (`rememberAfterSuccess`), what the device said is
  saved onto the connection, so a connection made before this existed starts
  being followed the first time it signs in successfully.
- **When it stops answering or a stranger answers in its place**
  (`searchFor`), Polaris reads the host's neighbour table for the device's
  hardware address (`lib/storage-whereabouts/neighbours.ts`, exec'd inside the
  `mdns` container - the one part of Polaris already on the host's network,
  see that module's own header for why), then sweeps the /24 on port 445 if
  that does not find it. A match that proves itself by hardware address or
  server GUID is followed: the connection's address is updated, its cached
  driver/mount state is dropped (`forgetConnectionState`), and the
  administrators are told with the device's hardware address to reserve in
  their router, so the lease does not move again. The sweep is bounded (a
  one-minute deadline, cancelled early the moment a match is found) and shared
  across concurrent callers, so a NAS that is simply off does not cost a fresh
  60-second search for every upload that arrives while it is down.

The "storage is unreachable" notice now carries what the search found instead
of a flat "check that it's on": off/disconnected, answering but refusing the
file, a different device sitting on its old address, or several unidentified
SMB servers a human has to tell apart. The `/admin/uploads` network card
(**Find it again**) and the connection's address field both expose the same
search and the same identity check, so an administrator can resolve a move or
an impostor from the screen they already use - never a terminal.

Files that had already landed on the local disk while the storage was away are
no longer stuck there for good: each one is recorded
(`StorageFallbackFile`, `lib/storage-returns.ts`) and, once its storage answers
again, copied over, read back and SHA-256-verified, has every row pointing at
it repointed in one transaction, and only then has its local copy removed.
Each file is claimed before it is touched, so the five-minute `storage-returns`
cron pass and the one fired the moment a storage comes back
(`openForWriting`) never duplicate a return, and a restart mid-copy simply
retries the file next pass.

Two scheduled passes drive this without an external scheduler:
`storage-whereabouts` (every 5 minutes, follows a moved device before it is
missed) and `storage-returns` (every 5 minutes, catches up on anything a
just-reconnected storage's own trigger missed) in `lib/cron/jobs.ts`, each with
a matching `/api/cron/*` route for an instance with an external scheduler
wired up.

## What stops it coming back

`storage-follows-device.test.ts` and `credentials-follow-identity.test.ts`
cover the three enforcement points above, including that a different SMB
server which picks up the old address is refused and never signed in to.
`device-identity.test.ts` and `smb-identity-probe.test.ts` cover the identity
comparison rules and the NEGOTIATE/NTLM probe in isolation, with no network.
`network-storage-card.test.tsx` covers the admin screen's **Find it again**
and **Use this one** flows. `unreachable-notice-outcome.test.ts` covers every
shape the unreachable notice can take. `fallback-files-return.test.ts` and
`storage-fallback.test.ts` cover the local-disk return path, including a
restart mid-copy and a storage deleted while files still wait on it.

## The general rule

An address a DHCP server lent is a loan, not an identity, and a system that
dials the same LAN device repeatedly - especially one that sends it a
credential - has to confirm identity from a property the device cannot share
with another one before trusting the address alone. Where nobody can act on a
terminal, "point it at the new address yourself" is not a fix; the system has
to notice the move, prove the replacement is the same device, and follow it.
