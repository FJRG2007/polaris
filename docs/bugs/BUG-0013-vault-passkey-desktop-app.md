---
id: BUG-0013
title: Unlock with passkey fails in the desktop app and never starts on its own
status: fixed-watching
area: vault / passkeys / desktop app
location: dashboard/apps/web/src/lib/vault/passkey-client.ts
related:
  - dashboard/apps/web/src/app/(app)/vault/vault-unlock.tsx
  - dashboard/apps/web/src/app/(app)/vault/settings/vault-passkeys.tsx
  - dashboard/apps/web/src/lib/local-passkeys.ts
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: "fix(vault): the desktop app offers a passkey only once it can unlock there"
---

## What was seen

In the desktop app the vault's lock screen never asked for the passkey on its
own, although the setting is on and the web does. Pressing "Unlock with
passkey" ended in "The passkey was not used. Try again, or use your master
password."

## Cause (from code; not reproduced on a device)

- The button was drawn for every enrolled passkey of the address once the
  client said it supports PRF. Electron reports PRF support, but it reaches
  only the system's passkeys (Windows Hello, a security key, a phone by QR
  code), never a passkey a browser keeps for itself (Chrome's password manager,
  an extension). The system prompt had nothing to offer, the only way out was
  dismissing it, and a dismissal reads as `NotAllowedError` -> "cancelled".
- The automatic prompt asks only for passkeys that have answered in this
  client (`lib/local-passkeys`, kept per browser profile). The app keeps its
  own list, and a passkey that never answered there is never on it.

## Fix

`passkeyOffer()` decides what the lock screen offers. In the desktop app only
passkeys that have answered in it are offered; with none, the screen says that
browser passkeys do not reach the app and how to set one up. Vault settings in
the app gain "Use in this app" for a passkey already on, which runs the
ceremony there and records it. Security keys and phones that answered in the
app are now recorded too (`roaming`), so the app offers them; they are still
never asked for on their own.

## Verified

Unit and component tests (`test/vault/passkeys/offer.test.ts`,
`unlock-ui.test.tsx`, `test/passkeys/local-passkeys.test.ts`). Not exercised
in the real app with Windows Hello.
