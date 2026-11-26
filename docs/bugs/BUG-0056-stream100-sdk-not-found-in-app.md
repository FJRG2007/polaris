---
id: BUG-0056
title: The Stream 100 add-on cannot read the controller through the Hercules software from the app
status: fixed-watching
area: device-plugins
location: crates/polaris-stream100/src/native/sdk.rs
related:
  - clients/desktop/src/main/addons/electron.ts
  - clients/device-addons/hercules-stream100/manifest.json
  - docs/devices/hercules-stream100.md
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

With add-on 0.1.6 installed and Hercules Stream Control closed, the add-on's
page said "In use elsewhere - Polaris could not read the Stream 100 through the
Hercules software. Plug it in again, or reinstall Hercules Stream Control."
Unplugging and plugging the controller back in changed nothing. A standalone
probe of the same SDK on the same machine read every knob and button.

## Cause

The desktop app starts each add-on in a utility process with a short list of
environment variables (`addonEnv()`: PATH, SystemRoot, WINDIR, TEMP, TMP, HOME,
LANG, XDG_RUNTIME_DIR). The native module found the SDK folder from the
`ProgramFiles` variable, which is not on that list, so in the add-on process
`sdk_dir()` was `None`, the SDK was never loaded, and every read came back
`notFound`, which the add-on's status turns into the sentence above.

Confirmed on the owner's machine: the installed 0.1.6 module, loaded by plain
node, opened the controller and delivered reports; the same module run with
only the add-on's variables answered `notFound` on every read.

## Fix

- `sdk_dir()` asks the shell for Program Files (`SHGetKnownFolderPath`,
  `FOLDERID_ProgramFiles`) instead of reading the variable. The known folder is
  also what the system says rather than whatever the parent process set.
- Add-on 0.1.7. Only the add-on changes; the desktop app and the dashboard do
  not.
- Swept the crate for other environment lookups: this was the only one.

## Verification

- Unit test `program_files_comes_from_the_shell` (Windows): the folder is
  absolute, exists, and the SDK path ends in `Hercules\HSM Series\sdk`.
- The rebuilt module, run in plain node with only the add-on's variables on the owner's
  machine, opened the controller and delivered reports, where 0.1.6 answered
  `notFound` on every read under the same environment. clippy -D warnings and
  every crate test pass with the `native` feature.
- Not yet confirmed from the desktop app itself on the owner's machine.

## If it happens again

Compare the add-on's reads with and without its environment: load
`stream100.node` from `%APPDATA%\Polaris\addons\packages\hercules-stream100\<version>`
in plain node, call `new Reader().next(500)` for a few seconds, then repeat with
only the variables `addonEnv()` passes. Different answers mean the add-on
depends on something its process is not given.
