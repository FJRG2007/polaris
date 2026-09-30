"use client";

/**
 * A handful of items and how many of each, chosen the way the inventory view
 * chooses them: pictures in slots, a searchable palette, drag and drop.
 *
 * Every reward in the panel - an event's podium and its prize for taking part, a
 * challenge's payout, a milestone - used to be a row of text boxes asking for
 * `minecraft:diamond` and a number, which asks the operator to know the id of the
 * thing they can see in the game. This is the one editor all of them use instead.
 *
 * - The palette is the item picker the inventory already has: search by name, a
 *   grid of pictures, the server's modded items appended once they are read.
 * - An item goes into a slot by dragging it there or by clicking it (into the slot
 *   that was chosen, else the first free one). Slots are reordered by dragging one
 *   onto another, and emptied by dragging one out of the row or pressing its X.
 * - Every drag has a keyboard path: a slot is a button that opens its own row of
 *   controls - count, move earlier, move later, remove - and Delete removes it.
 * - The count is per slot and capped at the item's stack size (64, 16 or 1), which
 *   is what the player receives as one stack. A saved count above that is shown
 *   as it is and only capped once it is edited.
 *
 * Controlled: the caller owns the list, validates it against its own schema and
 * saves it with its own rollback. A problem the schema found for one slot is
 * handed back through `problemAt` and drawn under it.
 */

import { useGameText } from "../game-text";
import { cn, Button, Input } from "@polaris/ui";
import { ItemIcon } from "./minecraft-item-icon";
import { ItemPicker } from "./minecraft-item-picker";
import { ArrowLeft, ArrowRight, Plus, X } from "lucide-react";
import { DRAG_EFFECT_ALLOWED, SLOT_DROP_EFFECT } from "./minecraft-inventory";
import { createContext, useContext, useEffect, useId, useRef, useState, type DragEvent } from "react";
import {
    itemIconUrl,
    itemLabel,
    itemName,
    maxStackFor,
    normalizeItemId,
    typedItemId
} from "../../lib/minecraft/items";

/** One slot's contents, the shape every reward schema here stores. */
export interface SlotItem {
    readonly id: string;
    readonly count: number;
}

/** Which server the palette is for, so it can add what that server's mods carry.
 *  Provided once by the panel rather than threaded through every reward editor;
 *  without it the palette has the vanilla items only. */
const ItemServer = createContext<string | null>(null);
export const ItemServerProvider = ItemServer.Provider;

/** The drag payload's type, so a slot can tell one of its own from a palette item
 *  or from text dragged in from elsewhere on the page. */
const SLOT_TYPE = "application/x-polaris-item-slot";

/** Put `from` at `to`, shifting what is between. */
export function moveSlot<T>(items: readonly T[], from: number, to: number): T[] {
    if (from === to || from < 0 || from >= items.length) return [...items];
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, moved as T);
    return next;
}

/**
 * Place an item from the palette at `index`: into that slot when it holds
 * something (replacing it), else at the end of the filled ones. Null when every
 * slot is taken and there is nowhere to put it.
 */
export function placeItem(
    items: readonly SlotItem[],
    id: string,
    index: number | null,
    max: number
): SlotItem[] | null {
    const fresh = { id, count: 1 };
    if (index !== null && index < items.length) {
        const kept = items[index] as SlotItem;
        return items.map((one, at) => (at === index ? { id, count: Math.min(kept.count, maxStackFor(id)) } : one));
    }
    if (items.length >= max) return null;
    return [...items, fresh];
}

/** A typed count, held to what one stack of `id` can be. */
export function slotCount(id: string, raw: string): number {
    const value = Math.trunc(Number(raw));
    if (raw.trim() === "" || !Number.isFinite(value)) return Number.NaN;
    return Math.max(1, Math.min(maxStackFor(id), value));
}

export function ItemSlots({
    items,
    onChange,
    max = 6,
    disabled = false,
    problemAt,
    label
}: {
    items: readonly SlotItem[];
    onChange: (next: SlotItem[]) => void;
    /** How many slots there are; every reward schema here allows six. */
    max?: number;
    disabled?: boolean;
    /** What the caller's schema said about one slot, if anything. */
    problemAt?: (index: number) => string | null | undefined;
    /** What the row is, for a screen reader. */
    label: string;
}) {
    const t = useGameText("games");
    const server = useContext(ItemServer);
    const [open, setOpen] = useState(false);
    const [chosen, setChosen] = useState<number | null>(null);
    const [query, setQuery] = useState("");
    // What is being dragged out of the palette. A ref, not state: the palette
    // reports the pick-up and then the selection in one event, and the selection
    // has to see the pick-up to know it is not a click.
    const paletteDrag = useRef<string | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const row = useRef<HTMLUListElement | null>(null);
    // Where the last drag was over, so a slot let go of outside the row is
    // removed while one let go of inside it, or cancelled, is not.
    const outside = useRef(false);
    const panelId = useId();

    const current = chosen !== null && chosen < items.length ? (items[chosen] as SlotItem) : null;
    const full = items.length >= max;

    // A slot that no longer exists cannot stay chosen.
    useEffect(() => {
        if (chosen !== null && chosen >= Math.max(items.length, 1) && !open) setChosen(null);
    }, [chosen, items.length, open]);

    function put(id: string, index: number | null) {
        const normalized = normalizeItemId(id);
        if (normalized === null) return;
        const next = placeItem(items, normalized, index, max);
        if (next === null) return;
        onChange(next);
        setChosen(index !== null && index < items.length ? index : next.length - 1);
    }

    function remove(index: number) {
        onChange(items.filter((_, at) => at !== index));
        setChosen(null);
    }

    function move(from: number, to: number) {
        if (to < 0 || to >= items.length) return;
        onChange(moveSlot(items, from, to));
        setChosen(to);
    }

    function onDrop(event: DragEvent, index: number) {
        event.preventDefault();
        setOver(null);
        const from = event.dataTransfer.getData(SLOT_TYPE);
        if (from !== "") {
            const at = Number(from);
            if (Number.isInteger(at)) move(at, Math.min(index, items.length - 1));
            return;
        }
        // From the palette, or a namespaced id dragged in from elsewhere; any other
        // text dropped here is not an item.
        const id = paletteDrag.current ?? typedItemId(event.dataTransfer.getData("text/plain"));
        if (id) put(id, index);
        paletteDrag.current = null;
    }

    function onDragOver(event: DragEvent, index: number) {
        if (disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = SLOT_DROP_EFFECT;
        outside.current = false;
        if (over !== index) setOver(index);
    }

    return (
        <div className="flex flex-col gap-2">
            <ul
                ref={row}
                aria-label={label}
                className="grid grid-cols-6 gap-1.5"
                onDragLeave={(event) => {
                    if (!row.current?.contains(event.relatedTarget as Node | null)) {
                        outside.current = true;
                        setOver(null);
                    }
                }}
            >
                {Array.from({ length: max }, (_, index) => {
                    const item = index < items.length ? (items[index] as SlotItem) : null;
                    const problem = problemAt?.(index) ?? null;
                    return (
                        <li key={index} className="min-w-0">
                            {item ? (
                                <FilledSlot
                                    item={item}
                                    index={index}
                                    selected={chosen === index}
                                    highlighted={over === index}
                                    problem={problem}
                                    disabled={disabled}
                                    controls={panelId}
                                    onChoose={() => setChosen(chosen === index ? null : index)}
                                    onRemove={() => remove(index)}
                                    onDragStart={(event) => {
                                        event.dataTransfer.effectAllowed =
                                            DRAG_EFFECT_ALLOWED as typeof event.dataTransfer.effectAllowed;
                                        event.dataTransfer.setData(SLOT_TYPE, String(index));
                                        event.dataTransfer.setData("text/plain", item.id);
                                        outside.current = false;
                                    }}
                                    onDragEnd={(event) => {
                                        // Let go of outside the row: out of the reward.
                                        // Cancelled, or dropped back inside: left alone.
                                        if (outside.current && event.dataTransfer.dropEffect === "none") remove(index);
                                        outside.current = false;
                                    }}
                                    onDragOver={(event) => onDragOver(event, index)}
                                    onDrop={(event) => onDrop(event, index)}
                                />
                            ) : (
                                <button
                                    type="button"
                                    disabled={disabled || (index > items.length && full)}
                                    aria-label={t("itemSlots.empty")}
                                    title={t("itemSlots.empty")}
                                    onClick={() => {
                                        setChosen(index);
                                        setOpen(true);
                                    }}
                                    onDragOver={(event) => onDragOver(event, index)}
                                    onDrop={(event) => onDrop(event, index)}
                                    className={cn(
                                        "flex aspect-square w-full items-center justify-center rounded-md border border-dashed text-muted-foreground transition-colors",
                                        over === index || (open && chosen === index)
                                            ? "border-primary bg-primary/10"
                                            : "border-border hover:border-border-strong hover:bg-card-hover",
                                        "disabled:cursor-not-allowed disabled:opacity-50"
                                    )}
                                >
                                    <Plus className="size-4" aria-hidden />
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>

            {current && chosen !== null && (
                <div
                    id={panelId}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface/40 p-2"
                >
                    <ItemIcon id={current.id} className="size-6 shrink-0" />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium" title={itemLabel(current.id)}>
                            {itemLabel(current.id)}
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground" title={current.id}>
                            {current.id}
                        </span>
                    </span>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {t("itemSlots.count")}
                        <Input
                            type="number"
                            className="h-8 w-20"
                            min={1}
                            max={maxStackFor(current.id)}
                            disabled={disabled}
                            value={Number.isFinite(current.count) ? current.count : ""}
                            onChange={(event) =>
                                onChange(
                                    items.map((one, at) =>
                                        at === chosen ? { ...one, count: slotCount(one.id, event.target.value) } : one
                                    )
                                )
                            }
                        />
                    </label>
                    <span className="flex items-center gap-1">
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled || chosen === 0}
                            aria-label={t("itemSlots.earlier")}
                            title={t("itemSlots.earlier")}
                            onClick={() => move(chosen, chosen - 1)}
                        >
                            <ArrowLeft className="size-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled || chosen >= items.length - 1}
                            aria-label={t("itemSlots.later")}
                            title={t("itemSlots.later")}
                            onClick={() => move(chosen, chosen + 1)}
                        >
                            <ArrowRight className="size-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled}
                            aria-label={t("itemSlots.remove", { item: itemLabel(current.id) })}
                            title={t("itemSlots.remove", { item: itemLabel(current.id) })}
                            onClick={() => remove(chosen)}
                        >
                            <X className="size-4" />
                        </Button>
                    </span>
                    <p className="w-full text-xs text-muted-foreground">
                        {t("itemSlots.stack", { count: maxStackFor(current.id) })}
                    </p>
                </div>
            )}

            {!disabled && (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            aria-expanded={open}
                            disabled={!open && full}
                            onClick={() => setOpen((value) => !value)}
                        >
                            {open ? t("itemSlots.done") : (
                                <>
                                    <Plus className="size-4" />
                                    {t("itemSlots.add")}
                                </>
                            )}
                        </Button>
                        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                            {full ? t("itemSlots.full", { count: max }) : open ? t("itemSlots.hint") : null}
                        </span>
                    </div>
                    {open && (
                        <ItemPicker
                            installedAppId={server}
                            value={current?.id ?? null}
                            query={query}
                            onQueryChange={setQuery}
                            onSelect={(id) => {
                                // Picking one up to drag selects it as well; the drop
                                // is what places it then, not the pick.
                                if (paletteDrag.current !== null) return;
                                // A click fills the empty slot that was chosen, else the
                                // next free one. It never replaces a filled slot - that
                                // is what dropping onto one is for.
                                put(id, chosen !== null && chosen >= items.length ? chosen : null);
                            }}
                            onDragItem={(id) => {
                                paletteDrag.current = id;
                            }}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

function FilledSlot({
    item,
    index,
    selected,
    highlighted,
    problem,
    disabled,
    controls,
    onChoose,
    onRemove,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop
}: {
    item: SlotItem;
    index: number;
    selected: boolean;
    highlighted: boolean;
    problem: string | null;
    disabled: boolean;
    controls: string;
    onChoose: () => void;
    onRemove: () => void;
    onDragStart: (event: DragEvent) => void;
    onDragEnd: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
}) {
    const t = useGameText("games");
    const name = itemLabel(item.id);
    const count = Number.isFinite(item.count) ? item.count : 0;
    // No picture for a modded id: the tile says which item it is instead.
    const pictured = itemIconUrl(item.id) !== null;
    const described = t("itemSlots.slot", { item: name, count, position: index + 1 });
    return (
        <div className="group relative">
            <button
                type="button"
                draggable={!disabled}
                aria-pressed={selected}
                aria-controls={selected ? controls : undefined}
                aria-label={described}
                aria-invalid={problem !== null}
                title={`${name} (${item.id})`}
                disabled={disabled}
                onClick={onChoose}
                onKeyDown={(event) => {
                    if (disabled) return;
                    if (event.key === "Delete" || event.key === "Backspace") {
                        event.preventDefault();
                        onRemove();
                    }
                }}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOver={onDragOver}
                onDrop={onDrop}
                className={cn(
                    "relative flex aspect-square w-full flex-col items-center justify-center overflow-hidden rounded-md border p-1 transition-colors",
                    selected || highlighted
                        ? "border-primary bg-primary/10"
                        : problem
                          ? "border-danger-edge bg-danger-soft"
                          : "border-border bg-surface hover:border-border-strong hover:bg-card-hover"
                )}
            >
                <ItemIcon id={item.id} className={pictured ? "size-full" : "size-5"} />
                {!pictured && (
                    <span className="w-full truncate text-center font-mono text-[0.6rem] leading-tight text-muted-foreground">
                        {itemName(item.id)}
                    </span>
                )}
                <span className="absolute bottom-0.5 right-1 font-mono text-xs font-semibold tabular-nums text-foreground">
                    {count}
                </span>
            </button>
            {!disabled && (
                <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    title={t("itemSlots.remove", { item: name })}
                    onClick={onRemove}
                    className="absolute -right-1 -top-1 hidden size-4 items-center justify-center rounded-full border border-border bg-elevated text-muted-foreground hover:text-foreground group-hover:flex"
                >
                    <X className="size-3" />
                </button>
            )}
            {problem && (
                <p role="alert" className="mt-0.5 truncate text-[0.65rem] text-danger" title={problem}>
                    {problem}
                </p>
            )}
        </div>
    );
}
