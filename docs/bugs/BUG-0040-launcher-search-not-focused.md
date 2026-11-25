---
id: BUG-0040
title: After Alt+Space the launcher opens but typing does not go into its search
status: regressed
area: desktop
location: clients/desktop/src/main/window-front.ts
related:
  - clients/desktop/src/main/launcher.ts
  - clients/desktop/test/main/window-front.test.ts
  - clients/desktop/test/main/launcher-warm.test.ts
  - docs/bugs/BUG-0041-launcher-slow-first-open.md
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(desktop): typing after Alt+Space goes into the launcher's search (1bdb6fa2d5)"
---

## What was seen

In Polaris desktop on Windows, Alt+Space shows the launcher on top, but the
search field has no keyboard focus: what is typed goes to the app behind it.
Reported on 2026-11-23, fixed the same day, and reported again on 2026-11-25
("sigue sin hacerme autofocus cuando pulso Alt+Space"). It was not filed in
this ledger when it was first fixed.

## Cause found the first time (confirmed in code)

The launcher is always-on-top, so it is drawn whether or not Windows let it
take the foreground; the foreground lock refused the activation and the page
stayed blurred. The window is kept hidden and shown again, which leaves its
page blurred unless focus is asked for.

## Fix the first time (desktop 0.1.65)

Showing goes through `takeFocus()`: show and focus; when the foreground lock
refused it, a topmost flip and then a minimize and restore, each only if the
step before left the window unfocused (electron/electron#2867); then
`webContents.focus()`, as Flow Launcher focuses its query box. The window
drops the app menu Windows gives every window, so Alt is not handed to a menu.

## Regression (2026-11-25, cause not confirmed yet)

Seen on a desktop at or after 0.1.111. Under investigation together with
[BUG-0041](BUG-0041-launcher-slow-first-open.md), which happens on the same
open.

## If it happens again

Note the desktop version (Settings), whether it fails every time or only on
the first open after a while, and which app was in front when Alt+Space was
pressed.
