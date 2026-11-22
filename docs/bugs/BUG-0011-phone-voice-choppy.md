---
id: BUG-0011
title: A phone in a call, or recording a voice message, sounds cut into pieces
status: fixed-watching
area: calls / voice messages / mobile
location: dashboard/apps/web/src/app/(app)/chat/mic-filter.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/mic-cleanup.ts
  - dashboard/apps/web/src/app/(app)/chat/handheld.ts
  - dashboard/apps/web/src/app/(app)/chat/voice-recorder.ts
  - dashboard/apps/web/src/app/(app)/chat/use-sfu-call.ts
  - mobile/android/app/src/main/java/app/polaris/mobile/HomeActivity.java
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: b64a9b4786 "fix(chat): a phone in a call or recording a voice message no longer cuts the voice into pieces"
---

## What was seen

Somebody in a call from a phone - the phone's browser or the Android app - was
heard by everybody else as very choppy. A voice message recorded in the Android
app sounded just as bad when played back, so the fault was on the phone and not
on the line.

## Cause (confirmed in code)

Both paths pass the microphone through the same noise filter (`filterMic`,
called from `use-sfu-call.ts` and `voice-recorder.ts`), and its default was the
heavier model (GTCRN, "enhanced"). It runs on the audio thread at 48 kHz with
768-sample frames while the thread hands it 128 samples at a time, so every
sixth 2.7 ms render quantum carries a whole frame through the network. A
computer has the headroom. A phone's browser, and the Android app's WebView,
do not run that thread at real-time priority, miss the slot, and the voice
comes out in pieces.

Ruled out:

- The line: LiveKit reported packet loss at or under 0.06% that day.
- The recording format: `audio/webm;codecs=opus` at the browser's default rate.
- The Android app: a WebView with the microphone granted,
  `MODIFY_AUDIO_SETTINGS` declared and hardware acceleration on. Nothing native
  to change, so no app release was needed.

## How others do it

Native apps run their suppressor in native code on a real-time audio thread:
Discord's mobile apps ship Krisp that way. A web page cannot ask for that
priority, which is why Jitsi moved its RNNoise filter to an AudioWorklet and
still keeps it light. Common integration advice is one suppressor in the path,
not the browser's and a model stacked on top of each other.

## Fix

- A phone that never chose a setting gets the browser's own echo cancellation
  and noise suppression, with no model (`cleanupDefault()` in `mic-cleanup.ts`,
  `isHandheld()` in `handheld.ts`).
- A phone that chose "enhanced" keeps the choice but runs only the light model
  (RNNoise, 10 ms frames). If that fails it falls back to the browser's own
  processing, never to GTCRN (`modelOrder()` in `mic-filter.ts`). The call
  menu already says the lighter model is running.
- Computers are unchanged: GTCRN first, RNNoise as the fallback.

## Verified

- `test/chat/handheld-audio.test.ts` and the mic, voice note and call voice
  suites (11 files, 108 tests); web typecheck with no new errors.

## Not verified

- Not heard on a real phone yet: a call from a phone browser, a call from the
  Android app, and a voice message recorded in the Android app.
- RNNoise on a slow phone where "enhanced" was saved: lighter than GTCRN, not
  measured.

## If it happens again

Collect:

- the phone model and Android version
- the Android System WebView version (Settings -> Apps -> Android System
  WebView). A WebView bug broke audio capture between April and June 2026 and
  was fixed in WebView 149.
- whether it is the browser or the app
- the noise setting shown in the call menu
- whether a voice message recorded on that phone is also choppy, which separates
  the phone from the network
- for a call, the LiveKit stats for that participant (packet loss, jitter)
