"use client";

/**
 * A player's bag, drawn the way the game draws it.
 *
 * A list of ids and slot numbers is a faithful report and a useless picture: an
 * operator asked to check whether somebody is carrying a beacon reads thirty
 * rows, and "Slot 27" tells them nothing about where it is. The game already
 * solved this - armour down the side, three rows of nine, the hotbar under them -
 * and an operator who plays the game reads that layout without being taught it,
 * so the panel borrows it rather than inventing a table.
 *
 * Empty slots are drawn too. A bag with four things in it looks different from a
 * bag with four things and no room, and only the wells show the difference.
 */

import { ItemIcon } from "./minecraft-item-icon";
import { itemLabel } from "@/lib/apps/minecraft/items";
import {
    ARMOUR_SLOTS,
    HOTBAR_SLOTS,
    MAIN_SLOT_ROWS,
    OFFHAND_SLOT,
    bySlot,
    extraSlots,
    slotLabel,
    type InventoryItem
} from "@/lib/apps/minecraft/inventory";

/** A stack count sits on the item, so it is outlined in the slot's own colour to
 *  stay readable over whatever texture is under it - the game's own trick. */
const COUNT_OUTLINE = {
    textShadow: [
        "0 1px 0 hsl(var(--surface))",
        "0 -1px 0 hsl(var(--surface))",
        "1px 0 0 hsl(var(--surface))",
        "-1px 0 0 hsl(var(--surface))"
    ].join(", ")
} as const;

export function InventoryGrid({ items }: { items: readonly InventoryItem[] }) {
    const slots = bySlot(items);
    const extra = extraSlots(items);
    const total = items.reduce((sum, item) => sum + item.count, 0);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-6">
                <Section label="Worn" slots={ARMOUR_SLOTS} at={slots} columns={4} />
                <Section label="Offhand" slots={[OFFHAND_SLOT]} at={slots} columns={1} />
            </div>

            <Section label="Bag" slots={MAIN_SLOT_ROWS.flat()} at={slots} columns={9} grow />
            <Section label="Hotbar" slots={HOTBAR_SLOTS} at={slots} columns={9} grow />

            {/* Vanilla has nowhere else to put an item, so anything here came from
                a mod - worth showing rather than quietly dropping. */}
            {extra.length > 0 && (
                <Section label="Elsewhere" slots={extra.map((item) => item.slot)} at={slots} columns={9} grow />
            )}

            <p className="text-xs text-muted-foreground">
                {items.length === 0
                    ? "Nothing in it."
                    : `${total} ${total === 1 ? "item" : "items"} in ${items.length} ${
                          items.length === 1 ? "stack" : "stacks"
                      }.`}
            </p>
        </div>
    );
}

/** A labelled block of slots. Nine to a row even on a phone: a bag that reflows
 *  to four columns is not the bag the operator is looking at in game. */
function Section({
    label,
    slots,
    at,
    columns,
    grow
}: {
    label: string;
    slots: readonly number[];
    at: Map<number, InventoryItem>;
    columns: 1 | 4 | 9;
    /** Whether the block fills the width, which only the nine-wide ones do. */
    grow?: boolean;
}) {
    const template = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };

    return (
        <div className={grow ? "flex flex-col gap-1" : "flex shrink-0 flex-col gap-1"}>
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{label}</span>
            <ul
                aria-label={label}
                style={grow ? template : { ...template, width: `${columns * 2.5}rem` }}
                className="grid gap-1"
            >
                {slots.map((slot) => (
                    <Slot key={slot} slot={slot} item={at.get(slot) ?? null} />
                ))}
            </ul>
        </div>
    );
}

function Slot({ slot, item }: { slot: number; item: InventoryItem | null }) {
    const where = slotLabel(slot);
    if (!item) {
        return (
            <li
                aria-hidden
                title={where}
                className="aspect-square rounded border border-border/60 bg-surface/40"
            />
        );
    }

    const name = itemLabel(item.id);
    return (
        <li
            title={`${name}${item.count > 1 ? ` x${item.count}` : ""} - ${where}`}
            aria-label={`${where}: ${name}, ${item.count}`}
            className="relative aspect-square rounded border border-border bg-surface p-0.5"
        >
            <ItemIcon id={item.id} className="size-full" />
            {item.count > 1 && (
                <span
                    style={COUNT_OUTLINE}
                    className="pointer-events-none absolute bottom-0 right-0.5 text-[0.625rem] font-bold leading-none tabular-nums"
                >
                    {item.count}
                </span>
            )}
        </li>
    );
}
