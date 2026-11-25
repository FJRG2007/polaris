---
id: BUG-0041
title: The launcher's first open after hours unused is jerky, and its dimmed backdrop behaves oddly
status: fixed-watching
area: desktop
location: clients/desktop/src/main/launcher.ts
related:
  - clients/desktop/src/main/launcher-apps.ts
  - dashboard/apps/web/src/components/command-palette.tsx
  - dashboard/packages/ui/src/search/search-panel.tsx
  - dashboard/apps/web/test/search/palette-host-window.test.tsx
  - clients/desktop/test/main/launcher-warm.test.ts
  - docs/bugs/BUG-0040-launcher-search-not-focused.md
reported: 2026-11-25
fixed: 2026-11-25
fix_commit: "fix(launcher): Alt+Space always types into the search, opens smoothly after idle, and no longer dims the screen"
---

## What was seen

In Polaris desktop on Windows, the first Alt+Space after the launcher has not
been used for hours opens with a jerky animation; later opens are smooth. The
dimmed backdrop shown behind the launcher also "does something odd". The
reporter asked whether Raycast shows such a backdrop at all.

## Cause (confirmed in code, 2026-11-25)

Several pieces of work landed on the first press after a while, all competing
with the panel coming up:

- The desktop read the installed programs again on that press once its
  listing was older than ten minutes, which on Windows spawns PowerShell
  (`Get-StartApps`); the rows asked for on the open did the same.
- The page refetched its search index once it was older than a minute, with a
  spinner, and redrew the list when it arrived; the host's own rows were
  cleared on close and arrived again after the panel had appeared, so the
  centred panel changed height mid-animation.
- The launcher window was throttled while hidden, so its page drew its first
  frames late after hours in the background.
- The backdrop was the dashboard dialog's shade (`bg-black/50` with a blur)
  inside a window laid over the whole screen. Closing hid the window mid fade,
  so the next show flashed that frozen frame. Raycast draws no backdrop, and
  the desktop's own panel already left it off.

## Fix (2026-11-25)

- Desktop: a press only shows the window. The program list is read as the
  launcher is put away (two seconds after, `refreshSoon`), never on a press
  (`listedApps` answers from the last listing); only a launcher that never
  listed anything starts the first read. The window sets
  `backgroundThrottling: false`.
- Page: an index already loaded paints at once, whatever its age; a stale one
  is asked for again 400 ms after the open, with no spinner, and redrawn only
  if it changed. The host's rows for an empty field are kept for the next open.
  In the desktop's window the panel has no shade and no exit animation.

## Verified

- `launcher-warm.test.ts`: no program read on a press, one after the window
  is put away; the window is made with `backgroundThrottling: false`.
- `palette-host-window.test.tsx`: a stale index paints at once with no
  spinner or skeleton and no request until after the open; no shade behind the
  panel.
- Not verified on a real Windows desktop after hours idle: Electron was not
  launched on the development machine.

## If it happens again

Note how long Polaris desktop had been idle, the desktop version, the
instance's version, and what the panel did (late first frame, grows or jumps,
a flash behind it).
