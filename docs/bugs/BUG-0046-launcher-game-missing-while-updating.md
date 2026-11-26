---
id: BUG-0046
title: An installed game disappears from the launcher while its store updates it
status: fixed-watching
area: desktop
location: clients/desktop/src/main/launcher-stores.ts
related:
  - clients/desktop/src/main/launcher-apps.ts
  - clients/desktop/src/main/launcher.ts
  - clients/desktop/test/main/launcher-stores.test.ts
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

On a friend's Windows PC, typing "fortnite" in the launcher showed another game
instead of Fortnite, which was installed through Epic.

## Cause

Epic was updating Fortnite at the time. Epic sets `bIsIncompleteInstall` on a
game's manifest for the whole of an update, the same flag a first install
carries, and `epicGames()` dropped every manifest with it - so a game already
installed vanished from the listing until the update finished, and the search
fell through to whatever else matched.

The same class existed for Steam: a game whose update is downloading loses the
fully-installed bit (`StateFlags` 4) in its `appmanifest_<id>.acf`, and
`steamGames()` hid it for the whole download. GOG and Ubisoft were not
affected: their readers list a game from its registry entry, which stays in
place through an update.

## Fix

- A game being updated stays listed and is opened through its store's own
  link as before, the store finishing the update first. Its row says
  "updating" beside the store's name.
- Epic: an incomplete manifest stays listed when its `LaunchExecutable` is on
  disk inside `InstallLocation`; a first install without it stays hidden.
- Steam: a manifest without the fully-installed bit stays listed when it has a
  previous `buildid` and its install folder holds files; a first download
  (`buildid` 0) stays hidden, and an app being uninstalled (bit 2048) is left
  out. An update running on an installed game (bits 256, 512, 1024) marks the
  row as updating too.

## Verification

- Fixture tests in `clients/desktop/test/main/launcher-stores.test.ts`: Epic
  updating listed, Epic first install hidden; Steam update downloading and
  update running listed, first download, empty folder and uninstalling hidden;
  an Epic Fortnite manifest mid-update ranks first for "fortnite" and "fort"
  among other installed games that share the letters.
- Not exercised against a real Epic or Steam client mid-update: the Steam rule
  that a first download carries `buildid` 0 comes from the manifest format, not
  from watching one.
