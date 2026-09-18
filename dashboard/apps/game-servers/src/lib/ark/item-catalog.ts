/**
 * Every item the game has, as one lookup.
 *
 * Vendored rather than fetched, and read on the server rather than sent to the
 * browser: what a screen sends back is an item's class, and this is what turns
 * that into the blueprint path a console command takes. A browser that made up a
 * path would therefore be making up a key that is not in this file, which is the
 * point of the arrangement.
 *
 * The file itself is generated - see `resources/arkicons/refresh.mjs` for where
 * the data comes from and how to rebuild it.
 */

import catalog from "./item-catalog.json";

export interface ArkCatalogItem {
    /** The item's class, which keys everything else. */
    readonly key: string;
    readonly name: string;
    /** The blueprint path, without the trailing `_C` and without the wrapper the
     *  command puts around it. */
    readonly bp: string;
    readonly stack: number;
    /** What kind of thing it is, in the game's own words - "Resource",
     *  "Equipment/Saddle". Only used to group the shelves a picker opens on. */
    readonly type: string;
}

const items = catalog.items as readonly ArkCatalogItem[];

const byKey = new Map(items.map((item) => [item.key, item]));

/** One item, or undefined for a key this build does not know - a screen from an
 *  older deploy, or a mod's own item, which is not in the catalogue at all. */
export function findArkItem(key: string): ArkCatalogItem | undefined {
    return byKey.get(key);
}

/** The whole catalogue, for the manifest the browser is served. */
export function arkItems(): readonly ArkCatalogItem[] {
    return items;
}

/** The game version the catalogue was extracted from, for the screen that says
 *  where its list came from. */
export const ARK_CATALOG_VERSION: string = catalog.version;
