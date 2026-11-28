# Hercules Stream 100: parity with Stream Control

What Hercules Stream Control 2.05 lets a person customise on the Stream 100,
and where Polaris stands on each. Sources: the official user manual
(`Hercules-Stream-100_user_manual.pdf`, ts.hercules.com: "Controlling tracks",
"Controlling actions", "Customization", "Graphic settings", "Custom icon"),
Hercules' Stream Control page ("customize styles, colors and icons"), the
Stream Control release notes (VU meter colour fix in 1.3.2), and the settings
file read from an installed copy (`hercules-stream100.md`, "The official
software").

Status: **have** (before this change), **added** (this change), **not yet**
(possible, not built), **not possible** (and why).

## Screen and look

| Stream Control | Polaris | Status |
| --- | --- | --- |
| Background picture, 480 x 272 (Graphic settings) | `backgroundImage`, cut to 480 x 272 on the page, cover or contain (`backgroundFit`) | added |
| Background colour | `backgroundColor` (Stream Control has none: its background is a picture) | added |
| Text colour | `textColor` | added |
| VU meter colour | `accentColor`, for every knob's volume bar | added (one colour for all knobs, not one per knob) |
| VU meter solid or gradient levels | - | not yet: the device draws a solid bar; a gradient needs the render path (`screen.rs`) |
| Change the appearance of the VU meters and the action area | `labelSize` (knob name size) | have |
| Track icon from a library or a custom 32 x 32 picture | `knob1Image`..`knob4Image`, cut square on the page, drawn at 40 x 40, contain or cover (`knobImageFit`) | added (custom image, or one of the page's icon gallery: search, categories, a color, drawn at the device's size; set from the selected knob on the drawing of the device) |
| ON / OFF status icon (OFF shown while muted) | - | not yet: one picture per knob; a muted one turns the value and bar red instead |
| Inactive source greyed | a dash when nothing it follows plays | have |
| Track name, up to 10 characters | the name of what it follows (Calls, Music, ...) | not yet: no free-text setting kind |
| Action icon and name on the screen above each button | the action zone: each lit button's action name under its knob, on the device and on the page's drawing (call actions named by the plugin, custom and launcher actions by the app in `polaris.state` `actions`) | added (0.1.26, name only; no action icon yet) |
| Volume shown for 1.5 s while turning | the volume is always shown | have |
| Live preview while editing | the drawing of the device shows the look as it is changed | added |
| Screen brightness (back button, short press) | `brightness` | have |
| Screen sleep (back button, long press) | "Screen shows: Off"; the hardware button still works | have |
| Idle screen | `idleAfter`: clock, CPU, memory, disk, network | have (Polaris only) |

## Knobs and buttons

| Stream Control | Polaris | Status |
| --- | --- | --- |
| Drag a source or action onto the drawing of the device | the device replica editor | have |
| Knob: one app, several apps on one knob | categories that follow calls, music, games, browser, system, other | have (by category; a hand-picked list is imported, not driven) |
| Knob: output device | `output` | have |
| Knob press: mute | have | have |
| Mute all / selected / push-to-mute / solo / set a preset volume | - | not yet |
| Keyboard shortcut, open a web page, run a program | custom actions (hotkey on Windows, URL, file, program, macro, two states) | have |
| Change page (two pages) | pages are imported and stored; the engine drives one | not yet |
| Media play/pause, next, previous | imported and stored | not yet |
| OBS / Streamlabs scenes, filters, record, stream, sound | - | not yet |
| Discord mute and deafen | Polaris call mic and deafen | have (Polaris' own calls) |
| Button LEDs: off / on / flashing by state | driven by the plugin from the action's state | have |
| LED colour | - | not possible: the Stream 100's button LEDs have one colour |
| Profiles | profiles that switch by call, meeting, game, app in front, or by hand | have |

## Settings and app

| Stream Control | Polaris | Status |
| --- | --- | --- |
| Language | the desktop app's language | have |
| Tutorial | - | not needed: the editor explains itself |
| App and firmware update | plugin updates from Settings; firmware is Hercules' | have / not possible (Hercules' signed firmware tool) |

## How the look is stored

The look is ordinary plugin settings in the `look` group, so it follows
profiles like every grouped setting. Two setting kinds carry it
(`packages/core/src/device-plugins.ts`): `color` (`#rrggbb`, or "" for the
plugin's own, shown from `fallback`) and `image` (a PNG or JPEG `data:` URL of
at most 2 MB, or ""; the page cuts and scales a picked file to `width` x
`height` before storing it). Every default is "", which the device reads as
today's look, so an existing install looks the same. Pictures stay in the
plugin's settings on the computer the device is plugged into: the device is
drawn from there, offline.

A desktop app before 0.1.138 refuses the whole signed catalog over a setting
kind it does not know, so catalog entries list only `toggle`, `choice`,
`range` and `action` (`clients/device-plugins/scripts/publish.mjs`); the
package's manifest has everything and asks for 0.1.138. A manifest read by
0.1.138 or later drops a setting of an unknown kind instead of the manifest.
