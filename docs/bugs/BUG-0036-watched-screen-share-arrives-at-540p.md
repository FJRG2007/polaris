---
id: BUG-0036
title: A watched screen share arrives at 540p instead of full quality
status: fixed-watching
area: calls / screen share
location: dashboard/apps/web/src/app/(app)/chat/call-quality.ts
related:
  - dashboard/apps/web/src/app/(app)/chat/call-layer.ts
  - dashboard/apps/web/src/app/(app)/chat/call-room-options.ts
  - dashboard/apps/web/src/app/(app)/chat/use-sfu-call.ts
  - docs/bugs/BUG-0001-screen-share-low-quality-by-default.md
  - docs/bugs/BUG-0026-screen-share-larger-than-4k-freezes.md
reported: 2026-11-24
fixed: 2026-11-25
fix_commit: "fix(calls): a shared screen keeps its sharpness when the line narrows, and the one you watch arrives at its top copy"
---

## What was seen

Somebody shared their screen in a call from Polaris desktop, and the person
watching it saw it at roughly 480p instead of full quality, on a connection with
plenty to spare. Nobody had touched the quality settings: Automatic on both
sides.

Expected, in the reporter's words: like Discord - press share, the other person
sees it, and nobody ever thinks about quality because it always looks right.

## Cause (confirmed from the media server's log and the code)

The media server's log for the share (`mediaTrack published`, source
`SCREEN_SHARE`, 2026-11-24 23:09:35Z) shows it published as **VP8 simulcast
with two copies**: `q` 960x540 at 3 Mbps and `h` 1920x1080 at 12 Mbps, nothing
else. What was seen matches the 540p copy, or the 1080p copy scaled down by
the sender's browser.

Ruled out:

- **The viewer's connection.** The viewer was on the same LAN as the media
  server, direct over UDP (host to host, IPv6).
- **The viewer's window size.** The client's `adaptiveStream` only measures a
  video given to its own `attach()`. The tiles draw a `MediaStream` into their
  own `<video>`, so it measured nothing, and every viewer asked for the top
  copy (`RemoteTrackPublication.emitTrackUpdate` falls back to `HIGH`).

What caused it, all on the sender's side:

1. **Automatic shared at "Source, 60 fps" tuned to keep frames.** Any rung at
   30 fps or more was hinted `motion` with `maintain-framerate`. Under any
   pressure the browser keeps 60 fps and gives up resolution. Since BUG-0001,
   a `bandwidth` limitation no longer moves Automatic down, so the share stayed
   on that rung however narrow the line was.
2. **The only fallback was 540p.** Polaris passed no `screenShareSimulcastLayers`,
   so the client added its default: one copy at half the size and a quarter of
   the allowance (`computeDefaultScreenShareSimulcastPresets`). Whenever the
   1080p copy did not get through, the server had 960x540 to forward.
3. **The sender's uplink went through the relay.** The sender's media reached
   the server through the relay's call tunnel (selected remote candidate
   `prflx 172.26.0.4`, the `wg-nat` container), from a home connection. 12 +
   3 Mbps up is a lot to ask of that.

VP8 rather than VP9 is deliberate and was not the cause. A shared screen
republished as VP9 after a reconnection was refused one of its layers
("duplicate layer"), and viewers got nothing (commit 63710c0a69).

Not confirmed: whether, at that moment, the server switched to the 540p copy or
the browser scaled the 1080p copy down. The server logs at `info`, which
records neither, and the sender's `webrtc-internals` was not captured. Both are
fixed below.

## Earlier occurrences

- 2026-08: every call picture was soft because the devices were opened with the
  browser's default 640x480 and no frame rate (fixed with the quality ladders,
  `call-quality.ts`).
- BUG-0001 (2026-11-21): Automatic walked a share down to 720p at 5 fps on the
  first `bandwidth` reading. Its fix opened the share at 60 fps and stopped
  reacting to `bandwidth`, which is what let this one happen.
- BUG-0026 (2026-11-23): a 7680x2160 share froze the sharer; the top rung named
  no size at all.

## Fix

- **A shared screen always keeps its size** (`screenTuning`): the degradation
  preference is `maintain-resolution` at every rung, and the content hint still
  follows the frame rate. Under pressure it gives up frames, not sharpness.
  Discord's Go Live behaves the same way: a stream that cannot hold 60 fps
  drops to 30.
- **An explicit ladder below the source** (`screenLayers`): a 720p copy at
  15 fps / 1.5 Mbps (LiveKit's `ScreenSharePresets.h720fps15`), plus a 1080p
  copy at 30 fps / 5 Mbps (`h1080fps30`) when the screen is well above 1080p.
  Allowances are scaled by pixels for other shapes. No copy is the source's own
  size, so the sender never encodes the full picture twice. 540p is gone.
- **The tiles ask for the copy they need** (`call-layer.ts`): each tile reports
  its size in device pixels, a focused or full-screen tile asks for the top
  copy outright, and a shared screen is never asked for below 720p. The
  client's `adaptiveStream` is off, since it never measured these tiles.

## Verified

- Unit tests: `test/chat/call-quality.test.ts` (tuning keeps resolution at
  every rung; ladders for 1080p, 4K, ultrawide, small and unknown sources),
  `test/chat/call-layer.test.ts` (focus asks for the top copy, faces at drawn
  size, screens never below 720p, several tiles combine, the ask reaches the
  publication once subscribed and only on change), and
  `test/chat/call-room-options.test.ts`.
- Suites `test/chat`, `test/i18n`, `test/design`, `test/components` and
  `test/build`: 9033 passed, 39 skipped, none failed.
- Production build of the dashboard (`npm run build`) passes.

## Not verified

- Not watched in a real two-person call; nothing here exercised a media
  server. Whether Chrome/Electron honors `maintain-resolution` per simulcast
  layer, and how the relay tunnel carries the new total (about 13.5 Mbps for a
  1080p60 share), were not measured.

## Rest of the audit (2026-11-25)

Ranked by impact; items marked open remain.

1. Sender-side quality loss on a share (above): fixed.
2. Viewers pulling every camera's top copy whatever the tile size, which spends
   the viewer's downlink and the server's budget in larger calls: fixed by
   `call-layer`.
3. Open: the relay call tunnel's capacity is unmeasured. Anybody outside the
   LAN publishes through it.
4. Open: no record to prove which copy was forwarded. The server logs at
   `info`. `debug` is too heavy to leave on, and adding a stats report on the
   call screen was declined. Next time, collect the sender's
   `webrtc-internals` as below.
5. Open: hardware H.264 in the desktop app could lower the sender's CPU cost
   for 1080p60. Not researched far enough to change the codec; VP8 stays for
   the reason above.
6. Open: screen audio goes out at 96 kbps with DTX off, but nothing asks for
   stereo, so it is most likely mono. Not verified.
7. Server (LiveKit 1.13.11): one UDP port and one TCP port, no TURN, no bitrate
   caps, default congestion control. Nothing there limits quality.

Sources: Discord, "How it all goes live"
(https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology),
"From blocky to brilliant"
(https://discord.com/blog/from-blocky-to-brilliant-improving-video-quality-on-discord-go-live-on-amd-gpus),
Go Live support article (https://support.discord.com/hc/articles/360040816151);
livekit-client 2.23.0 sources (`publishUtils.ts`, `RemoteTrackPublication.ts`,
`RemoteVideoTrack.ts`, `options.ts`).

## If it happens again

1. From the sender, `chrome://webrtc-internals` for the screen track's
   outbound-rtp: every rid's `frameHeight`, `framesPerSecond`,
   `qualityLimitationReason` and `targetBitrate`, plus the candidate pair's
   `availableOutgoingBitrate`.
2. From the viewer, the inbound-rtp `frameHeight` and whether the share was
   focused or full screen.
3. On the media server, `mediaTrack published` for the track: the copies listed
   under `layers`. A 960x540 copy under a 1080p share means this fix is not
   running.
