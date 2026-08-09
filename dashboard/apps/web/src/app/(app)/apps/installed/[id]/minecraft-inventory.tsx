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
 *
 * Read-only unless it is handed the handlers that make it otherwise. Without them
 * it renders exactly what it always did - inert cells with a title - so the places
 * that only report a bag are not paying for an editor they do not offer.
 */

import { cn } from "@polaris/ui";
import { ItemIcon } from "./minecraft-item-icon";
import { itemLabel } from "@/lib/apps/minecraft/items";
import { isMovable } from "@/lib/apps/minecraft/item-argument";
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

/** What a grid needs to be draggable. Absent on every screen that only reports. */
export interface SlotHandlers {
    /** A stack was picked up. Null when the drag ended without a drop. */
    readonly onPick: (slot: number | null) => void;
    /** A stack was dropped onto this slot, with the modifiers held at the time. */
    readonly onDropAt: (slot: number, modifiers: { whole: boolean; single: boolean }) => void;
    /** Right-click, which the game splits a stack with. */
    readonly onSplit?: (slot: number) => void;
    /** The slot currently being dragged, so it can be shown as lifted. */
    readonly dragging: number | null;
}

export function InventoryGrid({
    items,
    handlers
}: {
    items: readonly InventoryItem[];
    handlers?: SlotHandlers;
}) {
    const slots = bySlot(items);
    const extra = extraSlots(items);
    const total = items.reduce((sum, item) => sum + item.count, 0);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-6">
                <Section label="Worn" slots={ARMOUR_SLOTS} at={slots} columns={4} handlers={handlers} />
                <Section label="Offhand" slots={[OFFHAND_SLOT]} at={slots} columns={1} handlers={handlers} />
            </div>

            <Section label="Bag" slots={MAIN_SLOT_ROWS.flat()} at={slots} columns={9} grow handlers={handlers} />
            <Section label="Hotbar" slots={HOTBAR_SLOTS} at={slots} columns={9} grow handlers={handlers} />

            {/* Vanilla has nowhere else to put an item, so anything here came from
                a mod - worth showing rather than quietly dropping. Never editable:
                `/item replace` has no name for a slot only a mod knows about. */}
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
    grow,
    handlers
}: {
    label: string;
    slots: readonly number[];
    at: Map<number, InventoryItem>;
    columns: 1 | 4 | 9;
    /** Whether the block fills the width, which only the nine-wide ones do. */
    grow?: boolean;
    handlers?: SlotHandlers;
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
                    <Slot key={slot} slot={slot} item={at.get(slot) ?? null} handlers={handlers} />
                ))}
            </ul>
        </div>
    );
}

function Slot({
    slot,
    item,
    handlers
}: {
    slot: number;
    item: InventoryItem | null;
    handlers?: SlotHandlers;
}) {
    const where = slotLabel(slot);
    // A stack whose data cannot be written back exactly is not draggable at all,
    // rather than draggable and refused on drop. The check is the same one the
    // action runs, so the two can never disagree about which stacks those are.
    const canDrag = handlers !== undefined && item !== null && isMovable(item);
    const droppable = handlers !== undefined;

    const dropProps = droppable
        ? {
              onDragOver: (event: React.DragEvent) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move" as const;
              },
              onDrop: (event: React.DragEvent) => {
                  event.preventDefault();
                  handlers.onDropAt(slot, { whole: event.shiftKey, single: event.ctrlKey || event.metaKey });
              }
          }
        : {};

    if (!item) {
        return (
            <li
                aria-hidden={!droppable}
                title={where}
                {...dropProps}
                className={cn(
                    "aspect-square rounded border border-border/60 bg-surface/40",
                    droppable && "transition-colors hover:border-primary/60"
                )}
            />
        );
    }

    const name = itemLabel(item.id);
    const lifted = handlers?.dragging === slot;
    return (
        <li
            title={`${name}${item.count > 1 ? ` x${item.count}` : ""} - ${where}`}
            aria-label={`${where}: ${name}, ${item.count}`}
            draggable={canDrag}
            onDragStart={(event) => {
                if (!canDrag) return;
                event.dataTransfer.effectAllowed = "move";
                // Something has to be set or Firefox refuses to start the drag.
                event.dataTransfer.setData("text/plain", String(slot));
                handlers.onPick(slot);
            }}
            onDragEnd={() => handlers?.onPick(null)}
            onContextMenu={(event) => {
                if (!handlers?.onSplit) return;
                event.preventDefault();
                handlers.onSplit(slot);
            }}
            {...dropProps}
            className={cn(
                "relative aspect-square rounded border border-border bg-surface p-0.5",
                canDrag && "cursor-grab active:cursor-grabbing",
                lifted && "opacity-40",
                // A stack that cannot be moved says so by not offering to be. The
                // editor explains why beside the grid rather than in 40 tooltips.
                handlers && !canDrag && "cursor-not-allowed"
            )}
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
