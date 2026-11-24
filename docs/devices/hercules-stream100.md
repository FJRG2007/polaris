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
| Interface 0 | input: interrupt IN endpoint `0x81`, 64-byte reports. Handled as HID by macOS's HID manager, so it is a HID interface (to confirm with a descriptor dump, below) |
| Interface 1 | display: alternate setting 1, isochronous OUT endpoint `0x01`, 952-byte packets |
| Firmware | `HSM01_S32L4R7_v1_42` ships with Stream Control 2.05.8 |

### Input report (interface 0)

| Byte | Meaning |
| --- | --- |
| 1 | buttons. Knob presses: knob 1 `0x08`, knob 2 `0x01`, knob 3 `0x04`, knob 4 `0x02`. Lit buttons 1-4: `0x10`, `0x20`, `0x40`, `0x80` |
| 3-10 | four signed 16-bit little-endian encoder positions, knob 1 to 4 |

Encoder positions are absolute and wrap at 16 bits; only the difference between
two reports means anything. One detent is 48 counts.

The knob-press bit order is the one OpenStream100 calibrated on hardware. The
Wave Link bridge assumes bits 0-3 are knobs 1-4 in order instead. The two
disagree, so the order is a setting (`KnobMap`) with the calibrated order as
its default, and a real-device test settles it.

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
| Hercules driver, Stream Control closed | can drive the device through the installed Hercules SDK (loaded from its install folder, never redistributed), as the Wave Link bridge does |
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
4. **Zadig / libwdi.** These generate a self-signed certificate per install,
   add it to the machine's Trusted Root and Trusted Publisher stores, sign the
   catalog, and throw the private key away. It works, but it means adding a
   new root to the machine's trust, done with administrator rights by a tool
   that is not Polaris. For an audience that includes government and hospital
   machines, that is not something Polaris does on anyone's behalf. Not offered.

## Why the official software jumps the volume

The complaint: the volume "goes up on its own, too much, sometimes". Stream
Control is closed source and was not disassembled, so these are the causes
the input itself makes possible, each with its guard in
`crates/polaris-stream100/src/encoder.rs`:

| Cause | Guard |
| --- | --- |
| A knob at rest reports a count or two back and forth; summed blindly, it creeps across a step | movements inside the dead band that reverse direction cancel; a partial step untouched for 250 ms is dropped |
| Counts turned while the knob's app was closed are applied all at once when it reopens (OpenStream100 documents this one) | the counts are discarded whenever a knob has no target |
| A USB stall delivers one large delta | one report never moves more than 10% |
| Acceleration with no upper bound | bounded at 3x, and a slow turn always moves exactly the configured step |

## Feature parity

| Feature | Stream Control 2.05 | OpenStream100 | Wave Link bridge | Polaris |
| --- | --- | --- | --- | --- |
| Operating systems | Windows (other systems not checked) | Linux (macOS early) | Windows | Windows, Linux, macOS (input); see status |
| Talks to the device | own driver | libusb, direct | Hercules SDK | direct (`nusb`), or Hercules SDK while its driver is installed |
| Knob follows a fixed app | yes | yes | Wave Link channel | yes (pinned program) |
| Knob follows a category (music, calls, games, browser, system) | no | no | no | yes, a Polaris call first |
| Game detection | no | no | no | the desktop's known games and launcher stores |
| Press to mute | yes | yes | yes | yes |
| Jitter dead band, no banked counts, capped steps | no (see above) | dead band, no banking | detent threshold | all four guards |
| Acceleration | unknown | no | no | bounded |
| Lit button actions | not checked | mute, media, pages, presets | media, launch Wave Link | the Stream Deck action catalogue (call mic, deafen, hang up...) and media keys |
| Display: mixer | yes | yes | yes | through the Hercules SDK for now |
| Display: call participants, now playing | no | no | album art | planned |
| Brightness | not checked | yes | no | message written, not sent yet |
| Pages | not checked | 8 | no | not yet |
| Firmware update | yes | no | no | no (needs the Hercules updater) |

## Status

| Part | State |
| --- | --- |
| Input report decoding, knob engine, display message framing and checksum, image conversion, audio categories, ownership, manifest, settings (read field by field: one bad value resets only itself) | done, unit-tested (`cargo test -p polaris-stream100`) |
| Input on Windows (feature `native`) | the HID API: the largest input collection of `06f8:e053`, opened read-only and shared, one overlapped read at a time with a timeout. Windows puts the report id first (`0` when the device numbers none) and `report::from_hid_read` brings it back to the USB transfer's bytes. Exercised against another HID device (opens, times out, cancels cleanly); never against the Stream 100, which the Hercules driver holds |
| Input on Linux | the USB transport (`nusb`); needs the `uaccess` rule for the device, and without it the add-on says the system does not let Polaris open it |
| Input on macOS | not written (HID manager), so no package is built for macOS |
| Display transport | not written: `nusb` 0.2 has no isochronous transfers, and initialization is not understood (above) |
| Per-app audio backends | Windows Core Audio and PulseAudio/PipeWire done; macOS answers unsupported |
| Desktop binding (`crates/polaris-stream100-node`) | `Controller` (reports in, volume out, actions back) and `Reader` (reads on a worker thread, `await reader.next(500)`) |
| Device add-on (`clients/device-addons/hercules-stream100`) | manifest generated from the crate (`cargo run -p polaris-stream100 --example manifest`, a test keeps them equal), entry `any/main.cjs`, native module built per platform by `.github/workflows/device-addons.yml` (Windows x64, Linux x64). Settings live only on the add-on's page, never in the app's own settings |
| Game category | the engine takes running games (`Controller.setGames`), but the add-on protocol has no method that hands them over yet, so Games follows only the apps the classifier knows |

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
`clients/desktop/src/main/addons/hercules-official.ts` holds the detection, the
uninstaller check and the importer; each is pure and tested on fixtures.

### Carrying out the choice

`clients/desktop/src/main/addons/hercules-official-run.ts` (tested with a fake machine)
does what the person picked, and `official.ts` answers the page through
`window.polarisDesktop.addons.official(id, request)` (`look`, `choose`,
`restore`, `launch`; Windows and `hercules-stream100` only, null otherwise):

- Before any step it keeps a copy in `<userData>/addons/official/<id>/official-software.json`:
  the Run values it may remove and `Stream Control.ini` with every
  `token`/`secret`/`password` line taken out. The first copy is kept across
  later choices; uninstalling the add-on does not delete it.
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
- `system.launchOfficial` (add-on protocol) starts only the `Stream-control.exe`
  a Run value or the copy names. It has no permission of its own on purpose:
  a new permission in the manifest would make every older app refuse the
  whole signed catalog.

### Feature parity with Stream Control 2.05

| Stream Control | Polaris add-on today |
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
from `<Program Files>\Hercules\HSM Series\sdk`. Polaris does not do this yet.
