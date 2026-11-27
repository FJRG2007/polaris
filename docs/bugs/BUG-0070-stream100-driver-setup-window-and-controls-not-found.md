# BUG-0070: Setting up the Stream 100 driver opens a PowerShell window, and the controls are not found after it

- **Area:** Device plugins (Hercules Stream 100, Windows)
- **Reported:** 2026-11-27, plugin 0.1.19, desktop 0.1.130 or 0.1.131
- **Status:** Fixed, watching (plugin 0.1.20, desktop 0.1.133). Never exercised on a real device.

## What the owner saw

1. The plugin page said "Polaris' driver is not on the Stream 100 yet, so its knobs and buttons do nothing here." with a "Set up the driver" button.
2. Pressing it opened a visible PowerShell window behind Windows' permission prompt.
3. After the setup the page said "Not working - The Hercules Stream 100 is plugged in, but its controls were not found."
4. The page still offered "Open Hercules Stream Control" although Polaris' driver was the one in use.

## Causes

1. Desktop 0.1.130 only set up a requirement the install had consented to; an install from before the driver requirement never got it (BUG-0069, fixed in 0.1.131). On 0.1.131 the sentence and button appear only after an automatic setup was declined or failed (for example a permission prompt left unanswered until it timed out). Install, update and start each set the driver up on their own; the button is the fallback.
2. `runElevated` (`clients/desktop/src/main/plugins/hercules-official-run.ts`) started the elevated program with `Start-Process -Verb RunAs` and no window style. The hidden parent was hidden, but the elevated `powershell.exe` got a console window of its own.
3. The plugin kept running during the driver swap. While it held the device (the Hercules SDK route), Windows could not restart the device on the new driver: `UpdateDriverForPlugAndPlayDevices` reported a reboot, which the elevated script ignored. The device was left named as WinUSB but still running the old stack (problem code 14), so Polaris' device interface `{24a30efc-...}` never appeared. The plugin's reader found no WinUSB interface, no HID collection and no SDK device, and the ownership check (WinUSB counts as `direct`) fell through to `noControls`. The VID/PID match and the interface GUID were correct.
4. The official-software line on the plugin page (`dashboard/apps/web/src/app/(app)/account/plugins/official-software.tsx`) did not know which driver held the device.

## Fix

1. Unchanged from BUG-0069: `requirements.ensure()` runs on install, update and start.
2. The elevated launch passes `WindowStyle = 'Hidden'` (ShellExecuteEx with SW_HIDE), the same launch sudo-prompt uses on Windows (`Start-Process ... -WindowStyle hidden -Verb runAs`) and `vpn-helper-client.ts` already used. Only the vendor's interactive uninstaller keeps its window. A static test (`clients/desktop/test/main/hidden-processes.test.ts`) requires every `spawn`/`execFile` in the desktop main process and the device plugins to state `windowsHide`, allows `false` only for programs that are meant to be seen, and requires a window style on every elevated `Start-Process`.
3. The plugin is stopped while its driver goes on, and stays stopped through the plug events the swap causes (`PluginManager.whileStopped`). After binding, the elevated script waits for Polaris' device interface (`CM_Get_Device_Interface_List_Size`). If it does not appear, or Windows asked for a reboot, the script restarts the device itself (`pnputil /restart-device`, then disable/enable), all in the same hidden console. If the interface still does not appear, it keeps the driver record and answers `restart`. The page then says Windows needs a restart, and the driver look reports code 14 as `installed` with `pending`. The plugin's reader keeps retrying, so the controller is found as soon as the interface appears.
4. The desktop's official-software look reports `driverInUse`. The page then says the official app is not needed and does not offer to open it.

## Not verified

No Stream 100 and no Windows device swap were exercised. Windows Terminal as the default terminal has been reported to ignore hidden-window requests for console programs (microsoft/terminal#12464). The SW_HIDE launch has not been checked against that setup.
