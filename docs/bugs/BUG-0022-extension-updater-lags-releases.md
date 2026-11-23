---
id: BUG-0022
title: The browser extension's automatic updates leave it versions behind, with nothing on screen
status: fixed-watching
area: extension
location: dashboard/apps/extension/scripts/install.ps1
related:
  - dashboard/apps/extension/scripts/install.sh
  - dashboard/apps/extension/src/lib/self-update.ts
  - dashboard/apps/extension/src/lib/update.ts
  - dashboard/apps/extension/src/entrypoints/background.ts
  - dashboard/apps/extension/src/entrypoints/popup/updater-broken.tsx
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(extension): the updater runs every hour and says when it is not working"
---

## What was seen

The extension was installed on Windows (Brave) with the one-line installer,
whose copy promises that it "checks for a new version every few hours and the
extension restarts into it by itself". The folder had its updater note
(`polaris-updater.json`), yet the extension stayed on 0.1.275 while 0.1.276 to
0.1.279 were published, and nothing on screen said whether an update was
coming.

## Cause (confirmed on the machine and in code)

Nothing failed. The scheduled task was registered, ran with result 0 and every
run did what it was written to do; `update.log` shows each run that found a
release installing it (0.1.271 at 10:15, 0.1.275 at 13:22). But:

1. **The task ran every six hours** (`-RepetitionInterval 6h`; launchd
   `StartInterval 21600`, systemd `OnUnitActiveSec=6h`, cron `*/6`). 0.1.276 to
   0.1.279 were published between 13:30 and 14:14 local time, right after the
   13:22 run, so the next run that could deliver them was 19:22. With releases
   going out every half hour, a copy was routinely several versions and up to
   six hours (plus any time asleep) behind.
2. **Nothing said so.** A run that found nothing new wrote nothing anywhere, a
   failed run wrote only to `update.log`, which nobody reads, and the extension
   had no way to tell an updater waiting for its next run from one that had
   stopped - only a 12-hour "still behind" fallback.

The owner re-ran the line at 14:59, which installed 0.1.279 by hand.

## Fix

- The task / job runs **every hour** on every system (Windows Task Scheduler,
  launchd, systemd user timer, cron). That is one GitHub API request a run on
  Windows and two on macOS/Linux, well inside the 60 an hour GitHub allows an
  unsigned address. The updater script itself is downloaded only when its
  published digest differs from the copy already there.
- **Existing installs repair themselves.** Every run refreshes `update.ps1` /
  `update.sh` from the release, and the new script, on its first scheduled run,
  re-registers a task or job that still runs on the old six-hour schedule (only
  one that names its own updater; on macOS the new plist is loaded at the next
  sign-in, since booting the agent out would end the run doing it). Re-running
  the install line re-registers it at once.
- **Every run writes what it found** into the extension's folder, as `check` in
  `polaris-updater.json` (time, `installed` / `current` / `failed`, a reason
  code, the error detail, and how often it runs), renamed into place so the
  extension never reads half a file.
- **The popup says when it is not working**, under the version line:
  "Automatic updates are not working: <reason>", the updater's own detail, and
  the install line for this system with a copy button. A failed run shows at
  once (GitHub out of reach only while a newer version is out); an updater that
  has not run for three of its periods while a newer version is out is reported
  as stopped, with when it last ran. While it shows, a newer version is offered
  as an update by hand (download and steps) instead of "installs it within the
  hour". Updaters from before this write no check and keep the 12-hour
  fallback.

## Verified

- On this machine, read-only: the task `Polaris extension updates` (conhost
  headless, `-File ...\update.ps1 scheduled ...`, interval `PT6H`, last result
  0), `update.log`, and release publish times from the GitHub API, which line
  up with the cause above.
- `test/updater-scripts.test.ts`: both scripts run for real against a local
  stand-in release feed - installs and writes `check`, a second run records
  `current`, a digest mismatch keeps the folder and records `digest`, an
  unreachable API records `unreachable`, and (PowerShell) a six-hour task is
  re-registered hourly. The scheduler is stubbed and never touched.
- `test/self-update.test.ts`, `test/update.test.ts`,
  `test/updater-broken.test.tsx`: parsing the check, when it counts as trouble,
  the kind turning `manual`, and the popup's text, line per system and copy.

## Not verified

- A real scheduled run of the new script on Windows, macOS or Linux, and the
  re-registration of the owner's existing task (it happens on its own after the
  first release carrying this). The shell script was exercised under Git Bash
  on Windows, not on macOS or a systemd/cron Linux.
- The popup notice in a real browser.

## If it happens again

Read `polaris-updater.json` in the extension folder (`check` says what the last
run found and when), `update.log` beside the folder, and the task:
`Get-ScheduledTask -TaskName "Polaris extension updates"` plus
`Get-ScheduledTaskInfo` (interval should be `PT1H`); on macOS/Linux the
launchd plist, systemd timer or crontab line named `polaris-extension-update`.
