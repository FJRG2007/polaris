---
id: BUG-0026
title: Sharing a screen larger than 4K freezes the sharer, and the others cannot watch it
status: fixed-watching
area: calls / screen share
location: dashboard/apps/web/src/app/(app)/chat/call-quality.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/call-media.ts
  - dashboard/apps/web/src/app/(app)/chat/use-sfu-call.ts
  - docs/bugs/BUG-0001-screen-share-low-quality-by-default.md
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(calls): a screen larger than 4K goes out at 4K's worth of pixels, so it never freezes the sharer or reaches nobody"
---

## What was seen

Sharing from Polaris desktop on a super-ultrawide monitor, the computer
stuttered and froze while the share started, and the other person in the call
could not watch it. The same monitor shares without trouble in Google Meet and
Discord.

## Cause (confirmed from the media server's log)

The media server's log for the call shows the share published at
**7680x2160**, VP8, as a single layer (`trackInfo.width`/`height` on
`mediaTrack published`, source `SCREEN_SHARE`).

The top screen rung ("Source", what Automatic opens at since BUG-0001) names no
size at all, so the browser captures and encodes the display at its full size:
16.6 million pixels a frame at up to 60 fps. That is twice a 4K display. Encoding
it in software is what froze the sharer's machine, and it is more than a
viewer's machine can be expected to decode. Calling apps send a screen at a
bounded size; Polaris did not bound it at all.

In the same log, the viewer's app left the call 8-10 s after each share
started and joined again 2 s later (`participant closing`,
`CLIENT_REQUEST_LEAVE`), twice. Why it left was **not confirmed**: there is no
record of the viewer's own errors.

## Fix

- `SCREEN_MAX_PIXELS` (`call-quality.ts`): a shared screen is sent with at most
  a 4K display's worth of pixels (3840x2160). A screen that fits - 4K, 1440p,
  an ordinary 3440x1440 or 5120x1440 ultrawide - goes out at its own size, as
  before.
- A larger one is scaled down to that many pixels **in its own shape**
  (`screenFit`): 7680x2160 goes out at about 5430x1527, still sharper than any
  1440p ultrawide.
- The bound is applied to the open track (`fitScreen` in `call-media.ts`), not
  in the request, so Safari's capture is not capped by a named size.
- The screen's own size is remembered when it opens (`screenSource`), and every
  later change of quality (Automatic moving, a rung picked by hand) keeps the
  bound. Replacing the constraints without it would hand the screen back at
  full size.

## Verified

- Unit tests: `test/chat/call-quality.test.ts` (4K and ordinary ultrawides are
  left whole; 7680x2160 is scaled to just under 4K's pixels, keeping its shape;
  a quality change keeps the bound) and `test/chat/call-screen.test.ts` (a
  7680x2160 capture is scaled on open, keeping its frame rate, and its own size
  is remembered; 3840x2160 and 3440x1440 are not touched).

## Not verified

- Not watched in a real call. Whether a given Chromium scales a display capture
  to a `max` width and height with `applyConstraints` was not observed here.
- Why the viewer's app left the call each time the share started. If viewers
  still drop out after this fix, that is a separate cause.

## If it happens again

1. From the media server's log (`docker logs polaris-livekit-1`), the
   `mediaTrack published` line of the screen track: its `width`, `height`,
   `mimeType` and layers. Above 3840x2160 worth of pixels means the bound did
   not hold.
2. From the sharer, `chrome://webrtc-internals` (in the desktop app: the call's
   developer tools): the screen's outbound-rtp `frameWidth`, `frameHeight`,
   `framesPerSecond`, `qualityLimitationReason`.
3. From a viewer who cannot watch: whether the call leaves and comes back on its
   own, whether an error card appears or the page reloads, and the console's
   errors at that moment.
