"use client";

/**
 * The item picker, holding ARK's half of it.
 *
 * No typed id here, unlike Minecraft: what the game takes is a blueprint path
 * ninety characters long, it is looked up on the server from the item's class, and
 * an operator who has one to paste is somebody already at a console. The field
 * searches, and the catalogue is the only way to name a thing.
 */

import { ArkItemIcon } from "./ark-item-icon";
import { GameItemPicker, type ItemPickerSource } from "./game-item-picker";
import { ARK_ITEM_CATALOG_URL, readArkItemCatalog, searchArkItems, type ArkItem } from "@/lib/apps/ark/items";

/** Two thousand items, fetched once per tab and shared by every picker in it. */
let catalog: Promise<ArkItem[]> | null = null;

export function loadArkCatalog(): Promise<ArkItem[]> {
    return loadCatalog();
}

function loadCatalog(): Promise<ArkItem[]> {
    catalog ??= fetch(ARK_ITEM_CATALOG_URL)
        .then((response) => {
            if (!response.ok) throw new Error(`The item list answered ${response.status}`);
            return response.json();
        })
        .then(readArkItemCatalog)
        .catch((caught: unknown) => {
            // Not cached as a failure: the next open should be allowed to try
            // again rather than inherit this one.
            catalog = null;
            throw caught;
        });
    return catalog;
}

/** What to call an id the catalogue does not hold - an item given before a
 *  catalogue refresh renamed its class. The class itself is the honest answer. */
function labelOf(id: string): string {
    return id.replace(/^PrimalItem(?:Resource|Consumable|Structure|Ammo|Armor|Skin|Weapon)?_?/, "") || id;
}

const source: ItemPickerSource<ArkItem> = {
    load: loadCatalog,
    search: searchArkItems,
    Icon: ArkItemIcon,
    labelOf,
    placeholder: "Search items",
    whenMissing: "The item list did not load. Reload the page to try again."
};

export function ArkItemPicker(props: {
    value: string | null;
    query: string;
    onQueryChange: (query: string) => void;
    onSelect: (id: string) => void;
    recent?: readonly string[];
}) {
    return <GameItemPicker<ArkItem> source={source} {...props} />;
}
