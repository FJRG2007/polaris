# ArkIcons

Item pictures for the ARK panel: one 64x64 WebP per item class, named after the
class (so `PrimalItemResource_Wood.webp` is Wood). The catalogue they belong to -
name, blueprint path, stack size - lives beside the code that reads it, at
`apps/web/src/lib/apps/ark/item-catalog.json`.

## Where they come from

- Item data: [Project Obelisk](https://github.com/arkutils/Obelisk),
  `data/wiki/items.json` - the published output of
  [Purlovia](https://github.com/arkutils/Purlovia), which reads the game's own
  assets. It is what gives each item the blueprint path an admin command takes.
- Pictures: the [official community wiki](https://ark.wiki.gg), whose item pages
  name their icon file. Wiki content is CC BY-NC-SA 4.0; the artwork itself depicts
  ARK: Survival Evolved, a Studio Wildcard product.

Vendored rather than fetched, like the Minecraft set: the dashboard loads no asset
from a CDN and no build step reaches the network.

## How they reach the app

`apps/web/scripts/copy-arkicons-assets.mjs` stages `icons/` into
`apps/web/public/arkicons` and writes `items.json` beside it - the catalogue minus
the blueprint paths, which is what the item picker searches. It runs from the web
app's `predev` and `prebuild` hooks. The staged copy is not committed.

The paths stay on the server on purpose. A screen sends back an item's class and
the give action looks the path up from the committed catalogue, so a browser cannot
name a blueprint of its own.

## Refreshing them

From `dashboard/`:

```
node resources/arkicons/refresh.mjs
```

It re-reads the item list, asks the wiki which picture belongs to each item, and
fetches the ones that are not already on disk - so a run that is interrupted can
simply be run again. Both `icons/` and `item-catalog.json` are rewritten; commit
them together.

About one item in eight has no picture on the wiki (event portals, boss summons,
a few unreleased things). Those draw as a placeholder, which is also what a modded
item does, so a partial set degrades rather than breaks.
