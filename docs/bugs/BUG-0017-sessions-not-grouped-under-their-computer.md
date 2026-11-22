---
id: BUG-0017
title: Active sessions on the same computer are not grouped under it
status: fixed-watching
area: account / sessions
location: dashboard/apps/web/src/lib/device-sessions/device-groups.ts
related:
  - dashboard/apps/web/src/components/sessions-table.tsx
  - dashboard/apps/web/src/components/device-group-row.tsx
  - dashboard/apps/web/src/lib/device-sessions/device-block.ts
  - dashboard/apps/web/src/lib/extension/sessions.ts
  - dashboard/apps/web/src/app/(app)/account/sessions/actions.ts
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: "fix(sessions): every session known to be on a computer is grouped under it"
---

## What was seen

Account > Sessions showed a "DRAGON - Windows - 1 session" group holding only
the Polaris Desktop session, while the browser session in use, the Brave
extension, a Stream Deck sign-in and a command-line sign-in from the same
computer sat ungrouped below it - several of them even labelled "DRAGON".

## Cause

Two different things read "which computer is this":

- The group (`groupByDevice`) joined rows only on the device key, a hashed
  machine id the desktop app, the CLI and the Stream Deck plugin started
  sending on 2026-11-21. Every sign-in made before that (CLI 0.4.6, Stream
  Deck 0.1.19.0) has no key, and a browser or the extension never sends one,
  so the desktop app was alone in its group.
- The "DRAGON" label under the other rows came from `machinesOf`, a badge that
  guesses by address plus system. It is a reading, not evidence, so it never
  decided grouping - which made the screen contradict itself.

## Fix

`groupByDevice` now joins rows on any of three reported signals, never on an
address:

1. The same device key (as before).
2. The same computer name on the same system family, as reported by a native
   client (desktop app header, CLI and Stream Deck sign-ins). This places
   sign-ins made before the key existed - retroactive, from stored data.
3. An extension and the browser session that approved it (the extension opens
   the approval tab in its own browser), when both read as the same browser
   on the same system. An approval from a phone or another browser never
   joins.

The server no longer trusts a key to mean one device: a group press sends the
group key, and `resolveDeviceGroup` rebuilds the groups from the account's own
rows with the same function to decide what is signed out. The reader's own
session is always spared. Block is offered only for a group with a device key
and refused for the group the reader is on.

## Known limits

- A browser session that did not approve an extension has no machine signal
  and stays ungrouped; joining it would need a new signal from the browser.
- Two computers of one account with the same name and system read as one.
