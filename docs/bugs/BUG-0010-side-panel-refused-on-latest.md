---
id: BUG-0010
title: The side panel says it needs Minecraft 1.16 on a 1.20.1 server
status: fixed-watching
area: game servers / minecraft / side panel
location: dashboard/apps/game-servers/src/lib/minecraft/server-release.ts
related:
  - dashboard/apps/game-servers/src/lib/minecraft/sidebar.ts
  - dashboard/apps/game-servers/src/lib/minecraft/live-display-service.ts
  - dashboard/apps/game-servers/src/screens/installed/live-display-actions.ts
  - dashboard/apps/game-servers/src/lib/games-service.ts
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(game-servers): a server recorded as LATEST is checked against the release it really runs"
---

## What was seen

On a Forge 1.20.1 modpack server, Side panel said "The side panel needs
Minecraft 1.16 or newer on this server" and could not be switched on.

## Cause (confirmed on the live server and in code)

The side panel read the release only from the install's recorded
`mcRelease`. For this server that is the literal `LATEST` it was created with;
the modpack set the real release in the `VERSION` setting (`1.20.1`) and the
record never moved. `atLeast()` in `sidebar.ts` turned `LATEST` into the
number 0, so the server read as older than 1.16. Three other live servers also
record `LATEST` (lucky-blocks, skyblock) and were refused the same way.

## Fix

One resolver, `server-release.ts`: the recorded release when it names one,
otherwise the `VERSION` setting, otherwise unknown. The side panel's screen and
its drawing loop, and the release shown on the server list, use it. A release
that is not a number (`LATEST`, a snapshot name) is read as recent, like
`versionAtLeast`, never as too old. The 1.20.1 server now also gets the
pre-1.20.3 way of drawing the panel, which the release decides.

## Verified

- `test/apps/game-live-display.test.ts`: `LATEST` and `26.3` are supported;
  `LATEST` with `VERSION=1.20.1` resolves to 1.20.1 and the legacy drawing.
- Live server data: cursed `mcRelease=LATEST`, `VERSION=1.20.1`.

## Not verified

- The panel drawn on the live server (needs the next dashboard publish).

## If it happens again

The install's `mcRelease`, the server's `VERSION` and `TYPE`, and the release
the game reports in its log ("Starting minecraft server version").
