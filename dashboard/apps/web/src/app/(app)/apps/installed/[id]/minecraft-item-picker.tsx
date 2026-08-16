"use client";

/**
 * The item picker, holding Minecraft's half of it: where the catalogue is, what
 * draws a picture, and that a written-out id is worth offering.
 *
 * Typing has to keep working here and the grid alone is not enough: the icon set
 * is one Minecraft version's, and a modded or newer id belongs to no picture in
 * it. So a query that is itself a valid id is offered as one, and the field stays
 * the source of truth.
 */

import { ItemIcon } from "./minecraft-item-icon";
import { GameItemPicker, type ItemPickerSource } from "./game-item-picker";
import {
    ITEM_CATALOG_URL,
    itemLabel,
    readItemCatalog,
    searchItems,
    typedItemId,
    type CatalogItem
} from "@/lib/apps/minecraft/items";

/** The manifest never changes between deploys, so it is fetched once per tab and
 *  every later picker opens against what is already in memory. */
let catalog: Promise<CatalogItem[]> | null = null;

function loadCatalog(): Promise<CatalogItem[]> {
    catalog ??= fetch(ITEM_CATALOG_URL)
        .then((response) => {
            if (!response.ok) throw new Error(`The item list answered ${response.status}`);
            return response.json();
        })
        .then(readItemCatalog)
        .catch((caught: unknown) => {
            // Not cached as a failure: the picker degrades to a typed id, and the
            // next open should be allowed to try again rather than inherit this.
            catalog = null;
            throw caught;
        });
    return catalog;
}

const source: ItemPickerSource<CatalogItem> = {
    load: loadCatalog,
    search: searchItems,
    Icon: ItemIcon,
    labelOf: itemLabel,
    typedId: typedItemId,
    placeholder: "Search items, or write minecraft:diamond",
    whenMissing: "The item pictures did not load, so type the id - it looks like minecraft:diamond."
};

export function ItemPicker(props: {
    value: string | null;
    query: string;
    onQueryChange: (query: string) => void;
    onSelect: (id: string) => void;
    onDragItem?: (id: string | null) => void;
    recent?: readonly string[];
}) {
    return <GameItemPicker<CatalogItem> source={source} {...props} />;
}
