---
id: BUG-0068
title: A device plugin never updates while another program holds its device, and Update gives no answer
status: fixed-watching
area: device-plugins
location: clients/desktop/src/main/plugins/updates.ts
related:
  - clients/desktop/src/main/plugins/manager.ts
  - clients/desktop/src/main/plugins/install-call.ts
  - clients/desktop/src/main/plugins/electron.ts
  - dashboard/apps/web/src/lib/device-plugins-client.ts
  - dashboard/apps/web/src/app/(app)/account/plugins/plugins-view.tsx
  - clients/desktop/test/main/plugins/updates.test.ts
  - clients/desktop/test/main/plugins/manager.test.ts
  - clients/desktop/test/main/plugins/install-call.test.ts
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

The Stream 100 plugin stayed on 0.1.12 while the published list offered 0.1.17.
It never updated by itself, and pressing Update on its card showed nothing: no
progress, no error. `installed.json` had not been written since desktop 0.1.121
and no newer package had been downloaded.

## Cause

Hercules Stream Control was running, so the plugin reported its status as
`busy` (code `herculesApp`: another program has the controller).
`decideUpdate()` answered `wait` for any busy plugin, and the update was held
until the status changed, which with Stream Control left open was never. Nothing
said it was waiting. The busy rule was meant for a plugin in the middle of using
its device; a plugin locked out of the device is using nothing.

The manual Update never answered on the owner's machine. The install itself
works on the owner's real files (catalog, signature, 0.1.17 package, an
`installed.json` from 0.1.12), and the page calls the bridge, so the call
was left pending between the two: the install queue had no time limit, a throw
inside the IPC handler had no answer of its own, and nothing about it was kept
on disk to read afterwards.

## Fix

- `busyHoldsUpdate()`: a busy status whose `code` says another program or driver
  holds the device (`otherProgram`, `herculesApp`, `herculesDriver`) does not
  hold the automatic update. A busy plugin with no such code still waits.
- Update pressed by the person never checks busy.
- The install call has a limit (`INSTALL_LIMIT_MS`, 3 minutes) and answers
  `{ ok: false, reason: "timeout" }` past it; a queued call that timed out does
  nothing when its turn comes. A throw answers `failed`. The IPC handler
  (`install-call.ts`) answers on every path, on both channel names (older
  dashboards call `desktop:addons-install`), and what runs after a finished
  install (keeping the consent) can neither fail it nor hold the answer.
- Each install and automatic update writes its start and end, and a held update
  writes why, to `logs/perf.log` (`plugin-install`, `plugin-update`,
  `plugin-update-wait`).
- The card shows the install as soon as it is asked for, even while queued, and
  says "Updating" for an installed plugin. A timeout reads as its own sentence.

## Verification

`updates.test.ts`: `busyHoldsUpdate` per code; a plugin busy with
`herculesApp` gets its automatic update; a plugin busy with no code waits, and
a manual Update still goes in. `manager.test.ts`: a stuck download answers
`timeout` within the limit, shows on the snapshot at once, logs start and end,
and a second queued call never downloads. `install-call.test.ts`: refused,
answered, thrown, and a failing or hanging step after the install all answer.
`device-plugins-client.test.ts`: the Updating offer and the timeout sentence.
Not exercised on the owner's machine with the real Stream 100 and Stream
Control: why the call stayed pending there is not proven, but it now answers
within the limit and the log says where it stopped.
