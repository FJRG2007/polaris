---
id: BUG-0008
title: Items from a modpack's mods are missing from the Minecraft item picker
status: fixed-watching
area: game servers / minecraft / item picker
location: dashboard/apps/game-servers/src/lib/minecraft/mod-items-service.ts
related:
  - dashboard/apps/game-servers/src/lib/minecraft/mod-items.ts
  - dashboard/apps/game-servers/src/screens/installed/game-item-picker.tsx
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(game-servers): the item picker lists every item the jars in a server's mods folder add, modpacks included"
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

The service now reads the jars actually in the server's mods folder
(`/data/mods`, the folder Forge, NeoForge, Fabric, Quilt and the hybrids all
load from) before the Modrinth list, for every server whose software loads mods,
a modpack, a custom jar or a `TYPE` the catalogue does not know. Vanilla, plugin
servers and an unset `TYPE` do no extra work.

- One streamed `find` lists the folder (new optional `readCommand` port: the
  local daemon's read route, which also answers for a stopped server; SSH runs
  it in the running container). Each jar is read through the same file access
  as the Files browser, hashed (SHA-1 of the bytes read) and looked up in the
  existing per-build cache before it is unpacked. An index per server
  (name, size, mtime -> SHA-1) means a reopened 300-jar pack costs one listing.
- The 24-project cap applies only to the Modrinth list. Jar size, zip-bomb and
  read limits are unchanged; the whole picker carries up to 40000 items. Jars
  the 45 s budget does not reach are read on the next request, and the picker
  now asks again by itself (up to 12 times, 1.5 s apart) while it is open.
- Labels come from `en_us` and, when the jar has it, the reader's language
  (`es_es`); the English label is still searched. Search covers label, id,
  namespace and mod name, case-insensitive.
- Not covered: items registered by KubeJS startup scripts (JavaScript, not
  derivable without running it). Data packs cannot add items.

## Verified

- Live server: `MODRINTH_PROJECTS` empty, 219 jars in `/data/mods`, the
  `vaccine` item present in the `cure` jar (2026-11-21).
- `dashboard/apps/web/test/apps/game-mod-folder-items.test.ts`: a folder with
  `cure-2.0.2-forge-1.20.1.jar` (item model, `en_us` + `es_es`) and a library,
  through a fake file port: "vaccine", "VACCINE", "cure:vaccine" and "cure"
  find `cure:vaccine`; an unchanged jar is not read again; a touched one is
  read once and answered from its hash; a broken jar is named and the rest
  still read; an exhausted budget is `complete: false` with nothing unread.
- Web typecheck (`tsconfig.typecheck.json`) and the game-servers tests.

## Not verified

- Not exercised against the live server or a real container (no Docker on the
  development machine): the `find -printf` listing, reading jars of a stopped
  server through the daemon, and how long the first read of 219 jars takes.
- A server on a registered (SSH) machine is only read while it is running.

## If it happens again

The server's `TYPE`, `VERSION` and `MODRINTH_PROJECTS`, the number of jars in
its mods folder, the id `/give` accepts for the missing item, and the jar that
holds it (`unzip -l <jar> | grep <item>`).
