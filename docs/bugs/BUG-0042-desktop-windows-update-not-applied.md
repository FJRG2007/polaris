---
id: BUG-0042
title: A Windows copy of Polaris desktop on 0.1.52 never updates itself and says to download the new version by hand
status: fixed, watching
area: desktop
location: clients/desktop/src/main/updates.ts
related:
  - clients/desktop/forge.config.js
  - .github/workflows/desktop.yml
  - clients/desktop/test/build/squirrel-identity.test.ts
reported: 2026-11-25
fixed:
fix_commit:
---

## What was seen

A user on Windows still on 0.1.52 when 0.1.113 was out. Polaris desktop told
him to download the new version by hand; for a while before that it showed no
update notice at all. He never received any release from 0.1.53 to 0.1.113.

## What was ruled out

The releases themselves. Checked on 2026-11-25:

- `RELEASES` of 0.1.52 and 0.1.113 have the same format (UTF-8 BOM, one full
  package line). The 0.1.113 package's SHA-1 and size match its `RELEASES`
  line, and its nuspec id is still `polaris-desktop`.
- The Squirrel package id (`polaris-desktop`), the executable (`polaris.exe`),
  the setup (`Polaris-Setup.exe`), the `desktop-v` tag and the attached files
  did not change between 0.1.52 and 0.1.113, the move to `clients/desktop`
  included. Code signing does not matter here: Squirrel.Windows does not check
  signatures.
- Another Windows install updated itself on its own from 0.1.52 through every
  release since, 0.1.113 included (its `Squirrel-Update.log` lists each
  `--update` run finishing).

So 0.1.52's updater and the release feed work. What differs is that one
machine: 0.1.52 falls back to the download notice when Squirrel's `Update.exe`
is not found above the app's folder (a copy not installed by `Polaris-Setup.exe`),
or when `Update.exe` reports an error, for instance when an antivirus blocks
it. An installed 0.1.52 cannot be changed to do anything else.

`squirrel-identity.test.ts` now pins what every installed copy matches a
release against, so a rename can never strand the installed base.

## Fix (0.1.114)

From 0.1.114 a Squirrel failure on Windows - an error, or "nothing to
install" after the release list named a newer version - is logged with
Squirrel's reason. The release's `Polaris-Setup.exe` is then downloaded,
checked against the size the release lists and `SHA256SUMS`, and becomes the
update's restart: it runs with `--silent` at the same moment an installed
update would restart, so nobody is asked to download anything. Only when that
fails too does the antivirus notice appear, with both reasons. Squirrel is
tried again after 30 minutes, doubling up to a day (`setup-install.ts`).

This does not reach a copy still on 0.1.113 or older until Squirrel works on
it once: their updater is as shipped.

## For the person affected

Download `Polaris-Setup.exe` from the release page the notice opens and run
it. It reinstalls the app over the old one; settings, saved servers and the
API key are kept, since they live in `%APPDATA%\Polaris`, outside the folder
Squirrel replaces.

## If it happens again

Get `%LOCALAPPDATA%\polaris-desktop\Squirrel-Update.log` and
`Squirrel-CheckForUpdate.log` (or `%LOCALAPPDATA%\polaris\` on early
installs), and whether an `Update.exe` sits in that folder. Its last lines say
whether Squirrel was never run, could not download, or failed to apply.
