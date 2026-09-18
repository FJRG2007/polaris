"use client";

/**
 * The item picker, holding Minecraft's half of it: where the catalogue is, what
 * draws a picture, and that a written-out id is worth offering.
 *
 * Two catalogues rather than one. The vanilla set is a static file, the same on
 * every server, and it is what the grid draws the instant it opens. What the
 * server's own mods add is a question only that server can answer - it means
 * reading the jars on its mod list - so it arrives second and is appended, which
 * is why the picker never waits on it.
 *
 * Typing still works and still matters: a server can carry a mod installed from a
 * file rather than from Modrinth, and nothing here will have read that one.
 */

import { useMemo } from "react";
import { ItemIcon } from "./minecraft-item-icon";
import { loadModItems, loadVanillaItems } from "./minecraft-mod-items";
import { GameItemPicker, type ItemPickerSource } from "./game-item-picker";
import { itemLabel, searchItems, typedItemId, type CatalogItem } from "../../lib/minecraft/items";

export function ItemPicker({
    installedAppId,
    ...props
}: {
    /** Which server, because what a mod adds is that server's own answer. */
    installedAppId: string;
    value: string | null;
    query: string;
    onQueryChange: (query: string) => void;
    onSelect: (id: string) => void;
    onDragItem?: (id: string | null) => void;
    recent?: readonly string[];
}) {
    // Per server, and stable across renders: the grid reloads whenever this
    // changes identity, and the modded half of it is a request.
    const source = useMemo<ItemPickerSource<CatalogItem>>(
        () => ({
            load: loadVanillaItems,
            more: () => loadModItems(installedAppId),
            search: searchItems,
            Icon: ItemIcon,
            labelOf: itemLabel,
            typedId: typedItemId,
            placeholder: "Search items, or write minecraft:diamond",
            whenMissing:
                "The item pictures did not load, so type the id - it looks like minecraft:diamond."
        }),
        [installedAppId]
    );

    return <GameItemPicker<CatalogItem> source={source} {...props} />;
}
