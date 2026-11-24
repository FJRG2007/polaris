---
id: BUG-0034
title: In Polaris desktop the Christmas Polaris logo does not load
status: fixed-watching
area: desktop / app icon
location: desktop/src/main/app-icon.ts
related:
  - desktop/src/main/tray.ts
  - desktop/src/main/windows.ts
  - desktop/src/main/notices.ts
  - desktop/src/renderer/dom.ts
  - desktop/src/preload/local.ts
  - desktop/test/main/app-icon.test.ts
reported: 2026-11-24
fixed: 2026-11-24
fix_commit: "fix(desktop): the season's Polaris mark from the first frame, on the splash, the taskbar and the tray"
---

## What was seen

Owner, 2026-11-24, during the winter season: in Polaris desktop the Christmas
Polaris logo does not load. No surface was named.

## Cause (confirmed in code and on the running app)

The page side works: the dashboard draws every season's mark as a valid PNG
(12-15 KB, under the 512 KB cap), the desktop accepts it, and the running
window's own icon (`WM_GETICON`, read-only) is the mark with the Santa hat. So
the icon is dressed only once a page of the dashboard has loaded and said so.
Everything before or outside that stayed plain:

- **Every launch.** What the hosts said lived only in memory, so each start
  showed the plain mark until the dashboard mounted - and the splash shown
  while an update goes in, the address form and a sign-in or provider page
  never report at all.
- **The app's own screens.** `updating.html` and `connect.html` drew the plain
  `mark.svg`, with nothing that knew the season.
- **The taskbar button and the notification area** were given only an image,
  never a file the Windows shell can read, and the button's relaunch icon
  stayed the executable's.
- **The notification picture** of a notice without its own was always the plain
  `icon.png`.

## Fix

- The hosts' last reports are kept in the app's data folder
  (`app-icon.json`, validated on read, stale hosts dropped) and put back before
  the first window or the tray is up (`restoreAppIcon`), so a launch wears the
  season from its first frame.
- The app's own windows get the season as a window argument
  (`--polaris-season=`, `markSeason()`): the settled season, or the shipped
  calendar's before any host has reported, plain where a host turned seasons
  off. The page draws the mark inline from core `seasonMarkSvg` (its CSP loads
  no picture that is not one of its files); anything unknown keeps `mark.svg`.
- On Windows the settled icon is written as an .ico at one stable path
  (`taskbar-icon.ico`, the shipped icon again once the season ends) and given to
  the window with `setAppDetails` - with the same app user model id Electron
  gives a Squirrel install, so it is the button the window already has - and to
  the tray, which takes every size the .ico carries.
- A notice without its own picture wears the dressed mark while the icon does.

All four seasons go through the same path; any failure leaves the shipped icon.

## Verified

- `desktop/test/main/app-icon.test.ts`: the stored reports round-trip and settle
  on the season, broken or hostile files start plain, stale hosts are dropped;
  the local-screen season for no reports / seasons off / a custom calendar; the
  .ico layout; the Squirrel app id; every local page that draws `mark.svg`
  dresses it. Full desktop suite green.
- In Electron 44.3.0 (hidden window): a stored winter report restored to a
  256x256 dressed mark, `markSeason()` winter, a 256x256 non-empty .ico read
  back by `nativeImage`, `setAppDetails` accepted, and a report with seasons off
  rewrote the .ico to the shipped one byte for byte.

## Not verified

- How the taskbar button and the notification area actually look: no screenshot
  of the owner's screen was taken. The relaunch icon is what Windows uses when
  the running button is pinned; whether it changes the drawn button of an
  unpinned one was not observed.
- The inline mark on the splash and the address form was not rendered.
- A packaged build; a launch through the Update button.

## If it comes back

Ask which surface (window, taskbar button, notification area, splash, address
form, a notice), and collect `app-icon.json` and `taskbar-icon.ico` from the
app's data folder.
