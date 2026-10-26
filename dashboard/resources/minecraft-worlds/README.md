# Minecraft worlds

World templates a Minecraft server can be created on, and the resource packs two
of them need. Each archive is the map's world folder, repacked so a server can
extract it straight into its data directory: the client-side leftovers of whoever
built it (macOS metadata, per player data, the region files of superseded
formats, client mod caches) are removed and nothing else is changed. Outbound
links inside the maps are stripped.

These are community maps, redistributed so a server can fetch its world while it
is being created:

| Map                          | Minecraft                                |
| ---------------------------- | ---------------------------------------- |
| Skyblock 2.1                 | 1.16.4 world, plays on any later release |
| Parkour Spiral 3.0.3         | 26.2                                     |
| Parkour Spiral 2 2.5.6       | 26.2                                     |
| Parkour Spiral 3 1.4.5       | 26.2                                     |
| Bedwars: Treasure Island 1.0 | 1.19.4                                   |
| Luckyblock Towers            | 1.13 world, plays on any later release   |

If you are the author of one of these and would rather it were not redistributed
here, open an issue and it will be removed.

## How they reach a server

The worlds are not in the Game servers bundle. CI publishes each one as an
artifact of its own in the dashboard's package (`docker/app-bundles.sh worlds`,
tagged `minecraft-world-<name>-<sha12>`), and a dashboard downloads one onto its
data volume only when a server is first created or reset onto that map
(`apps/game-servers/src/lib/minecraft/map-store.ts`), by the sha256 its entry in
`src/lib/minecraft/maps.ts` names. The two resource packs are a few kilobytes and
are staged into the bundle by `apps/game-servers/scripts/stage-assets.mjs`.

The dashboard serves both (`src/lib/minecraft/world-download.ts`): a world to
the server's container, behind the instance's key, and a pack to the players'
clients. Each entry in `maps.ts` carries its archive's hash and size; a test
checks them against the files here.
