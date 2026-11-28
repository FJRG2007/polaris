# BUG-0076 - The Stream 100's screen turns blocky whenever it redraws, and its page does not follow the device

- Reported: 2026-11-28 (owner, plugin 0.1.25 + desktop 0.1.138; reported before)
- Area: Device plugins - Hercules Stream 100
- Status: Fixed, watching (not seen on the device: no device on the development machine)

## What was seen

1. When the screen had to redraw (a knob turned, an app's volume changed) the whole
   panel looked pixelated, and stayed so while anything kept changing.
2. The device drawing on the plugin's page (`/account/plugins/hercules-stream100`)
   showed sample volumes, never the device's own, so nothing moved there live.

## Cause

1. The panel takes a page as 32 interlaced tiles, and the firmware fills a block
   around each sample of the coarse ones across the whole screen (8x4 for tile 0;
   the official SDK's table, CataclysmX/New-Hera-lunx `hsm01-proto/src/background.rs`).
   Polaris draws the volumes into that page, so every new volume needs tile 0 again.
   `Painter::next_tile` (`crates/polaris-stream100/src/screen.rs`) always picked the
   first owed tile from 0, so during a turn tile 0 went out on every new volume and the
   panel never got past its 8x4 blocks until the turn stopped plus 1.3 s.
2. The plugin process had no way to tell the host what the device shows: its messages
   were `ready`, `log`, `status` and `call` (`clients/desktop/src/shared/plugin-protocol.ts`),
   and `ScreenPreview` (`plugin-look.tsx`) drew a fixed sample.

## Fix

1. A pass, once begun, runs on to the finest tiles before a coarse one goes out again
   (`Painter.cursor`); another page altogether (idle, call, now playing) still starts
   from the coarsest at once. The lines between the knob columns are gone too.
2. The plugin sends `state` (each knob's name, volume, mute) when it changes, at most
   every 200 ms, only to a host that says `live: true` at start; the desktop app keeps
   the newest per plugin and pushes it on `desktop:plugins-live`; the page reads it
   with `usePluginLive` and the drawing shows it.

## Tests

- `crates/polaris-stream100/tests/screen.rs`: `a_long_turn_never_keeps_the_whole_screen_in_coarse_blocks`,
  `the_mixer_page_has_no_lines_between_the_knobs`.
- `clients/desktop/test/main/plugins/supervisor.test.ts`: live values passed on, wrong shapes dropped.
- `dashboard/apps/web/test/account/plugin-screen-live.test.tsx`: the drawing follows pushes without a reload.

## Not verified

Nobody looked at the real device. The durable fix is Stream Control's: upload the
background once and let the firmware draw icons, labels and volume (0x35/0x36/0x41).
