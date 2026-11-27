---
id: BUG-0064
title: A Stream 100 knob needs five full turns to go from silent to full, and the screen stays blank without saying why
status: fixed-watching
area: device-plugins
location: crates/polaris-stream100/src/encoder.rs
related:
  - crates/polaris-stream100/src/plugin.rs
  - clients/device-plugins/hercules-stream100/manifest.json
  - docs/devices/hercules-stream100.md
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

With plugin 0.1.9 on Windows, the Hercules software installed and Stream
Control closed, the status said "Connected" and knob 4 (whole output) changed
the Windows volume, but only after a great deal of turning. The controller's
screen showed nothing, and nothing on the plugin's page said it would not.

## Cause

- **Knobs.** The engine turned 48 counts into one step of "Volume per click"
  (2% by default). 48 was described as measured on the hardware; it never was.
  The knobs are endless double-wiper potentiometers, and the firmware's
  accumulator, which every route reads (the USB/HID report on Linux and
  WinUSB, the Hercules SDK's state, which copies it), moves 512 counts per
  full turn (CataclysmX/New-Hera-lunx, `docs/firmware/knobs.md`,
  `docs/protocol/inputs.md`). So one turn moved about 21%, and silent to full
  took about five turns. The route was not the cause: the SDK and the USB
  report carry the same counts.
- **Screen.** No route draws on the screen. The Hercules SDK's exports
  (`HSM_PrepareGraphicElement`, `HSM_SetGraphicElement`,
  `HSM_SetScreenConfiguration` and the rest, read from the DLL's export table)
  place its own panel elements, 32x32 icons and 110x16 labels, not a 480x272
  image, and their arguments are not documented; the image stream over USB
  needs an initialization that is not decoded yet. The page did not say so.

## Fix

- One step is now 20 counts (`DETENT_COUNTS`, with `COUNTS_PER_TURN` = 512
  beside it): about 26 steps per turn, so the default 2% moves about half the
  range in one turn, the same on every route.
- The Screen group on the plugin's page says Polaris does not draw on the
  controller's screen yet and that the preview shows what it will show.
- Plugin 0.1.12; its "What's new" gains the missing 0.1.9 entry (0.1.10 was never released).

## Verification

- `cargo test -p polaris-stream100` (with and without `--features native`):
  a slow full turn of 512 counts moves 45-60%; the SDK state and the USB
  report give identical turn events for the same movement; the existing
  jitter, creep, acceleration and cap tests hold at the new step.
- Not exercised on the device: the step size is derived from the firmware's
  documented scale, not measured with Polaris' own module.
