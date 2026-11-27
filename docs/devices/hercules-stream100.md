# Hercules Stream 100

Polaris drives the Hercules Stream 100 itself: four endless encoders (press to
mute), four lit buttons and a 480x272 display. The implementation is
`crates/polaris-stream100`; this page is the protocol it implements, what the
official Windows driver adds, and where the work stands.

Sources: two open projects were read to learn the protocol, and the
facts below were checked against the device's own traffic where a recording
exists. No source code was copied from either.

- OpenStream100 (github.com/AnaheimTulley/OpenStream100): Linux, talks to the
  device directly over libusb. No license file, so only facts were taken.
- hercules-wave-link-bridge (github.com/Sam-D03/hercules-wave-link-bridge):
  Windows, MIT, drives the device through the Hercules SDK.

## The device

| Field | Value |
| --- | --- |
| USB id | `06f8:e053` (Guillemot / Hercules) |
| Device class | `00/00/00`, composite (`USB\COMPOSITE` in its compatible ids) |
| Interface 0 | input: interrupt IN endpoint `0x81`, 64-byte reports. Vendor-specific (class `0xFF`) per cont1nuity/hercules-stream-linux `docs/DEVICE-IO.md`, so neither Linux nor macOS binds a class driver and libusb claims it directly |
| Interface 1 | display: alternate setting 1, isochronous OUT endpoint `0x01`, 952-byte packets |
| Firmware | `HSM01_S32L4R7_v1_42` ships with Stream Control 2.05.8 |

### Input report (interface 0)

| Byte | Meaning |
| --- | --- |
| 1 | buttons. Knob presses 1-4: `0x01`, `0x02`, `0x04`, `0x08`. Lit buttons 1-4: `0x10`, `0x20`, `0x40`, `0x80` |
| 2 | bit 0: the power button (New-Hera-lunx, `docs/protocol/inputs.md`) |
| 3-10 | four signed 16-bit little-endian encoder positions, knob 1 to 4 |

Encoder positions are absolute and wrap at 16 bits; only the difference between
two reports means anything. One detent is 48 counts.

The knob-press bit order follows the printed numbers: measured on a real unit
on 2026-11-26 (through the Hercules SDK, whose button word is bytes 1-2 of this
report) and the order New-Hera-lunx reads from the firmware. OpenStream100's
calibration (`0x08, 0x01, 0x04, 0x02`) did not hold. It stays a setting
(`KnobMap`) for a unit that differs.

### Display messages (interface 1)

Every command is inside an `SM` message:

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 2 | `"SM"` |
| 2 | 2 | message length, header included, LE |
| 4 | 2 | checksum, LE |
| 6 | 2 | sequence number, LE, one per message for the whole session |
| 8 | .. | commands |

Checksum: 16 bits, starting at zero, over every byte except offsets 4 and 5;
per byte `crc ^= byte`, then eight times `crc = crc & 1 ? (crc >> 1) ^ 0x8005 : crc >> 1`.
All 192 intact messages in a recording of the official software's
initialization validate with it (the 32 framebuffer templates in that recording
have their pixels blanked, so their stored checksums no longer match, as
expected).

A message longer than 952 bytes continues in the following packets,
zero-padded.

| Command | Bytes | Meaning |
| --- | --- | --- |
| `0x00` | 1 | keep-alive (a 9-byte message), sent about every 18 ms while idle |
| `0x31` | `31 01 00 <0-100>` | backlight brightness |
| `0x32` | 26 | native mixer panel state (four 6-byte channel records) |
| `0x33` | `33 00 00 00 00 01 00` + 512 | palette: 256 RGB565 LE entries |
| `0x34` | 13 | native meter surface |
| `0x37` | `37 01 <chunk> 00 00 00 00 f0 0f` + 4080 + `00` | framebuffer chunk |
| `0x38` | 16 | display configuration (layout); sent once, before the palette |
| `0x14` | .. | batch wrapper used during initialization |

The image is 8-bit indexed: 480 x 272 = 32 chunks of 4080 pixels, row-major.
The first image after connecting carries configuration + palette + chunk 0 in
one 4633-byte message; every later chunk is a 4098-byte message. Re-sending
configuration and palette on every redraw visibly disturbs the panel.

On the wire an image goes in cycles of eight packets per chunk: the five
packets of the chunk message, a packet starting with `HERCULES`, a keep-alive,
and another `HERCULES` packet.

LED state for the four lit buttons is not a separate USB command: it is part
of the native panel objects drawn over the display (a state 0-2 per button; OpenStream100
uses 0 for off and 1 for lit).

### What is not known yet

- **Initialization.** The controller only accepts images after an
  initialization of 192 packets. OpenStream100 replays a recording of the
  official software doing it and patches a few fields. That recording is
  Hercules' traffic, not something Polaris can redistribute, and the meaning
  of most of it is not documented. Until the sequence is understood command by
  command, Polaris draws on the display only through the Hercules SDK.
- **The `HERCULES` framing packets** between chunks are taken verbatim from the
  same recording; their fields are not decoded.
- **The `0x38` configuration**: only its first bytes are known.

### Other sources checked (2026-11-26)

Read as references only; no code was copied.

- **cont1nuity/hercules-stream-linux** (GPL-3.0-or-later; a libusb user-space
  driver for this device, `docs/DEVICE-IO.md` and `docs/PROTOCOL.md`). It
  agrees on interface 0's interrupt IN `0x81` (64-byte reports, low nibble of
  byte 1 the knob presses, high nibble the action buttons, signed 16-bit
  counters at bytes 3/5/7/9) and on interface 1 alt 1, isochronous OUT `0x01`
  in 952-byte packets, and on the `SM` framing (`"SM" | len u16 | CRC-16 |
  seq u16 | ops`, CRC reflected `0x8005`, init 0, bytes 4-5 skipped; a bad CRC
  is dropped silently). It adds what Polaris does not do yet:
  - interface 0 also has a **bulk OUT `0x02`** for host-to-device commands;
  - a logical frame is a `HERCULES` sync packet followed by the 952-byte
    payload packets;
  - the panel is woken with 32 recorded frames, and **heartbeats (op `0x00`)
    go every ~20 ms**: when they stop the panel blanks, and heartbeats alone do
    not repaint it (there is no framebuffer). Polaris' WinUSB keep-alive is one
    heartbeat every 250 ms with no sync packet, enough only if input does not
    depend on it - to be confirmed on a real unit;
  - op `0x30` sets a channel LED, payload `[channel][state]`, 0 off, 1 on,
    2 blink;
  - an isochronous write to a surprise-removed device aborts the process on
    Linux (libusb); it checks the device is still there before every write.
  It documents no USB control transfers, so the start-up reads above
  (`0x52`, `0x02`) come from New-Hera-lunx alone.
- **Sam-D03/hercules-wave-link-bridge** (MIT): drives the Stream 100
  (`VID_06F8&PID_E053`) through the SDK installed by Hercules Stream Control
  (`C:\Program Files\Hercules\HSM Series\sdk`) and needs that software's
  driver; nothing at the USB level. The same route as Polaris' SDK input.
- **mixxxdj wiki, Hercules Linux Usermode Driver** (nealey/hdjd): the DJ
  Control controllers only; the Stream 100 is not covered.

## Windows: the Hercules driver

The "HSM Series drivers" package (`HercStreamMixDevice.inf`, service
`HercStreamMixDevice`, class `MEDIA`, a KMDF driver used through Thesycon's
`tlusbapi` user-mode library) matches `USB\VID_06F8&PID_E053` with no interface
suffix. It therefore replaces Windows' composite driver for the whole device:
while it is installed, nothing but the Hercules SDK (`hsm_api_core_x64.dll`)
can talk to the controller, and the SDK only while Stream Control is closed.

What the driver package adds beyond plain USB access:

- the firmware updater (`HSM01_S32L4R7_v1_42.hsm`);
- the display runtime: native mixer panels, meters, graphic elements,
  `HSM_SetLedStyle`, `HSM_SetAudioLevels`;
- an input callback that hands the same 64-byte report to the app.

### Using the device while that driver is installed

Polaris checks which service is bound to the device and whether
`Stream-control.exe` is running (`ownership::decide`):

| State | What Polaris does |
| --- | --- |
| Hercules driver, Stream Control running | says so, and asks to close Stream Control. It never closes it itself |
| Hercules driver, Stream Control closed | reads the knobs and buttons through the installed Hercules SDK (loaded from its install folder, never redistributed). If that fails, it says so and offers no driver change |
| Windows' own drivers or WinUSB | opens the device directly |
| anything else | names the driver and does nothing |

### "Use Polaris instead of the Hercules driver"

What each route really takes:

1. **Remove the Hercules driver from the device only.** Windows then binds its
   own composite driver, and interface 0 (HID) gets Windows' own HID driver.
   The knobs and buttons work with no driver installed and no certificate
   added. The display is left without a driver, because interface 1 is
   vendor-specific. The Hercules package stays in the driver store, so the way
   back is reinstalling it onto the device, or reinstalling Stream Control.
   **This is the safe option and the one Polaris offers.**
2. **WinUSB on the display interface through a signed INF.** An INF that only
   references Windows' inbox `winusb.inf` still needs a signed catalog.
   Signing it for real means Microsoft attestation signing through Partner
   Center, which needs an EV code-signing certificate. Feasible, not free, and
   not set up today.
3. **WinUSB through MS OS descriptors.** Windows binds WinUSB automatically
   when the device asks for it in its firmware. On this machine the device's
   `usbflags` key holds no `osvc` value, so there is no evidence the firmware
   does. It has to be checked once the Hercules driver is off the device.
4. **Zadig / libwdi style, done by Polaris.** Approved by the owner on
   2026-11-26 and the route Polaris offers now (next section).

### Polaris' WinUSB driver

The plugin declares a toggle, "Polaris driver on this PC" (`polarisDriver`,
off by default). Turning it on runs the setup below and turning it off the
removal; the desktop app (`createDriverSetting` in `plugins/official.ts`) keeps
the new value only when that went through and otherwise writes the old one back.
The plugin's own view (`any/view/`, above the screen preview) is text only: it
asks `driver.look` and says when the toggle is needed (another driver holds the
controller), and why the last change did not go through. A look also brings the
toggle in line with the machine (off once a Hercules reinstall or Windows Update
took the device back). Nothing of it is in the dashboard. One Windows
administrator prompt later the device is on WinUSB and Polaris reads it with
no Hercules software at all: no Stream Control, no `hsm_api_core` DLL, no
`HercStreamMixDevice` driver. The approach is libwdi's (studied as a reference
only, it is LGPL), reimplemented with Windows' own tools in
`clients/desktop/src/main/plugins/hercules-driver.ts`:

| Step | How |
| --- | --- |
| INF | rendered by `renderInf`: Microsoft's WinUSB template, `Include = winusb.inf` / `Needs = WINUSB.NT`, the whole device (`USB\VID_06F8&PID_E053`, no `MI_` suffix), `DeviceInterfaceGUIDs` = `{24a30efc-7c61-4f1a-baaa-f87f84a38ce1}` (`session::DEVICE_INTERFACE_GUID`; a desktop test keeps the two equal) |
| Where | `%ProgramData%\Polaris\stream100-driver`, re-owned by Administrators with SYSTEM/Administrators full and Users read only, reparse points removed first; a fresh `package-<guid>` folder per run |
| Certificate | `New-SelfSignedCertificate -Type CodeSigningCert` (code-signing EKU only, `ca=false`, RSA 3072, non-exportable key), subject `CN=Polaris Stream 100 driver (this PC only), O=Polaris`, public part added to LocalMachine `Root` and `TrustedPublisher` |
| Catalog | `New-FileCatalog -CatalogVersion 2.0`, signed with `Set-AuthenticodeSignature` (SHA-256), then the private key is deleted (`-DeleteKey`, in a `finally`), so nothing else can ever be signed with it |
| Binding | `UpdateDriverForPlugAndPlayDevicesW` with `INSTALLFLAG_FORCE` (Hercules' package is Microsoft-signed and would outrank ours otherwise) |
| Record | `state.json` beside it: our published `oemNN.inf`, the INF the device had before, the certificate's thumbprint |
| Uninstall | removing the plugin runs the elevated script's `remove` first: `pnputil /delete-driver <ours> /uninstall /force`, our certificates out of `My`/`Root`/`TrustedPublisher`, the previous INF put back on the device (Hercules' package stays in the driver store, so it simply returns), `pnputil /scan-devices`. A declined prompt keeps the plugin installed |

The elevated side takes nothing from the unelevated one but the action: the
INF is inside the script, every path comes from `%ProgramData%` and
`%SystemRoot%`. The desktop writes the script, and the elevated PowerShell
(started through `runElevated`: an argument array, never a shell command line
built from input) reads it once, checks its SHA-256 against the value baked
into its own command, and runs those same bytes. Exit codes: 0 done, 1223
declined, 10 certificate, 11 signing, 13 binding, 14 unplugged, 20 removing,
87 integrity; each has its own sentence on the page.

The plugin then reads the controller through `native::winusb`
(`crate::session`): interface 1 to alternate setting 1, the vendor reads `0x52`
and `0x02`, reports from `0x81`, and an `SM` keep-alive on the isochronous
endpoint `0x01` every 250 ms (`WinUsb_WriteIsochPipeAsap`; `nusb` 0.2 has no
isochronous transfers). Request `0xF2` (reboot to the firmware updater) and
flash writes can never be built. The Hercules SDK route stays as the fallback
for a PC that keeps Hercules' driver.

Not exercised yet: none of this has run on a real PC; no driver or certificate
was installed from the development machine. The owner's test steps are the
first run.

## Status

| Part | State |
| --- | --- |
| Input report decoding, knob engine, display message framing and checksum, image conversion, audio categories, ownership, manifest, settings (read field by field: one bad value resets only itself) | done, unit-tested (`cargo test -p polaris-stream100`) |
| Input on Windows (feature `native`) | the HID API: the largest input collection of `06f8:e053`, opened read-only and shared, one overlapped read at a time with a timeout. Windows puts the report id first (`0` when the device numbers none) and `report::from_hid_read` brings it back to the USB transfer's bytes. Exercised against another HID device (opens, times out, cancels cleanly); never against the Stream 100, which the Hercules driver holds |
| Session on Linux and macOS | `session::Session`, the same driver the WinUSB route runs (start-up reads, keep-alive, reports), over libusb (`native::libusb`, libusb 1.0 built from its vendored source into the module: nothing to install). Each system supplies only a `session::Link`. Built by CI; never run on a real unit on either system |
| Linux access | the `uaccess` udev rule `/etc/udev/rules.d/70-polaris-stream100.rules` (sorted before `73-seat-late.rules`, where udev turns the tag into the seat user's ACL), installed by the desktop app with one polkit prompt (`pkexec`) when "Polaris driver on this PC" is switched on, removed when it is switched off (`clients/desktop/src/main/plugins/hercules-udev.ts`). Without it the plugin says the system does not let Polaris open the controller |
| macOS access | nothing to set up: no driver claims the vendor interfaces |
| Display transport | not written: `nusb` 0.2 has no isochronous transfers, and initialization is not understood (above) |
| Per-app audio backends | Windows Core Audio and PulseAudio/PipeWire (PipeWire through `pipewire-pulse`) done. macOS: the whole output only (Core Audio volume and mute of the default output, `native::macos`); per-app volume is not built. macOS has no per-app volume API: per-app mixers either install a HAL audio driver (Background Music) or, on macOS 14.2+, mute each app with a process tap (`AudioHardwareCreateProcessTap`) and play it back through a private aggregate device at its own gain, which also needs the desktop app to declare `NSAudioCaptureUsageDescription` and the person to grant audio capture. Until then a knob set to an app category does nothing on macOS, and the plugin's audio status says so |
| Desktop binding (`crates/polaris-stream100-node`) | `Controller` (reports in, volume out, actions back) and `Reader` (reads on a worker thread, `await reader.next(500)`) |
| Device plugin (`clients/device-plugins/hercules-stream100`) | manifest generated from the crate (`cargo run -p polaris-stream100 --example manifest`, a test keeps them equal), entry `any/main.cjs`, native module built per platform by `.github/workflows/device-plugins.yml` (Windows, Linux and macOS, x64 and arm64; Windows arm64 and macOS x64 cross-compiled). Settings live only on the plugin's page, never in the app's own settings |
| Game category | the engine takes running games (`Controller.setGames`), but the plugin protocol has no method that hands them over yet, so Games follows only the apps the classifier knows |

### Needed from a real device

Nothing here has touched the controller. A first test needs, on a machine with
the Stream 100 plugged in:

1. A configuration descriptor dump, to confirm interface 0 is HID and read
   interface 1's endpoints. On Linux, `lsusb -v -d 06f8:e053` is enough; on
   Windows it needs the Hercules driver off the device (route 1).
2. Permission to remove the Hercules driver from the device (route 1) and to
   put it back afterwards, to confirm the knobs work with Windows' own drivers
   and to check for MS OS descriptors.
3. Turning each knob and pressing each button once while reports are logged,
   to settle the knob-press bit order.

## The official software

What Hercules installs on Windows (read from an installed Stream Control
2.05.8, nothing changed):

| Part | Where |
| --- | --- |
| App | "Hercules Stream Control", publisher `Hercules`, uninstall key `{4E736157-448C-4D22-BF3F-1C58BE6E9B9E}`, `Stream-control.exe` (Qt 6) |
| Drivers | "HSM Series drivers", publisher `Hercules`, uninstall key `{B59074DF-80BE-4F30-AE11-6AB0B93EDE56}`, `oem*.inf` from `HercStreamMixDevice.inf`, provider Guillemot Corporation, 1.2.2.0 |
| Uninstallers | InstallShield: `"<Program Files (x86)>\InstallShield Installation Information\<key>\setup.exe" -runfromtemp -l0x0409 -removeonly` (drivers add `-remove`) |
| Start with Windows | `HKLM\Software\Microsoft\Windows\CurrentVersion\Run`, value `Hercules-Stream-Control`, unquoted path, `-minimized`. Removing it needs administrator rights |
| Service | `hercHsmInstall` (driver installer helper), start mode Disabled |
| Settings | `%APPDATA%\Hercules\Stream Control\Stream Control.ini` (QSettings), icons beside it |
| macOS | none: Hercules ships the Stream 100 software for Windows only |

**The Stream 100 has no sound card.** It registers no audio endpoint and no
kernel-streaming audio interface; the driver's `MEDIA` class is only the class
its INF chose. Every sound on the machine goes through other devices, so
removing the Hercules driver cannot take sound away. What it takes away is
Stream Control itself, the display runtime and the firmware updater.

The settings file is a QSettings ini. Each control is a `@Variant(...)`
QVariantMap streamed with `QDataStream::Qt_4_0` (type id then value, no null
flag), under `[Device_SN_<serial>]`, `pages\page_<n>\pageContent\<1-4>\`
`knobDescriptor`/`knobCustomization`/`buttonDescriptor`/`buttonCustomization`.
A descriptor's `nameHierarchy` is Stream Control's own menu path (`Apps >
Multi-app volume`, `Discord > Mute`, `Actions > Next page`); a knob's
customization holds its preset `name` and the app `sources` it follows. The
same file holds the person's Discord, Spotify and OBS tokens: Polaris reads only
the `pages\...` keys and never parses or keeps the rest.
`clients/desktop/src/main/plugins/hercules-official.ts` holds the detection, the
uninstaller check and the importer; each is pure and tested on fixtures.

### Carrying out the choice

`clients/desktop/src/main/plugins/hercules-official-run.ts` (tested with a fake machine)
does what the person picked, and `official.ts` answers the page through
`window.polarisDesktop.plugins.official(id, request)` (`look`, `choose`,
`restore`, `launch`; Windows and `hercules-stream100` only, null otherwise):

- Before any step it keeps a copy in `<userData>/plugins/official/<id>/official-software.json`:
  the Run values it may remove and `Stream Control.ini` with every
  `token`/`secret`/`password` line taken out. The first copy is kept across
  later choices; uninstalling the plugin does not delete it.
- Stream Control is asked to close (`taskkill /im`), and forced (`/f`) only if
  it is still running 5 seconds later.
- A Run value is removed with `reg.exe delete`; the HKLM one goes through
  Windows' administrator prompt (PowerShell `Start-Process -Verb RunAs`, the
  arguments in its environment). A declined prompt stops the choice there.
- An uninstaller runs only after `Get-AuthenticodeSignature` says `Valid` with
  a `CN=`/`O=` of Guillemot, the path passed in the environment, never in the
  command.
- Restore re-adds the Run values whose program still exists, writes the copy
  back with today's sign-in lines put back in their sections, and starts
  Stream Control. An uninstall cannot be undone from here: only the settings
  go back.
- `system.launchOfficial` (plugin protocol) starts only the `Stream-control.exe`
  a Run value or the copy names. It has no permission of its own on purpose:
  a new permission in the manifest would make every older app refuse the
  whole signed catalog.

### Feature parity with Stream Control 2.05

| Stream Control | Polaris plugin today |
| --- | --- |
| Pages of 4 knobs + 4 buttons, Next/Previous page buttons | imported and stored (`Settings.pages`, up to 8, `layout.json`); the engine still drives one page |
| Profiles (`profiles`, `LastProfileKey`) | in the settings model (`Settings.profiles`); not imported: the only real file read has `profiles=@Invalid()` |
| Knob: multi-app volume with a chosen app list | have as categories (calls, music, games, browser, system, other); a hand-picked app list is imported and stored (`PageKnob::Apps`, by display name), not yet driven |
| Knob: one app, output device, microphone | output: have; one app and microphone: in the settings model (`PageKnob::Program`, `Microphone`), not yet driven or imported (descriptor names not seen yet) |
| Knob press: mute | have |
| Button: Discord mute / deafen (Discord RPC) | imported and stored (`PageAction::Discord`); not driven (Polaris call mic/deafen exist instead) |
| Button: media play/pause, next, previous | imported and stored (`PageAction::Media`); not yet driven |
| Buttons: OBS / Streamlabs scenes, Voicemeeter, soundboard, hotkeys | missing |
| Button toggled / untoggled labels | in the settings model (`PageButton.toggled_label`); not imported (its key not seen yet) |
| Knob and button colors, LED brightness | missing |
| Display: mixer, meters, icons, background image | display: only through the Hercules SDK, not built |
| Broadcast / creator mode | missing |
| Firmware update | not Polaris's |

### The driver interface

hercules-wave-link-bridge reads the knobs through the Hercules driver itself,
with the official app closed and the driver left in place: it opens the device
interface `{abee8c27-397b-409d-b6dc-6161ca409d8d}`, sends `DeviceIoControl`
`0x001E200C`, `0x001E2008`, `0x001E2010` (4-byte answers), `0x001E2024` and
`0x001E2034` (4 zero bytes in), then polls `0x001E2000` for a 64-byte input
packet every few milliseconds. The display goes through `hsm_api_core_x64.dll`
from `<Program Files>\Hercules\HSM Series\sdk`.

### Input through the Hercules SDK

What Polaris does (`crates/polaris-stream100/src/native/sdk.rs`, layouts in
`src/sdk.rs`), only when Windows has no HID collection for the device and
Stream Control is not running:

1. Loads `tlusbapi_x64.dll`, then `hsm_api_core_x64.dll`, by full path from
   `<Program Files>\Hercules\HSM Series\sdk`, each only after its
   Authenticode signature is valid and signed by Guillemot (the file is held
   open against writes from the check to the load).
2. Binds eight exports: `HSM_Get_SDK_Version`, `HSM_Init`, `HSM_Exit`,
   `HSM_IsDeviceChanged`, `HSM_GetDeviceCount`, `HSM_GetDeviceInfo` (a 0x640
   structure whose first field is its size; VID at 0x20C, PID at 0x20E),
   `HSM_OpenDevice(index, int* handle, callback, user)`, `HSM_CloseDevice`.
   Nothing that sets the screen, the LEDs or the firmware.
3. `HSM_Init`, then polls `HSM_IsDeviceChanged` and the count every 100 ms for
   up to 3 s, opens the Stream 100's index, and lets the SDK's own thread keep
   the session alive (its 500 ms keep-alive).
4. The callback `int cb(int handle, const HSM_INPUT*, void* user)` hands over a
   0x60-byte state: `+0x00` u32 time, `+0x04` u32 buttons, `+0x0C` four i16
   encoders, `+0x1C`/`+0x3C` VU floats, `+0x5C` screen state. Button bits:
   knob presses 1-4 are 0x01/0x02/0x04/0x08, lit buttons 1-4 0x10/0x20/0x40/0x80,
   power 0x100. Each is moved to the HID layout's bit, so both routes share one
   decoder, its 16-bit wrap and the press-jitter filter.
5. The SDK calls back only on a change, so the first state is preceded by a
   baseline with nothing held.

Measured on a real unit (firmware 1.40, SDK 0x153) on 2026-11-26 with a
standalone probe that makes the same calls; the callbacks are kept verbatim in
`crates/polaris-stream100/tests/fixtures/sdk-states.txt` and replayed by
`tests/sdk_states.rs`:

- Callbacks arrive on the SDK's own thread on every change; the calling thread
  needs no message loop (1350 callbacks, 0 window messages).
- Every knob counts up clockwise on its own encoder (`+0x0C` + 2 x knob). A
  slow turn is one count per callback; a fast one up to 8 (once 21) per callback,
  about every 16 ms. The encoders start at arbitrary absolute values (e.g.
  -4992), so only the 16-bit-wrapped delta from the first state counts.
- The button bits above, each control pressed alone in order. Power is one
  click that sets and clears 0x100; the screen-state byte went 0xBC -> 0xD0.
- A knob press nudged knob 1 by 1 count twice as the finger landed, 1 while
  held, and 3 then 2 in the two callbacks after the release; knobs 2-4 did
  not move. The filter drops the held and release nudges; the two before the
  switch closes are far below one volume step and dropped as a partial step.
- The log has no detent marker, so it does not measure counts per detent; the
  HID route's 48 is kept.

The Polaris plugin itself has not been run against the device; only the probe
has.
