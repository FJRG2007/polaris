# Default player skins

The skins the Java Edition client draws a player in when their profile carries no
skin of its own: nine characters, each in the classic (`wide/`) and the slim
(`slim/`) arm model. 64x64 PNGs, named `<model>/<character>.png`.

## Where they come from

- Mojang's client jar for release 26.3, as listed by
  <https://piston-meta.mojang.com/mc/game/version_manifest_v2.json>
- `client.jar` SHA-1: `e877b6a07acd633fb3bb475002175cec036e7b87`
- Path in the jar: `assets/minecraft/textures/entity/player/{wide,slim}/*.png`
- Artwork from Minecraft, a Mojang Studios product.

Which of the eighteen a player gets is decided by the client from their UUID;
`apps/game-servers/src/lib/minecraft/default-skin.ts` reproduces that choice and
records where it was read from.

## How they reach the app

`apps/game-servers/scripts/stage-assets.mjs` stages this folder into the Game
servers bundle, which serves it under
`/api/app-bundles/game-servers/current/assets/default-skins/`. The staged copy is
not committed.

## Refreshing them

Replace `wide/` and `slim/` with the same folders from a newer client jar, update
the release and hash above, and check that the class `DefaultPlayerSkin` still
lists the same eighteen paths in the same order.
