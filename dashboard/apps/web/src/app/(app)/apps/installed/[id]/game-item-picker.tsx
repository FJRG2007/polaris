"use client";

/**
 * Pick an item the way a game's own inventory does: search, then a grid of
 * pictures.
 *
 * Handing somebody an item used to mean typing its id, which asks the operator to
 * know that a bookshelf is `bookshelf`, that an enchanting table is
 * `enchanting_table`, and - on the other game - that a Tranquilizer Arrow is
 * `PrimalItemAmmo_ArrowTranq`. The names are already on disk next to the pictures,
 * so the panel searches them instead.
 *
 * One component for both games because the difference between them is three
 * values, not a layout: where the catalogue is fetched from, what draws one
 * picture, and whether a written-out id is worth offering. Each game passes those
 * and keeps its own thin wrapper.
 */

import { Input, cn } from "@polaris/ui";
import { Loader2, Search } from "lucide-react";
import { DRAG_EFFECT_ALLOWED } from "./minecraft-inventory";
import type { SearchableItem } from "@/lib/apps/catalog-search";
import { useEffect, useMemo, useState, type ComponentType } from "react";

/** How many tiles are drawn before the operator is asked to type more. A whole
 *  catalogue is a thousand pictures or two; a grid of all of them is a scroll
 *  nobody finds anything in, and a search of two more letters is faster. */
const SHOWN = 120;

export interface ItemPickerSource<T extends SearchableItem> {
    /** The catalogue, fetched once and shared by every picker in the tab. The
     *  caller owns the caching, because it also owns the failure. */
    readonly load: () => Promise<T[]>;
    readonly search: (items: readonly T[], query: string, limit: number) => T[];
    /** One item's picture at whatever size the slot draws it. */
    readonly Icon: ComponentType<{ id: string; className?: string }>;
    /** What an item is called, for the ids that came from somewhere other than the
     *  catalogue - a recent give of something since renamed, or a typed id. */
    readonly labelOf: (id: string) => string;
    /** An id somebody typed, when the game has ids worth typing - a modded item
     *  that no catalogue covers. Absent means the field only searches. */
    readonly typedId?: (query: string) => string | null;
    readonly placeholder: string;
    /** What to say when the catalogue did not load. */
    readonly whenMissing: string;
}

export function GameItemPicker<T extends SearchableItem>({
    source,
    value,
    query,
    onQueryChange,
    onSelect,
    onDragItem,
    recent
}: {
    source: ItemPickerSource<T>;
    /** The id that will be given, or null while nothing is chosen. */
    value: string | null;
    query: string;
    onQueryChange: (query: string) => void;
    onSelect: (id: string) => void;
    /** Makes the results draggable, for a screen that drops one onto a slot.
     *  Called with the id when a drag starts and null when it ends. */
    onDragItem?: (id: string | null) => void;
    /** What was handed out on this server lately, shown before anybody types.
     *  The catalogue's own order answers nobody's question - what somebody
     *  reaches for is nearly always what was reached for last. */
    recent?: readonly string[];
}) {
    const [items, setItems] = useState<T[] | null>(null);
    const [failed, setFailed] = useState(false);
    const { load, search, Icon, labelOf, typedId, placeholder, whenMissing } = source;

    useEffect(() => {
        let live = true;
        load().then(
            (loaded) => live && setItems(loaded),
            () => live && setFailed(true)
        );
        return () => {
            live = false;
        };
    }, [load]);

    const searching = query.trim().length > 0;
    const matches = useMemo(() => {
        if (!items) return [];
        const found = search(items, query, SHOWN + 1);
        // Recent goes in front of the list, not in place of it. What was given
        // here lately is the better first row, but the rest of the catalogue is
        // still what somebody browses when the thing they want was not given
        // recently - dropping it made the picker useless for anything new.
        if (searching || !recent || recent.length === 0) return found;
        const lately = recent.map(
            (id) =>
                items.find((item) => item.id === id) ??
                ({ id, label: labelOf(id), search: id } as unknown as T)
        );
        return [...lately, ...found.filter((item) => !recent.includes(item.id))];
    }, [items, query, searching, recent, search, labelOf]);
    const shown = matches.slice(0, SHOWN);
    const more = matches.length > SHOWN;
    // A written-out id nobody has a picture for is still a real item on a modded
    // server, so it is offered rather than refused.
    const typed = typedId?.(query) ?? null;
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
                    placeholder={placeholder}
                    onChange={(event) => onQueryChange(event.target.value)}
                />
            </div>

            {failed ? (
                <p className="text-xs text-muted-foreground">{whenMissing}</p>
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
                            <Tile
                                id={typed}
                                label={labelOf(typed)}
                                Icon={Icon}
                                selected={value === typed}
                                onSelect={onSelect}
                            />
                        )}
                        {shown.map((item) => (
                            <Tile
                                key={item.id}
                                id={item.id}
                                label={item.label}
                                Icon={Icon}
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
                        <Icon id={value} className="size-4" />
                        <span className="font-medium">{labelOf(value)}</span>
                        <span className="truncate font-mono text-muted-foreground" title={value}>
                            {value}
                        </span>
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
    Icon,
    selected,
    onSelect,
    onDragItem
}: {
    id: string;
    label: string;
    Icon: ComponentType<{ id: string; className?: string }>;
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
                    // The grid's own constant, not a value chosen here: a source
                    // that allows an effect the slot does not ask for is a drop the
                    // browser cancels outright, with no event and no error - which
                    // is exactly how an item dragged from this palette used to
                    // vanish on release.
                    event.dataTransfer.effectAllowed =
                        DRAG_EFFECT_ALLOWED as typeof event.dataTransfer.effectAllowed;
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
                <Icon id={id} className="size-full" />
            </button>
        </li>
    );
}
