# Sessions by device - ledger

Account > Active sessions groups what is signed in by the computer it runs on,
and lets the owner sign a device out or block it. This page records how the
grouping is decided, what a block holds against, and what is not done yet.

## Status

| Item | State |
| --- | --- |
| Group sessions by device (header row, count, last active, collapsible) | Done |
| Device id from Polaris Desktop (header on every request to its own server) | Done |
| Device id, system version and domain from the CLI and the Stream Deck plugin | Done |
| Old clients keep working and show ungrouped | Done (tested) |
| Sign out every session of a device | Done |
| Block / unblock a device (sign-in, session refresh, API key use) | Done |
| Browser extension and browsers grouped under the desktop's device | Not done - see "Vouching" |
| Mobile app and TV device id | Not done - native builds not available here |
| Model / phone name from native apps | Partial - computer name and OS version only |
| Block a site/domain | Not done - see below |
| Locate device | Not done - see below |

## How a device is identified

- Polaris Desktop, the CLI and the Stream Deck plugin read the operating
  system's machine id (Windows `MachineGuid`, macOS `IOPlatformUUID`,
  `/etc/machine-id`) and send `sha256("polaris-device-v1\0" + id)` - never the id
  itself. One shared reader: `dashboard/packages/core/src/device-identity-node.ts`.
- Desktop: `x-polaris-device` / `x-polaris-device-name` headers, added only to
  requests to the active server origin (`desktop/src/main/device-headers.ts`).
- CLI and Stream Deck: an optional `device: { id, osVersion }` field on
  `/api/cli/authorize` and `/api/deck/authorize`. Older servers strip it; older
  clients omit it.
- The server stores `sha256(userId + "\0" + claim)` (`lib/device-sessions/device-key.ts`)
  on `SessionState.deviceKey` and `ApiKey.clientDeviceKey`, so the value cannot be
  matched across accounts.
- Grouping (`lib/device-sessions/device-groups.ts`) uses that key only. Names,
  addresses and systems never group rows; they still feed the existing
  "same machine" badge, which decides nothing.

## What a block holds against, honestly

- Device ids are claims. A client that omits or forges its id is not recognised.
- Enforced: the session guard refuses any session whose claimed or recorded key
  is blocked (so an open desktop session ends at its next request, and dropping
  the header does not revive a session already recorded on that device); a
  device sign-in (CLI, Stream Deck) is refused at claim time; a device key is
  refused on use. Blocking also revokes everything the device holds.
- Not covered: a browser on the same computer (it has no machine id), a
  modified client. The confirm dialog says this and points to changing the
  password. The device in hand cannot be blocked from itself.

## Vouching (not shipped)

The strongest safe way to place browser and extension sessions on a device is
for Polaris Desktop to vouch for them: the extension asks the desktop's local
bridge for a short-lived, server-signed device assertion bound to the
extension's own connection, and presents it on its next request. Shipping it
needs a desktop bridge endpoint, an extension release and a server-side
nonce/assertion verifier; doing it with a bare id the extension copies would
let any local process claim the device, which is weaker than not grouping. Left
for its own round.

## Block a site/domain (not shipped)

Sessions are host-only cookies on this deployment's own names; blocking one of
your own domains per account would only lock the owner out of an address they
also use. The account network rules already block by address, country and
network. No per-domain block is added.

## Locate device (not shipped)

Needs an opt-in on the device itself with the OS location permission, a
persistent visible indicator on that device, a revocation path, and native
mobile builds (Gradle/Xcode) that cannot be produced or tested here. Shipping a
desktop-only or silent version would fall short of the bar set for it, so it is
deliberately not started. When built, the map must reuse the chat location
viewer components.
