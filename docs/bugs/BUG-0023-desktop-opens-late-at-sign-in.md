---
id: BUG-0023
title: Polaris desktop does not seem to open with the computer, or opens minutes later
status: fixed-watching
area: desktop
location: desktop/src/main/login-item.ts
related:
  - desktop/src/main/index.ts
  - desktop/src/main/settings.ts
  - desktop/src/main/squirrel.ts
  - desktop/src/renderer/connect.html
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(desktop): Polaris opens at sign-in, not minutes after it"
---

## What was seen

"Open with the computer" was on, yet after turning the PC on Polaris did not
seem to open, or took a very long time to.

## Cause (confirmed on the machine and in code)

The start was there, just late. Measured on the owner's Windows 11 machine
(read-only): sign-in (Winlogon 7001) at 19:58:52, Explorer at 19:58:56,
Discord at 20:02:07, Polaris at 20:04:37 (Squirrel's
`SquirrelSetup.log`/`Squirrel-ProcessStart.log`: `--processStart polaris.exe
--process-start-args --hidden`), Stream Deck at 20:05:07.

1. **The Run key is started by Explorer, on its own schedule.** The app put
   itself under `HKCU\...\CurrentVersion\Run` (`app.setLoginItemSettings`),
   and Windows gives "no guarantees about how promptly the programs in the Run
   key are run" (Microsoft Learn, "Run and RunOnce Registry Keys"). Explorer
   delays and serializes those entries on a busy sign-in
   (`Explorer\Serialize`, `StartupDelayInMSec`, `WaitForIdleState`): almost six
   minutes here.
2. **Nothing came on screen even then for a start in the tray.** With "Start
   minimized" on, the start showed only a tray icon, with nothing saying it had
   happened. (The owner's own setting was off, so the late start is what they
   saw.)

## Fix

- On Windows the app opens from a **per-user Task Scheduler task with a logon
  trigger** (`Polaris at sign-in (<user>)`): the signed-in user's own session,
  limited rights, no delay, no time limit, normal priority (a task's default 7
  is below normal and the app would inherit it), and it runs Squirrel's
  `Update.exe --processStart polaris.exe --process-start-args --hidden`, so it
  survives every version folder. Registered with `schtasks /Create /XML ... /F`
  spawned with an argument array and no shell; no administrator is needed.
- **One start, never two.** Once the task is registered the Run key entry is
  removed; when Windows refuses the task, the Run key entry is kept as the
  fallback. Turning "Open with the computer" off removes both (and reports a
  failure if a task stays behind); uninstalling removes both.
- **Existing installs move on their own.** Every start already re-applies the
  setting, so the first start of this version registers the task and removes
  the old Run entry; later starts rewrite the same task, which is idempotent.
- **A start in the tray says so.** "Start minimized" is now "Start in the
  tray", on by default for files that never had it (a stored value is kept),
  and a start in the tray shows one silent notice, "Polaris is running", that
  opens the window when clicked.
- **The tray icon comes first.** The tray and menu are installed at the top of
  `whenReady`, before the runner, the native host, the launcher and the game
  watcher start.

## Verified

- `test/main/login-item.test.ts`: the task XML (logon trigger for the account,
  `LeastPrivilege`, priority 5, no delay, Update.exe and the login argument),
  the UTF-16 file schtasks reads and its removal, Run key removed when the task
  takes and kept when it does not, turning off with and without a task, a task
  that stays behind reported as a failure, development runs untouched.
  `node:child_process` is replaced and any unanswered scheduler call fails the
  test, so no real task is created.
- `test/main/settings.test.ts`: the new default, and a stored `false` kept.
- The generated XML parses as XML (PowerShell `[xml]`), desktop typecheck,
  full desktop suite and production bundle.

## Not verified

- A real `schtasks /Create` with this XML, and a real sign-in started from the
  task: no scheduled task was created on this machine and the app was not run
  against the owner's profile. If Windows refuses the task, the Run key
  fallback keeps today's behaviour.
- The time from sign-in to tray icon on a real login after the change.

## If it happens again

`schtasks /Query /TN "Polaris at sign-in (<user>)" /V /FO LIST` (last run time
and result), the Task Scheduler operational log (event 100/200/201 for the
task), whether a `Polaris` value is back under `HKCU\...\CurrentVersion\Run`,
Winlogon 7001 for the sign-in time, and `Squirrel-ProcessStart.log` in
`%LOCALAPPDATA%\polaris` for when the app was started.
