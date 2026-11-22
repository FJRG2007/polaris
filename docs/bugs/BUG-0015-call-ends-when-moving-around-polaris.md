---
id: BUG-0015
title: Moving to some screens, links or notices in Polaris ends the call
status: fixed-watching
area: calls
location: dashboard/apps/web/src/lib/keep-call.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/call-resume.ts
  - dashboard/apps/web/src/app/(app)/chat/call-session.tsx
  - dashboard/apps/web/src/components/call-holder.tsx
  - dashboard/apps/web/src/lib/desktop-notify.ts
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: "fix(chat): a call stays on through links that used to replace the page; fix(chat): notices, app installs and sign-ins no longer end the call"
---

## What was seen

The owner asked that a call never hang up however much you move around Polaris
(settings, sections, anything), the way Discord keeps you in voice.

## Cause (confirmed in code, not reproduced in a call)

The call is held by the shell (`CallHolder` inside the `(app)` layout), so a
client navigation between screens keeps it. Three things still replaced the
page or the shell:

- Full loads to another address: pressing a notice (`desktop-notify`,
  `location.assign`), installing or removing an app (VPN, Network filter, Mail
  server, a marketplace app with its own screen), deleting the vault, the
  Safety filter. The note the page writes on its way out (`call-resume`) is only
  acted on after a reload of the same address, so these came back as "call
  lost".
- Client navigations to a screen outside the `(app)` group (a meeting join link
  `/m`, a print view, a public status page, a share link): no shell, so the
  layout holding the call unmounted and the call went with it.
- Plain `<a href>` links to in-app screens that no router took: a full load.
- Round trips of minutes (a Polar connector's sign-in, adding another account).

## Fix

- `lib/keep-call.ts`: `navigateInApp` (through the shell's router),
  `leavePage` (a new tab while a call is on), `loadPage` (a full load that
  carries the call: `call-resume` treats the next departure as a reload and
  walks back in with the same camera, and `call-voice-resume` the same
  microphone and deafen state).
- While a call is on, a click on a link to a screen outside the shell opens a
  new tab, and a plain in-app link is routed (`useCallLinkGuard`).
- `OUTSIDE_APP_PREFIXES` is checked against the route tree by a test.

## Already fine

- Reloads (F5, the update banner, the automatic update reload, the error
  screen's Reload, the device cache reset, a picture changed): the call is
  rejoined, unrung, with the previous microphone state (`call-resume`,
  `call-voice-resume`).
- A screen's error: `(app)/error.tsx` sits inside the shell, the call stays.
- Theme, language, workspace switching: router refreshes, no reload.

## By design

- Switching or signing out of the account, a whole-Polaris import, and the
  lockdown sign-out end the call: the person on it is no longer this one.
- Closing the tab hangs up (`pagehide`), with no ghost participant.

## Verified

- `dashboard/apps/web/test/lib/keep-call.test.ts`; call-resume, pagehide and
  reload suites; typecheck and production build.

## Not verified

- Not exercised in a real call in a browser or the desktop app.
- A `router.push` built from data to a screen outside the shell is not
  guarded; none was found in code.

## If it happens again

What was pressed (link, notice, button, a setting), the address before and
after, and whether the call came back by itself, offered a Rejoin, or was gone.
