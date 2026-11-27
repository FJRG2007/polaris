---
id: BUG-0065
title: The Stream 100's screen never shows what the plugin sets, even with Polaris' own driver
status: fixed-watching
area: device-plugins
location: crates/polaris-stream100/src/screen.rs
related:
  - crates/polaris-stream100/src/display.rs
  - crates/polaris-stream100/src/engine.rs
  - crates/polaris-stream100/src/native/winusb.rs
  - crates/polaris-stream100-node/src/lib.rs
  - crates/polaris-stream100/src/plugin.rs
  - docs/devices/hercules-stream100.md
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

With Polaris' WinUSB driver on the Stream 100 the knobs worked, but the
480x272 screen never showed the knobs' volumes or anything else the plugin's
Screen group sets. Plugin 0.1.12 said so on its page (BUG-0064).

## Cause

Three things, all in the display protocol:

- **No sync packet.** Every isochronous transfer must start with a packet
  holding `"HERCULES"` and zeros, ahead of the `SM` message. Polaris sent the
  bare message in one packet, so the controller never read any of it.
- **No session.** The firmware keeps a host only while it sends the official
  keep-alive (host description `0x10` + "host present" `11 00`), a heartbeat
  in every quiet 20 ms slot, and acknowledges (`14 00`) the device-information
  message the controller repeats in its input reports. Polaris sent a lone
  heartbeat every 250 ms and never acknowledged.
- **Wrong tile layout, no setup.** A background tile is an interlaced sample
  of the whole screen (`(8 * column + dx, 4 * row + dy)`), not a band of rows,
  and the screen must be switched on (`0x12`) and set to the host's own
  background (`0x38`, type `0xff`) first. Nothing rendered a page either.

Decoded from CataclysmX/New-Hera-lunx (`docs/protocol/framing.md`,
`commands.md`, `usb.md`, `live-tests.md`: the firmware's dispatcher and the
official SDK) and cont1nuity/hercules-stream-linux (`docs/PROTOCOL.md`,
`src/sm.py`), facts only.

## Fix

- `display`: the sync packet and transfer framing, the keep-alive, screen
  on/off, brightness, the custom-background configuration, the acknowledgement
  check on input reports, and the interlaced tiles.
- `screen`: the page (each knob's name, volume as a number and a bar, red when
  muted, a dash when nothing it follows plays) on a fixed palette, and
  `Painter`, which sends the keep-alive, heartbeats, acknowledgements and the
  32 tiles of a changed page one every 40 ms, the same for every transport.
- The engine builds the page after each report and on new settings; the WinUSB
  session draws the newest one and acknowledges the controller.
- The Screen group's "Polaris does not draw on the screen yet" note is gone.
- Plugin 0.1.13.

## Verification

- `cargo test -p polaris-stream100` (with and without `--features native`),
  `tests/screen.rs`: the keep-alive and acknowledgement are byte-identical to
  messages recorded from the official software, the recorded configuration's
  brightness matches, every pixel is in exactly one tile, the painter's
  transfers start with the sync packet, keep one sequence and never leave a
  20 ms slot empty, a page goes out as 32 tiles in order with the setup first,
  and the page shows each knob's volume.
- Not exercised on the device: the owner tests with
  `stream100-screen-test.md`. The Linux and macOS libusb route must call the
  same `Painter`; it lands with the cross-platform session.
