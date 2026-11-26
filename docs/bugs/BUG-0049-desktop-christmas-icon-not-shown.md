---
id: BUG-0049
title: Polaris desktop does not show the Christmas icon of the winter season
status: fixed-watching
area: desktop / app icon
location: clients/desktop/src/main/shortcut-icon.ts
related:
  - clients/desktop/src/main/app-icon.ts
  - clients/desktop/src/main/served-icon.ts
  - clients/desktop/src/main/index.ts
  - clients/desktop/test/main/app-icon.test.ts
  - clients/desktop/test/main/served-icon.test.ts
  - clients/desktop/test/main/shortcut-icon.test.ts
  - docs/bugs/BUG-0034-desktop-christmas-logo-does-not-load.md
reported: 2026-11-26
fixed: 2026-11-26
fix_commit: "fix(desktop): the taskbar button and the shortcuts wear the season, read from the Polaris itself"
---

## What was seen

Owner, 2026-11-26, on desktop 0.1.120, inside the winter season (15 November -
9 January on the shipped calendar, so it is in force; no admin override was
needed): the Christmas icon does not show. Follows BUG-0034.

## Cause (confirmed on the running app, read-only)

The dressing itself worked: `app-icon.json` held the host's winter report with
its calendar, `taskbar-icon.ico` was the mark with the Santa hat, and every
visible Polaris window answered `WM_GETICON` (big, small, small2) with the
dressed mark. What stayed plain:

- **The taskbar button.** The window carries an app id (`setAppDetails`,
  `com.squirrel.<package>.<exe>`), and Windows draws the button of such a
  window from the Start menu shortcut carrying that id - and every Polaris
  shortcut (Start menu, its company folder, the desktop) pointed at the
  executable's own, plain icon. The window class icon is plain too.
- **A host whose page never reports.** The app learnt the season only from a
  page of the dashboard, so a host from before pages reported, or a window left
  on a page outside the app frame, kept the plain mark.

## Fix

- Every shortcut that starts the app (Start menu and one folder down, the
  desktop, the taskbar's pins) gets the dressed .ico as its icon while a season
  is worn and the app's own back once it ends; only the icon is written
  (`shell.writeShortcutLink` "update"), only when it differs. The way Chrome
  keeps a profile's badge on its taskbar button
  (`profile_shortcut_manager_win.cc`).
- On every load of a Polaris the app reads the icons that host serves (its
  web app manifest names `/season-icon/<season>-512.png` in a season) and wears
  that mark while no page of the host has reported a calendar. A page's report
  still wins; a host without the manifest or with plain icons leaves the icon
  plain; one that cannot be reached changes nothing.

## Verified

- `clients/desktop/test/main/served-icon.test.ts`, `shortcut-icon.test.ts`,
  `app-icon.test.ts` (30 tests): the manifest read, every fallback, the report
  rules and the shortcut decisions. Desktop typecheck clean for the changed
  files.
- On the owner's machine, read-only: the stored report, the dressed .ico and
  window icons, and that the three Polaris shortcuts target the Squirrel stub
  with the plain icon.

## Not verified

- No Electron was launched: the shortcut rewrite and the taskbar button were
  not observed. A running button keeps the icon it was created with, so the
  dress shows on the button from the next start.
- Explorer may hold a cached picture for the .ico when one season follows
  another at the same path (winter, then New Year).

## If it comes back

Ask which surface; collect `app-icon.json`, `taskbar-icon.ico`, and the icon
location of the Polaris shortcuts.
