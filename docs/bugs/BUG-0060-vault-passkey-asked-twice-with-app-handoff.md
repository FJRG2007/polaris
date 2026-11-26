---
id: BUG-0060
title: Opening the vault fires a passkey prompt in the browser while handing the page to the desktop app
status: fixed-watching
area: vault / passkeys / open in app
location: dashboard/apps/web/src/components/open-in-app.tsx
related:
  - dashboard/apps/web/src/app/(app)/vault/vault-unlock.tsx
  - dashboard/apps/web/src/lib/open-in-app.ts
  - dashboard/apps/web/src/lib/local-passkeys.ts
  - BUG-0013, BUG-0014
reported: 2026-11-26
fixed: 2026-11-26
fix_commit: "fix(vault): a vault handed to the desktop app is not also unlocked in the browser"
---

## What was seen

On Windows with the desktop app installed, opening the vault started the
"ask for the passkey right away" prompt and at the same time sent the page to
the desktop app, which did not ask there; then the browser came forward with a
Windows Hello prompt. Several prompts and windows for one unlock.

## Cause (from code)

Two features ran on the same load of the vault in the browser, each unaware of
the other:

- "Open links in the app" (`components/open-in-app.tsx`) saw a page reached
  from outside Polaris, asked the server whether the account uses the desktop
  app and navigated to `polaris://open?...&path=/vault`. The app opened the
  vault, and asked for nothing on its own because no passkey had answered in
  the app yet (BUG-0013: it only offers passkeys that have).
- The lock screen (`vault-unlock.tsx`) saw a passkey this browser had used and
  started the WebAuthn ceremony as soon as the window was attended - in the
  browser tab that had just handed its page away. Its Windows Hello prompt
  belongs to the browser, so it brought the browser back over the app.

Nothing in the desktop shell is involved: Electron reaches Windows Hello
through Chromium's own Windows WebAuthn path, in place, and the in-app lock
screen only asks on its own for a passkey that has answered in the app.

## Fix

The handoff is decided once per document (`appHandoff()`), whoever asks first,
and does the navigation itself. The note in the app chrome and the lock screen
share that one answer: the lock screen waits for it before any automatic
prompt and asks nothing in a tab whose page went to the app. The button stays,
so a person who stays in the browser still unlocks with one press.

Sign-in was checked for the same pattern: the sign-in screens are never handed
to an app (`NEVER` in `lib/open-in-app.ts`, and `HoldOpenInApp`), and in the
desktop app the sign-in prompt only fires for a passkey that answered there.

## Verified

`test/mobile/open-in-app-handoff.test.ts` (one decision for every caller, one
request), `test/vault/passkeys/unlock-ui.test.tsx` (no automatic prompt after a
handoff, the button still offered). Not exercised in a real browser with the
desktop app installed, nor with Windows Hello.
