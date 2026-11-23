---
id: BUG-0027
title: A call is lost when Polaris desktop or the phone app updates, instead of carrying on
status: fixed-watching
area: calls / desktop / mobile
location: dashboard/apps/web/src/app/(app)/chat/call-resume.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/call-session.tsx
  - dashboard/apps/web/src/lib/desktop-bridge.ts
  - desktop/src/shared/relaunch.ts
  - desktop/src/main/relaunch.ts
  - desktop/src/main/updates.ts
  - desktop/src/main/ipc.ts
  - mobile/android/app/src/main/java/app/polaris/mobile/SelfUpdate.java
  - mobile/android/app/src/main/java/app/polaris/mobile/InCall.java
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(calls): an update of the desktop or phone app keeps you in the call"
---

## What was seen

On a call, Polaris desktop or the phone app updated, and afterwards the person
was no longer in the call. Nothing put them back.

Expected: a restart Polaris itself makes for an update puts the person back in
the same call, camera as it was, without ringing anybody. Somebody who quit
the app is not rejoined: a microphone never opens by itself.

## Cause (confirmed in code)

Walking back into a call after a reload (`call-resume.ts`) keeps its note in
the tab's `sessionStorage`. That survives a reload of the same tab, and nothing
else.

- **Desktop.** Restarting into an update (`autoUpdater.quitAndInstall()` on
  Windows and macOS, `app.relaunch()` + `app.quit()` for the AppImage) and the
  restart offered after a settings change (`app.relaunch()` + `app.exit(0)`)
  start a new process. The page's session storage goes with the old one, so
  the next start had no note and the call was simply gone. `app.exit(0)` does
  not even run `pagehide`, so no note was written at all.
- **Android.** A downloaded update installs itself the moment the person leaves
  the app (`SelfUpdate.installWhenLeaving`, from `onStop`). Installing over the
  app ends its process. Somebody who switched to another app mid-call had the
  update installed under them, and the call in the page ended with the process.
- **Server update** (the dashboard image replaced) was not affected: the page
  reloads, or the framework loads the same address again, and the existing
  session-storage note covers both.
- **iPhone** has no self-update (installed from Xcode; App Store or TestFlight
  updates are the system's, not Polaris's). **TV** hosts no calls.

## Fix

- The page, inside the desktop app, hands the app its own call note whenever
  the call or the camera changes, and `null` when the call ends
  (`holdCallForRestart`, bridge `holdCall`). The main process keeps it in
  memory only, per window, and forgets it when the page goes.
- Only a restart the app makes itself writes those notes down, with why
  (`markRelaunch("update" | "relaunch")`, in `settings.json`): the update's
  restart closure (menu, notice, page button, update at start all go through
  it) and the settings restart. Quitting writes nothing. A restart called off
  because a push is running removes what was written.
- The next start reads it once and removes it; each page asks once
  (`relaunched`) and gets its own call back once, only within 90 s of the
  restart, only for the same viewer. The page then enters the call with the
  camera as it was and `placedAt` cleared, so nobody is rung.
- A plain browser tab is unchanged: none of this exists outside the app.
- Version skew: a page that does not know `holdCall` hands nothing, and an app
  without `relaunched` is asked nothing; both behave as before.
- Android: an update waits while a call is on (`InCall.now`, the audio mode a
  call holds), and installs the next time the person leaves without one. The
  launcher-icon switch, which also restarts the app, reuses the same check.

## Verified

- Desktop: `npm run typecheck`, the whole desktop suite
  (`npx vitest run --maxWorkers=2`), with new tests for the mark (once, its
  window, nothing else read as a restart), the main-process held calls, the IPC
  door (only a Polaris page, only a note, forgotten on navigation) and the
  settings file.
- Web: `test/chat/call-resume.test.ts` - rejoin after an update restart with
  the camera kept, no ringing, nothing after the call ended, nothing after a
  quit, nothing for another viewer, nothing past the window, an older app and
  a plain browser tab unchanged.

## Not verified

- No real desktop update was run through end to end (no packaged build or
  release here); the restart paths were read, not exercised.
- The Android change was not compiled: no JDK or Android SDK on this machine.
- That WebView keeps `MODE_IN_COMMUNICATION` for the whole of a background
  call is relied on as the launcher-icon switch already did, not measured.

## If it happens again

- Desktop: `settings.json` in the app's data folder right after the restart -
  a `relaunch` key means the app wrote the call down; its absence means the
  restart did not go through `markRelaunch`.
- Note which update path ran (Windows installer, macOS, AppImage) and how long
  the restart took; past 90 s the call is deliberately not rejoined.
- Android: whether the person was on the call with the app in the background
  when the update installed.
