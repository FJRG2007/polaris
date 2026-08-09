"use client";

/**
 * Pick an item the way the creative inventory does: search, then a grid of
 * pictures.
 *
 * Handing somebody an item used to mean typing its id, which asks the operator to
 * know that a bookshelf is `bookshelf` and an enchanting table is
 * `enchanting_table` and a mob head is not `head`. The names are already on disk
 * next to the pictures, so the panel searches them instead.
 *
 * Typing still works, and has to: the set is one Minecraft version's, and a
 * modded or newer id belongs to no picture here. So a query that is itself a
 * valid id is offered as one, and the field stays the source of truth.
 */

import { Input, cn } from "@polaris/ui";
import { Loader2, Search } from "lucide-react";
import { ItemIcon } from "./minecraft-item-icon";
import { useEffect, useMemo, useState } from "react";
import {
    ITEM_CATALOG_URL,
    itemLabel,
    readItemCatalog,
    searchItems,
    typedItemId,
    type CatalogItem
} from "@/lib/apps/minecraft/items";

/** How many tiles are drawn before the operator is asked to type more. The whole
 *  set is 1400 pictures; a grid of all of them is a scroll nobody finds anything
 *  in, and a search of two more letters is faster than the scroll. */
const SHOWN = 120;

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

export function ItemPicker({
    value,
    query,
    onQueryChange,
    onSelect,
    onDragItem
}: {
    /** The id that will be given, or null while nothing is chosen. */
    value: string | null;
    query: string;
    onQueryChange: (query: string) => void;
    onSelect: (id: string) => void;
    /** Makes the results draggable, for a screen that drops one onto a slot.
     *  Called with the id when a drag starts and null when it ends. */
    onDragItem?: (id: string | null) => void;
}) {
    const [items, setItems] = useState<CatalogItem[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        loadCatalog().then(
            (loaded) => live && setItems(loaded),
            () => live && setFailed(true)
        );
        return () => {
            live = false;
        };
    }, []);

    const matches = useMemo(() => (items ? searchItems(items, query, SHOWN + 1) : []), [items, query]);
    const shown = matches.slice(0, SHOWN);
    const more = matches.length > SHOWN;
    // A written-out id nobody has a picture for is still a real item on a modded
    // server, so it is offered rather than refused.
    const typed = typedItemId(query);
    const offerTyped = typed !== null && shown.every((item) => item.id !== typed);

    return (
        <div className="flex flex-col gap-2">
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    autoFocus
                    className="pl-9"
                    spellCheck={false}
                    value={query}
                    aria-label="Search items"
                    placeholder={failed ? "minecraft:diamond" : "Search items, or write minecraft:diamond"}
                    onChange={(event) => onQueryChange(event.target.value)}
                />
            </div>

            {failed ? (
                <p className="text-xs text-muted-foreground">
                    The item pictures did not load, so type the id - it looks like minecraft:diamond.
                </p>
            ) : items === null ? (
                <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading the items...
                </p>
            ) : (
                <>
                    <ul
                        aria-label="Items"
                        className="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto rounded-md border border-border bg-surface/40 p-1"
                    >
                        {offerTyped && typed && (
                            <Tile id={typed} label={itemLabel(typed)} selected={value === typed} onSelect={onSelect} />
                        )}
                        {shown.map((item) => (
                            <Tile
                                key={item.id}
                                id={item.id}
                                label={item.label}
                                selected={value === item.id}
                                onSelect={onSelect}
                                {...(onDragItem ? { onDragItem } : {})}
                            />
                        ))}
                        {shown.length === 0 && !offerTyped && (
                            <li className="col-span-full py-6 text-center text-sm text-muted-foreground">
                                Nothing matches that.
                            </li>
                        )}
                    </ul>
                    {more && (
                        <p className="text-xs text-muted-foreground">
                            More than {SHOWN} match. Type more to narrow it.
                        </p>
                    )}
                </>
            )}

            <p className="min-h-5 text-xs">
                {value ? (
                    <span className="flex items-center gap-1.5">
                        <ItemIcon id={value} className="size-4" />
                        <span className="font-medium">{itemLabel(value)}</span>
                        <span className="truncate font-mono text-muted-foreground" title={value}>{value}</span>
                    </span>
                ) : (
                    <span className="text-muted-foreground">Choose an item.</span>
                )}
            </p>
        </div>
    );
}

function Tile({
    id,
    label,
    selected,
    onSelect,
    onDragItem
}: {
    id: string;
    label: string;
    selected: boolean;
    onSelect: (id: string) => void;
    onDragItem?: (id: string | null) => void;
}) {
    return (
        <li>
            <button
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={selected}
                onClick={() => onSelect(id)}
                draggable={onDragItem !== undefined}
                onDragStart={(event) => {
                    if (!onDragItem) return;
                    event.dataTransfer.effectAllowed = "copy";
                    // Something has to be set or Firefox refuses the drag.
                    event.dataTransfer.setData("text/plain", id);
                    // Picking it up selects it too, so the count field and the
                    // caption below agree with what is in the air.
                    onSelect(id);
                    onDragItem(id);
                }}
                onDragEnd={() => onDragItem?.(null)}
                className={cn(
                    "flex aspect-square w-full items-center justify-center rounded border p-1 transition-colors",
                    selected
                        ? "border-primary bg-primary/10"
                        : "border-transparent bg-surface hover:border-border hover:bg-card-hover"
                )}
            >
                <ItemIcon id={id} className="size-full" />
            </button>
        </li>
    );
}
