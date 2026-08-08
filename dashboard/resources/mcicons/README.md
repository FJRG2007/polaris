# McIcons

Item icons for the Minecraft panel: one 64x64 PNG per item id, named
`minecraft_<item>.png` (so `minecraft:diamond_sword` is `minecraft_diamond_sword.png`).

## Where they come from

- Upstream: <https://github.com/themuhamed/mcicons>, `public/icons`
- Commit: `d354ecc3984dd03862b7b38676293d5a22609d09`
- License: MIT
- Artwork depicts items from Minecraft, a Mojang Studios product.

Vendored rather than fetched: upstream publishes a Composer package only, and the
dashboard loads no asset from a CDN.

## How they reach the app

`apps/web/scripts/copy-mcicons-assets.mjs` stages this folder into
`apps/web/public/mcicons` and writes `items.json` (the ids, for the item picker).
It runs from the web app's `predev` and `prebuild` hooks, so a local install picks
the icons up with everything else. The staged copy is not committed.

## Refreshing them

Replace `icons/` with the upstream `public/icons`, update the commit above, and
rebuild. Anything the set does not cover falls back to a placeholder in the UI, so
a partial update degrades rather than breaks.
