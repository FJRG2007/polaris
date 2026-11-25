---
id: BUG-0040
title: After Alt+Space the launcher opens but typing does not go into its search
status: fixed-watching
area: desktop
location: dashboard/apps/web/src/components/command-palette.tsx
related:
  - clients/desktop/src/main/window-front.ts
  - clients/desktop/src/main/launcher.ts
  - clients/desktop/src/preload/launcher.ts
  - dashboard/apps/web/src/app/(embed)/launcher/launcher-search.tsx
  - dashboard/apps/web/test/search/palette-host-window.test.tsx
  - clients/desktop/test/main/window-front.test.ts
  - clients/desktop/test/main/launcher-warm.test.ts
  - docs/bugs/BUG-0041-launcher-slow-first-open.md
reported: 2026-11-23
fixed: 2026-11-25
fix_commit: "fix(launcher): Alt+Space always types into the search, opens smoothly after idle, and no longer dims the screen"
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

## Cause of the regression (confirmed in code, 2026-11-25)

The window itself is still focused (`takeFocus()` is unchanged). The page it
shows is the instance's `/launcher`, the dashboard's own `CommandPalette`, and
that page never focused its field on an open: it relied on the field's
`autoFocus` and the dialog's mount focus, which only run when the panel is
mounted again. It stayed mounted:

- Closed by Escape or by a result, the dialog starts its exit animation and
  the page asks the desktop to hide the window at once. Radix keeps the
  content mounted until `animationend`, which a hidden, throttled page does not
  fire, so the next open reused the old field and nothing focused it.
- Closed by clicking elsewhere, the desktop hid the window on `blur` without
  telling the page, so the page still thought it was open; the next open
  changed nothing on the page and nothing focused the field.

## Fix (2026-11-25)

- Page (ships with the dashboard): in a host's window the palette is drawn
  with `SearchSheet`, mounted only while open, with no exit animation, so
  every open mounts a fresh field. Each open also focuses the field once it
  has drawn, and again when the window is activated later than it was shown.
- Desktop (ships with the desktop): hiding on blur sends `launcher:hidden`
  to the page (`onHidden` on the bridge), which closes the panel. The
  launcher window is no longer throttled while hidden.
- Both cope with the other being old: a desktop without `onHidden` still
  gets the field focused on every open; an older page ignores the new message.

## Verified

- `palette-host-window.test.tsx`: the field is focused on reopen after
  Escape, after the window was hidden by a lost focus, and with a desktop that
  has no `onHidden`.
- `launcher-warm.test.ts`: blur hides the window and sends `launcher:hidden`;
  the next press shows it, sends `launcher:opened` and focuses the page.
- Not verified on a real Windows desktop: Electron was not launched on the
  development machine.

## If it happens again

Note the desktop version (Settings), whether it fails every time or only on
the first open after a while, how the launcher was last closed (Escape, a
result, clicking elsewhere), and which app was in front when Alt+Space was
pressed.
