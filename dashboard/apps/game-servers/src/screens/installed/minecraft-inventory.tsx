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
 *
 * It also draws what is not in the bag yet. An item given to somebody who is not
 * on the server is written down rather than handed over, and a drop that left
 * nothing on the screen read as a drop that had failed - so the waiting stack is
 * drawn in the slot it is waiting for, faded, and can be called back off it.
 */

import { X } from "lucide-react";
import { useState } from "react";
import { type GameText, useGameText } from "../game-text";
import { cn } from "@polaris/ui";
import { ItemIcon } from "./minecraft-item-icon";
import { itemLabel } from "../../lib/minecraft/items";
import { isMovable } from "../../lib/minecraft/item-argument";
import { enchantmentText, itemDetails, type ItemDetails } from "../../lib/minecraft/item-details";
import {
    ARMOUR_SLOTS,
    HOTBAR_SLOTS,
    MAIN_SLOT_ROWS,
    OFFHAND_SLOT,
    bySlot,
    extraSlots,
    slotLabelIn,
    type InventoryItem
} from "../../lib/minecraft/inventory";

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

/**
 * The two halves of the drag contract, kept together because they only work as a
 * pair.
 *
 * A browser cancels a drop outright when the drop effect the target asks for is
 * not among the effects the source allows - no drop event, no error, the item
 * simply never arrives. The palette used to allow only "copy" while the slots
 * asked for "move", which is why an item dragged out of it vanished on release.
 *
 * `DRAG_EFFECT_ALLOWED` is what anything draggable into this grid must set, and
 * `SLOT_DROP_EFFECT` is what the slots ask for. Both live here so the next thing
 * that can be dragged into a slot cannot pick a third answer.
 */
export const DRAG_EFFECT_ALLOWED = "copyMove";
export const SLOT_DROP_EFFECT = "move";

/** How small a slot is allowed to get, and how large it is allowed to grow. A bag
 *  is nine columns whatever it is drawn inside, so without a floor a narrow column
 *  turns the game's own layout into forty stamps nobody can read. */
const SLOT_MIN = "2.25rem";
const SLOT_MAX = 3.25;

/** A stack somebody asked for that the server could not be told about yet: the
 *  player was not on, so it is waiting for them to join. */
export interface PendingStack {
    /** The queued action it came from, so it can be called back off the slot. */
    readonly id: string;
    readonly slot: number;
    readonly item: string;
    readonly count: number;
}

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
    pending,
    handlers,
    onCancelPending
}: {
    items: readonly InventoryItem[];
    /** Stacks waiting for the player to join, drawn in the slot they will land in. */
    pending?: readonly PendingStack[];
    handlers?: SlotHandlers;
    /** Called with a waiting stack's queued id to call it back off the slot. */
    onCancelPending?: (id: string) => void;
}) {
    const t = useGameText("minecraft");
    const slots = bySlot(items);
    const extra = extraSlots(items);
    // The stack last pointed at, tapped or focused. Its details are drawn under
    // the grid: a title only shows to a mouse, and an enchanted book is opened
    // for exactly what a title cannot hold.
    const [inspected, setInspected] = useState<number | null>(null);
    const shown = inspected === null ? null : (slots.get(inspected) ?? null);
    const total = items.reduce((sum, item) => sum + item.count, 0);
    // A slot the player is already carrying something in wins: the queued write
    // will replace it when they join, and drawing both in one square would be
    // drawing a bag that does not exist in either version.
    const waiting = new Map(
        (pending ?? [])
            .filter((stack) => !slots.has(stack.slot))
            .map((stack) => [stack.slot, stack])
    );
    const shared = {
        at: slots,
        waiting,
        handlers,
        onInspect: setInspected,
        ...(onCancelPending ? { onCancelPending } : {})
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-6">
                <Section label={t("inventory.worn")} slots={ARMOUR_SLOTS} columns={4} {...shared} />
                <Section
                    label={t("inventory.offhand")}
                    slots={[OFFHAND_SLOT]}
                    columns={1}
                    {...shared}
                />
            </div>

            <Section
                label={t("inventory.bag")}
                slots={MAIN_SLOT_ROWS.flat()}
                columns={9}
                grow
                {...shared}
            />
            <Section
                label={t("inventory.hotbar")}
                slots={HOTBAR_SLOTS}
                columns={9}
                grow
                {...shared}
            />

            {/* Vanilla has nowhere else to put an item, so anything here came from
                a mod - worth showing rather than quietly dropping. Never editable:
                `/item replace` has no name for a slot only a mod knows about. */}
            {extra.length > 0 && (
                <Section
                    label={t("inventory.elsewhere")}
                    slots={extra.map((item) => item.slot)}
                    at={slots}
                    onInspect={setInspected}
                    columns={9}
                    grow
                />
            )}

            <p className="text-xs text-muted-foreground">
                {items.length === 0
                    ? t("inventory.nothingInIt")
                    : t("inventory.summary", { total, stacks: items.length })}
                {waiting.size > 0 && ` ${t("inventory.waiting", { count: waiting.size })}`}
            </p>
            {items.length > 0 && (
                <StackDetails item={shown} where={shown ? slotLabelIn(t, shown.slot) : ""} />
            )}
        </div>
    );
}

/** A labelled block of slots. Nine to a row even on a phone: a bag that reflows
 *  to four columns is not the bag the operator is looking at in game. */
function Section({
    label,
    slots,
    at,
    waiting,
    columns,
    grow,
    handlers,
    onInspect,
    onCancelPending
}: {
    label: string;
    slots: readonly number[];
    at: Map<number, InventoryItem>;
    /** What is queued for each slot, where nothing is in it yet. */
    waiting?: Map<number, PendingStack>;
    columns: 1 | 4 | 9;
    /** Whether the block fills the width, which only the nine-wide ones do. */
    grow?: boolean;
    handlers?: SlotHandlers;
    onInspect: (slot: number) => void;
    onCancelPending?: (id: string) => void;
}) {
    const template = { gridTemplateColumns: `repeat(${columns}, minmax(${SLOT_MIN}, 1fr))` };

    return (
        <div className={grow ? "flex min-w-0 flex-col gap-1" : "flex shrink-0 flex-col gap-1"}>
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                {label}
            </span>
            <ul
                aria-label={label}
                // Capped as well as floored: nine slots stretched across a wide
                // dialog stop looking like the bag they are a picture of.
                style={
                    grow
                        ? { ...template, maxWidth: `${columns * SLOT_MAX}rem` }
                        : { ...template, width: `${columns * SLOT_MAX}rem` }
                }
                className="grid gap-1"
            >
                {slots.map((slot) => (
                    <Slot
                        key={slot}
                        slot={slot}
                        item={at.get(slot) ?? null}
                        pending={waiting?.get(slot) ?? null}
                        handlers={handlers}
                        onInspect={onInspect}
                        {...(onCancelPending ? { onCancelPending } : {})}
                    />
                ))}
            </ul>
        </div>
    );
}

function Slot({
    slot,
    item,
    pending,
    handlers,
    onInspect,
    onCancelPending
}: {
    slot: number;
    item: InventoryItem | null;
    /** A stack written down for this slot, where the slot is otherwise empty. */
    pending?: PendingStack | null;
    handlers?: SlotHandlers;
    onInspect: (slot: number) => void;
    onCancelPending?: (id: string) => void;
}) {
    const t = useGameText("minecraft");
    const where = slotLabelIn(t, slot);
    // A stack whose data cannot be written back exactly is not draggable at all,
    // rather than draggable and refused on drop. The check is the same one the
    // action runs, so the two can never disagree about which stacks those are.
    const canDrag = handlers !== undefined && item !== null && isMovable(item);
    const droppable = handlers !== undefined;

    const dropProps = droppable
        ? {
              onDragOver: (event: React.DragEvent) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect =
                      SLOT_DROP_EFFECT as typeof event.dataTransfer.dropEffect;
              },
              onDrop: (event: React.DragEvent) => {
                  event.preventDefault();
                  handlers.onDropAt(slot, {
                      whole: event.shiftKey,
                      single: event.ctrlKey || event.metaKey
                  });
              }
          }
        : {};

    if (!item && pending) {
        const name = itemLabel(pending.item);
        const what = `${pending.count} x ${name}`;
        return (
            <li
                title={t("inventory.pendingTitle", { what, where })}
                aria-label={t("inventory.pendingLabel", { what, where })}
                {...dropProps}
                className="relative aspect-square rounded border border-dashed border-primary/60 bg-primary/5 p-0.5"
            >
                <ItemIcon id={pending.item} className="size-full opacity-60" />
                {pending.count > 1 && (
                    <span
                        style={COUNT_OUTLINE}
                        className="pointer-events-none absolute bottom-0 right-0.5 text-[0.625rem] font-bold leading-none tabular-nums"
                    >
                        {pending.count}
                    </span>
                )}
                {/* Called back from the slot it is waiting in rather than only from
                    a list somewhere else: the square is where somebody looks when
                    they change their mind about what they just dropped. */}
                {onCancelPending && (
                    <button
                        type="button"
                        title={t("inventory.callBack", { what })}
                        aria-label={t("inventory.callBackFrom", { what, where })}
                        onClick={() => onCancelPending(pending.id)}
                        className="absolute -right-1 -top-1 rounded-full border border-border bg-surface p-0.5 text-muted-foreground transition-colors hover:text-danger"
                    >
                        <X className="size-2.5" />
                    </button>
                )}
            </li>
        );
    }

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
    const details = itemDetails(item.data);
    const enchanted = details.enchantments.length > 0 || details.stored.length > 0;
    const described = describe(t, details);
    const heading = `${details.name ?? name}${item.count > 1 ? ` x${item.count}` : ""}`;
    return (
        <li
            title={[`${heading} - ${where}`, ...described].join("\n")}
            aria-label={[`${where}: ${details.name ?? name}, ${item.count}`, ...described].join(
                ". "
            )}
            tabIndex={0}
            onPointerEnter={() => onInspect(slot)}
            onFocus={() => onInspect(slot)}
            onClick={() => onInspect(slot)}
            draggable={canDrag}
            onDragStart={(event) => {
                if (!canDrag) return;
                event.dataTransfer.effectAllowed =
                    DRAG_EFFECT_ALLOWED as typeof event.dataTransfer.effectAllowed;
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
                "relative aspect-square rounded border border-border bg-surface p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary",
                // An enchanted stack carries the game's glint, so it is told
                // apart from a plain one at a glance, as it is in game.
                enchanted && "border-violet-400/70",
                canDrag && "cursor-grab active:cursor-grabbing",
                lifted && "opacity-40",
                // A stack that cannot be moved says so by not offering to be. The
                // editor explains why beside the grid rather than in 40 tooltips.
                handlers && !canDrag && "cursor-not-allowed"
            )}
        >
            <ItemIcon id={item.id} className="size-full" />
            {enchanted && <span aria-hidden className="item-glint pointer-events-none absolute inset-0 rounded" />}
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

/** A stack's details as the lines its tooltip would have in game. */
function describe(t: GameText<"minecraft">, details: ItemDetails): string[] {
    const lines: string[] = [];
    if (details.enchantments.length > 0)
        lines.push(details.enchantments.map(enchantmentText).join(", "));
    if (details.stored.length > 0)
        lines.push(
            t("inventory.details.stored", { list: details.stored.map(enchantmentText).join(", ") })
        );
    if (details.unbreakable) lines.push(t("inventory.details.unbreakable"));
    else if (details.damage !== null)
        lines.push(
            details.maxDamage
                ? t("inventory.details.durability", {
                      left: Math.max(details.maxDamage - details.damage, 0),
                      max: details.maxDamage
                  })
                : t("inventory.details.damage", { damage: details.damage })
        );
    return lines;
}

/**
 * The stack pointed at, spelled out under the grid.
 *
 * Always drawn at one height, empty or full, plain stone or a book of five
 * enchantments: a panel that grew with what it held moved the whole dialog
 * every time the pointer crossed a slot. What does not fit scrolls inside it.
 */
function StackDetails({ item, where }: { item: InventoryItem | null; where: string }) {
    const t = useGameText("minecraft");
    const shell =
        "flex h-24 min-w-0 items-start gap-2 overflow-hidden rounded-md border border-border bg-surface/40 px-3 py-2";
    if (!item)
        return (
            <div className={cn(shell, "items-center")}>
                <p className="text-xs text-muted-foreground">{t("inventory.pointAtAStack")}</p>
            </div>
        );
    const details = itemDetails(item.data);
    const name = itemLabel(item.id);
    const enchanted = details.enchantments.length > 0 || details.stored.length > 0;
    const heading = `${details.name ?? name}${item.count > 1 ? ` x${item.count}` : ""}`;
    const lines = describe(t, details);
    return (
        <div className={shell}>
            <span className="relative size-8 shrink-0">
                <ItemIcon id={item.id} className="size-full" />
                {enchanted && <span aria-hidden className="item-glint pointer-events-none absolute inset-0 rounded" />}
            </span>
            <div className="flex h-full min-w-0 flex-1 flex-col gap-0.5 text-xs">
                <span
                    className={cn(
                        "truncate font-medium",
                        // A named or enchanted item's name is coloured in game.
                        enchanted ? "text-violet-500 dark:text-violet-300" : details.name && "italic"
                    )}
                    title={heading}
                >
                    {heading}
                </span>
                <span className="truncate text-muted-foreground">
                    {details.name ? `${name} - ${where}` : where}
                </span>
                {lines.length > 0 && (
                    <ul className="min-h-0 flex-1 overflow-y-auto">
                        {lines.map((line) => (
                            <li key={line} className="break-words text-muted-foreground">
                                {line}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
