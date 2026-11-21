---
id: BUG-0006
title: Opening a link to another site in Polaris desktop ends the call
status: fixed-watching
area: calls / desktop
location: dashboard/apps/web/src/app/(app)/chat/use-sfu-call.ts
related:
  - desktop/src/preload/outside-links.ts
  - desktop/src/main/ipc.ts
  - desktop/src/main/windows.ts
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(chat): a call no longer hangs up when a link to another site is opened"
---

## What was seen

In a call in Polaris desktop, clicking a link to another site opened it in the
browser and dropped the person out of the call.

## Cause (confirmed in code, not reproduced on a machine)

- The media client (`livekit-client`, `disconnectOnPageLeave` on by default)
  hangs up on `beforeunload`.
- A plain click on a link with no `target` begins a navigation, and the page's
  `beforeunload` handlers run before the navigation is decided.
- Desktop then cancels it in `will-navigate` and opens the address outside
  (`contain` in `windows.ts`): the page never left, but the call had already
  ended.

The same order hurt every other `beforeunload` handler: the arcade's "leave
this site?" guard and the editors' unsaved-changes guards fired for nothing, and
in Electron a guard that cancels the unload swallows the link entirely.

## Fix

- Calls: `disconnectOnPageLeave: false`, and the call ends on `pagehide`, the
  page actually going away (dashboard image).
- Desktop 0.1.48: the preload takes a plain click on a link to another site
  after the page's own handlers (`outside-links.ts`) and asks the main process
  to open it outside, so no navigation starts. The main process refuses any page
  but the Polaris, and the preload then follows the link as before (a
  provider's sign-in during a round trip).

## Rule

Never end shared state (a call, a lock, a presence) on `beforeunload`: it fires
for navigations that are cancelled. Use `pagehide`.

## Verified

- `desktop/test/renderer/outside-links.test.ts`: which clicks are taken and
  which are left to the page.
- Desktop navigation and open-external suites.

## Not verified

- Not run in a real call on the desktop app; needs the dashboard update and
  desktop 0.1.48.
- A navigation started from script (`location.href = ...` to another site) still
  fires `beforeunload`; the call fix covers it, other guards do not.

## If it happens again

Desktop version, what was clicked (chat message, a page's button, a
notification), and whether the call ended at the click or a few seconds later.
