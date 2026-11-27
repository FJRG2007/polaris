---
id: BUG-0071
title: Opening a link from the desktop app shows Windows' "cannot access the specified device, path, or file" box
status: fixed-watching
area: desktop
location: clients/desktop/src/main/open-external.ts
related:
  - clients/desktop/src/main/default-browser.ts
  - clients/desktop/test/main/open-external.test.ts
  - clients/desktop/test/main/default-browser.test.ts
  - docs/bugs/BUG-0020-desktop-links-in-mail-do-not-open.md
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

Desktop 0.1.130 on Windows 11, Brave as the default browser. Opening the
antivirus guide (https://fjrg2007.github.io/polaris/en/docs/antivirus/) from the
app showed a Windows system error box titled with the address: "Windows cannot
access the specified device, path, or file. You may not have the appropriate
permissions to access the item." with an OK button. The link code promises that
the system's own alert box is never shown for a link.

## Cause

Proved from the install's own `links.log` (`%APPDATA%\Polaris\logs`):

```
2026-11-27T20:24:45.307Z Opening https://fjrg2007.github.io through the default browser's registered command failed: spawn EPERM
2026-11-27T20:24:45.526Z Opened https://fjrg2007.github.io through the Windows shell (Explorer) (not confirmed)
```

1. The first route (the default browser's registered command, started
   directly) could not start `brave.exe` at all: `spawn EPERM` is libuv's name
   for `CreateProcessW` failing with `ERROR_ACCESS_DENIED`. That is not the
   BUG-0020 case, where Brave starts and exits with code 1.
2. The second route started a second `explorer.exe` with the address. Windows
   started it, so the route resolved ("not confirmed"), and that Explorer then
   opened the address with its own `ShellExecuteEx`, which has no
   `SEE_MASK_FLAG_NO_UI`. Starting Brave was denied there too, and Explorer
   showed the shell's error box for `ERROR_ACCESS_DENIED`, titled with the
   address. Polaris cannot see or suppress a box drawn by another process.

Inferred, not proved: what denied starting the browser. It happened 59 seconds
after Squirrel applied 0.1.131 and 7 seconds before the app restarted into it.
The denial reached both Polaris and the Explorer it started (both in Polaris's
process tree), while earlier Explorer hand-overs from the same install worked
(2026-11-25), which points at a security product acting on Polaris's process
tree at that moment (Malwarebytes is installed; its logs are encrypted and could
not be read). Windows Defender's operational log and the Application log have no
entry in that window. Not elevation: the app is not elevated (no manifest asks
for it, and the Hercules driver setup elevates only its own PowerShell child
through `Start-Process -Verb RunAs`), and an elevated process would not get
`EPERM` starting a browser.

## Fix

Explorer is now tried only right after the browser started and turned the link
down (`BrowserRefused`, the exit-code case BUG-0020 added it for), which shows
the program can be started. After a start that never happened (`spawn EPERM`,
`EACCES`, `ENOENT`, a missing program) or a Store browser with no registered
command, Explorer is skipped and `shell.openExternal` is asked instead: Electron
calls `ShellExecuteEx` with `SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI` there
(`shell/common/platform_util_win.cc`), so a failure is a rejection, never a box.
When that rejects too, the in-window notice with Copy link is shown, as before.

Not used: `rundll32 url.dll,FileProtocolHandler` and `explorer.exe` for every
case both open the address through a `ShellExecute` call without the no-UI
flag. `ShellExecuteW` (the non-Ex call) sets `SEE_MASK_FLAG_NO_UI` itself (Wine
`dlls/shell32/shlexec.c`), and `ShellExecuteEx` with that flag is what Electron
already does, so no native code was added.

## Verification

Desktop `tsc` and vitest `test/main/open-external.test.ts`,
`test/main/default-browser.test.ts`: the route order, Explorer skipped after
`spawn EPERM` / `EACCES` / `ENOENT` / a missing program / a Store browser, the
EPERM case ending in the in-window notice when Windows refuses too, Explorer
still used after an exit-code refusal, and `launchDetached` rejecting with
`BrowserRefused` only for a started browser. Not exercised on a real Windows
desktop with the denial reproduced: no Electron run here, and the denial itself
was not reproduced.
