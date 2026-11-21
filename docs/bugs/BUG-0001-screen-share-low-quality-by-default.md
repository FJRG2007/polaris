---
id: BUG-0001
title: A shared screen goes out at low quality on a line that can carry the source
status: fixed-watching
area: calls / screen share
location: dashboard/apps/web/src/app/(app)/chat/call-quality.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/use-sfu-call.ts
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(calls): a shared screen goes out at the source and stays there unless the call really suffers"
---

## What was seen

With the screen quality left on Automatic, a shared screen went out visibly
soft and at a low frame rate, on connections that had no trouble at all.
Picking a rung by hand gave a sharp picture, so the line was not the limit.
Discord, Google Meet and the like send the same screen at full quality and
frame rate.

Expected: Automatic sends the source - the display at its own resolution, at
its frame rate - and comes down only when the call is actually suffering, which
is rare.

## Cause (confirmed in code)

`driftAuto` read the encoder's `qualityLimitationReason === "bandwidth"` as
trouble and dropped a rung on the **first** such reading.

- The browser reports `bandwidth` for the first seconds of every call, while
  its bandwidth estimate is still climbing towards what the line can carry.
- While a call is settling, the picture is read every 5 s
  (`DRIFT_SETTLING_MS`).
- So within about 15 s of starting a share, auto had walked the screen ladder
  from the top rung to the floor - **720p at 5 fps**.
- Climbing back took a minute of clean readings per rung, and three minutes for
  each rung marked as having failed. On most calls the picture never came back.

Separately, the top rung capped a shared screen at 30 fps, below a game's or a
video's real frame rate.

## Fix

- A `bandwidth` limitation no longer counts as trouble. On a full line the
  encoder already answers it by spending fewer bits on the same rung.
- Dropping a rung needs sustained trouble, not one reading
  (`TROUBLE_TO_DROP`): a bad reading adds 2, a good one takes 1 away, and 6
  drops a rung. Three bad readings in a row drop it; a single wobble never does.
- What still counts as trouble: the connection reported `poor` or `lost`, the
  machine unable to encode the rung (`cpu`), the camera's frames stalling below
  half the rung's rate, and a queueing round trip while the data saver is on.
- The top screen rung ("Source") is the display's own size at up to 60 fps,
  with a 12 Mbps ceiling (previously 30 fps and 10 Mbps).

## Verified

- Unit tests in `test/chat/call-quality.test.ts`: the screen stays at the top
  rung through eight `bandwidth` readings, one poor reading does not drop the
  camera, three in a row do, and a line that is bad half the time comes down
  without ever climbing. 54 of 54 pass.

## Not verified

- Not watched in a real call. Whether a given browser and display actually
  deliver 60 fps from `getDisplayMedia` with `frameRate: { ideal: 60 }` depends
  on the browser and the capture source.
- The real bitrate and frame rate subscribers receive was not measured.

## If it happens again

Collect, from the person sharing:

1. The screen quality setting in the share menu (Automatic or a rung), and
   whether a custom stream shape (resolution or frame rate) is set.
2. Browser and version, the display's resolution, and what is shared (a
   window, a tab or the whole screen).
3. From `chrome://webrtc-internals`, the outbound-rtp of the screen track:
   `frameWidth`, `frameHeight`, `framesPerSecond`, `qualityLimitationReason`,
   `targetBitrate`, and the candidate pair's `availableOutgoingBitrate`.
4. Whether it starts soft at once or goes soft after a while.

Starting soft at once points at the first rung or the capture constraints.
Going soft after a while points at `driftAuto`: check which reading counted as
trouble.
