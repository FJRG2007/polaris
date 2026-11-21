---
id: BUG-0008
title: Items from a modpack's mods are missing from the Minecraft item picker
status: open
area: game servers / minecraft / item picker
location: dashboard/apps/game-servers/src/lib/minecraft/mod-items-service.ts
related:
  - dashboard/apps/game-servers/src/lib/minecraft/mod-items.ts
  - dashboard/apps/game-servers/src/screens/installed/game-item-picker.tsx
reported: 2026-11-21
---

## What was seen

On a Forge 1.20.1 modpack server, searching the item picker (Items, used to
give or edit a player's inventory) for "vaccine" answered "Nothing matches
that.", although `/give` accepts the item. None of the pack's modded items
were listed.

## Cause (confirmed on the live server and in code)

The picker's modded items come from `mod-items-service.ts`, which only reads
the mods named on the server's `MODRINTH_PROJECTS` setting: it looks each one
up on Modrinth, downloads that jar and reads its items (at most 24 projects).
It never looks at the jars actually installed in the server's mods folder.

On the reporting server `MODRINTH_PROJECTS` is empty, because the mods came
from a modpack: 219 jars sit in `/data/mods`. The item is
`cure:vaccine` from `cure-2.0.2-forge-1.20.1.jar`
(`assets/cure/models/item/vaccine.json`, `assets/cure/textures/item/vaccine.png`).
With an empty list the service returns no modded items, so the picker only
knows vanilla's.

So every server whose mods did not come one by one from the Modrinth list -
modpacks (CurseForge or Modrinth), jars uploaded by hand, a pack switched in -
gets a picker with none of its modded items, and a list past 24 entries gets
only the first 24. The jar reader itself (`mod-items.ts`) is not at fault.

## Fix

In progress: read the jars present in the server's mods folder (working while
the server is stopped), keep the per-jar cache by the jar's SHA-1, keep the
zip and size limits, and continue across requests on large packs. Search
matches the item's label and its id.

## Verified

- Live server: `MODRINTH_PROJECTS` empty, 219 jars in `/data/mods`, the
  `vaccine` item present in the `cure` jar (2026-11-21).

## Not verified

- The fix (not built yet when this was filed).

## If it happens again

The server's `TYPE`, `VERSION` and `MODRINTH_PROJECTS`, the number of jars in
its mods folder, the id `/give` accepts for the missing item, and the jar that
holds it (`unzip -l <jar> | grep <item>`).
