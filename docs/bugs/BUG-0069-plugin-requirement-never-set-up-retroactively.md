---
id: BUG-0069
title: A plugin installed before its driver was a requirement never gets the driver, and its page asks for a manual install
status: fixed-watching
area: device-plugins
location: clients/desktop/src/main/plugins/requirements.ts
related:
  - clients/desktop/src/main/plugins/electron.ts
  - clients/device-plugins/hercules-stream100/any/view/view.js
  - clients/device-plugins/hercules-stream100/any/main.cjs
  - clients/device-plugins/hercules-stream100/manifest.json
  - clients/desktop/test/main/plugins/requirements.test.ts
  - clients/desktop/test/main/plugins/hercules-stream100.test.ts
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

Desktop 0.1.130 on Windows, with the Hercules Stream 100 plugin installed before
Polaris' driver became part of its install (plugin 0.1.11). The plugin's page
said "The Hercules driver holds the Stream 100, so it works only through the
Hercules software. Install Polaris' driver from this page." The plugin is meant
to manage the driver itself.

## Cause

`requirements.ensure()` only set up a requirement the install had consented to
(or one Polaris had set up before). An install from before the requirement
existed had neither, so on every start and update the driver was skipped and
only offered as a host action, and the view's copy (`needed`,
`neededHercules`, the `failed` lines, the manifest's `missing` and
`herculesDriver` texts) treated installing it as a manual step from the page.

## Fix

- `ensure()` sets up every missing requirement by itself, consented to or not:
  the system's own prompt (Windows' UAC) is the consent, and a successful first
  setup is kept as consented. A first setup does not raise the "put back"
  notice. A declined or failed setup is not asked again by itself in the same
  run, and is asked again on the next start.
- A plugin update (`notify` with `updated`) sets requirements up right away,
  not only on the next start.
- `actions()` offers a requirement only after its setup was declined or failed;
  a missing one not yet tried is being set up and offers nothing.
- The view says "Setting up the Polaris driver..." while it is missing, and after
  a declined or failed setup says what does not work and points at the page's
  "Set up the driver" action (the requirement's label, renamed from "Install a
  driver for the Stream 100"). No copy asks for an install from the page or a
  reinstall of the Hercules software.

## Verification

Desktop vitest `test/main/plugins` (retroactive setup on start, nothing offered
while setting up, declined offered with its reason, asked again on the next
start; the view's sentences and a sweep that no driver or status text asks for
a manual install). Not exercised on a real Windows machine with the device.
