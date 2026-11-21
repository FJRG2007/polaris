---
id: BUG-0005
title: Polaris desktop seems not to open on its first start, and again after a host is added
status: fixed-watching
area: desktop / windows
location: desktop/src/main/window-front.ts
related:
  - desktop/src/main/windows.ts
  - desktop/src/main/index.ts
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(desktop): the first start and an added host open in front of you"
---

## What was seen

A person installed Polaris desktop on Windows. The first start showed nothing.
Opening it again showed the window to add a host. After adding it, nothing
showed again, and only a third open showed Polaris.

## Cause (confirmed in code, not reproduced on a machine)

Windows only lets the process that owns the screen bring a window forward; a
window any other process shows opens behind the one in front. Two moments
lost it:

- **First start.** The installer starts the app (`--squirrel-firstrun`) from
  `Update.exe`, which does not own the screen, so the hosts window opened
  behind the browser the installer was downloaded from. Opening the app again
  worked because a second launch hands the screen to the running one.
- **After adding a host.** `openServer` opened the Polaris window hidden until
  its page was ready and closed the hosts window straight away. For the whole
  load the app had no window on screen, so it looked closed, and Windows gave
  the screen to whatever was behind; Polaris then appeared under it. The same
  order was in `backOnline`.

## Fix

- `createPresenter`: on the installer's first run, the first window is put
  above everything once (always on top, focus, then back), the way a window
  the person opened would be.
- `closeOnceShown`: the hosts window closes only once Polaris is on screen, in
  `openServer` and `backOnline`. A start at login kept minimized no longer
  hides a Polaris picked by hand from the list.

## Rule

A window the person asked for must never open after the app's last visible
window has closed: replace a window by waiting for the next one's `show`
(`closeOnceShown`), never by closing first.

## Verified

- `desktop/test/main/window-front.test.ts`: the first run lifts once; the hosts
  window stays until Polaris shows, and closes at once when it already is.
- Desktop typecheck, full test suite and build.

## Not verified

- Not run on a Windows machine through a real install; the release build has
  to be installed fresh to see it.

## If it happens again

Which Windows version, whether it was the first start after installing or an
update, whether a Polaris button was flashing in the taskbar (behind) or there
was none (not running), and any antivirus prompt at the time.
