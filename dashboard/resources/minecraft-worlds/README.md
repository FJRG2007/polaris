# Minecraft worlds

World templates a Minecraft server can be created on, and the resource packs two
of them need. Each archive is the map's world folder, repacked so a server can
extract it straight into its data directory: the client-side leftovers of whoever
built it (macOS metadata, per player data, the region files of superseded
formats, client mod caches) are removed and nothing else is changed. Outbound
links inside the maps are stripped.

These are community maps, redistributed so a server can fetch its world while it
is being created. Credit and the page each one came from:

| Map | Author | Minecraft | Source |
| --- | --- | --- | --- |
| Skyblock 2.1 | Noobcrew | 1.16.4 world, plays on any later release | https://skyblock.net |
| Parkour Spiral 3.0.3 | Hielke | 26.2 | https://hielkemaps.com/maps/parkour-spiral |
| Parkour Spiral 2 2.5.6 | Hielke | 26.2 | https://hielkemaps.com/maps/parkour-spiral-2 |
| Parkour Spiral 3 1.4.5 | Hielke | 26.2 | https://hielkemaps.com/maps/parkour-spiral-3 |
| Bedwars: Treasure Island 1.0 | TriplicataMC | 1.19.4 | https://www.minecraftmaps.com/51834-bedwars-treasure-island |
| Luckyblock Towers | Polaris | 1.13 world, plays on any later release | https://www.minecraftmaps.com |

If you are the author of one of these and would rather it were not redistributed
here, open an issue and it will be removed.

## How they reach a server

`apps/game-servers/scripts/stage-assets.mjs` stages this folder into the Game
servers bundle, so only an instance that installed Game servers carries them.
The dashboard serves them from there (`src/lib/minecraft/world-download.ts`): a
world to the server's container, behind the instance's key, and a pack to the
players' clients. Each entry in `src/lib/minecraft/maps.ts` names its archive
and carries its hash and size; a test checks them against the files here.
