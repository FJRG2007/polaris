/**
 * What a player is carrying, out of what the server answers.
 *
 * `data get entity <player> Inventory` replies with SNBT, which is walked rather
 * than matched - see ./snbt for why, and for the walking.
 *
 * Pure, and no further than it needs to go: an operator wants to see what is in
 * the bag and in which slot, so slots, ids and counts are read and everything
 * else in an entry is stepped over rather than modelled.
 */

import { readBalanced, readInt, splitTopLevel, topLevelColon, unquote } from "./snbt";

/** One stack, as the server reported it. */
export interface InventoryItem {
    /** Where it sits. 0-8 is the hotbar, 100-103 the armour, -106 the offhand. */
    readonly slot: number;
    /** The namespaced id, e.g. "minecraft:diamond_pickaxe". */
    readonly id: string;
    readonly count: number;
}

/** The offhand, which the game numbers well outside the rest. */
export const OFFHAND_SLOT = -106;

/** Armour from the head down, which is the order it is worn and shown in. */
export const ARMOUR_SLOTS: readonly number[] = [103, 102, 101, 100];

/** The row that is on screen while playing. */
export const HOTBAR_SLOTS: readonly number[] = range(0, 9);

/** The bag above it, as the three rows of nine the game draws. */
export const MAIN_SLOT_ROWS: readonly (readonly number[])[] = [range(9, 9), range(18, 9), range(27, 9)];

/** Where a slot number puts the item, in the words the game uses for it. */
export function slotLabel(slot: number): string {
    if (slot === OFFHAND_SLOT) return "Offhand";
    if (slot >= 100 && slot <= 103) return ["Boots", "Leggings", "Chestplate", "Helmet"][slot - 100] ?? "Armour";
    if (slot >= 0 && slot <= 8) return `Hotbar ${slot + 1}`;
    return `Slot ${slot}`;
}

/**
 * The stacks the drawn slots do not account for.
 *
 * A modded server keeps items in slots vanilla never had - a backpack, a curios
 * ring - and a grid that only draws the vanilla ones would report a full bag as
 * empty. These get a row of their own rather than being dropped.
 */
export function extraSlots(items: readonly InventoryItem[]): InventoryItem[] {
    const drawn = new Set([...ARMOUR_SLOTS, OFFHAND_SLOT, ...HOTBAR_SLOTS, ...MAIN_SLOT_ROWS.flat()]);
    return items.filter((item) => !drawn.has(item.slot));
}

/** The stacks by slot, which is how a grid asks for them. */
export function bySlot(items: readonly InventoryItem[]): Map<number, InventoryItem> {
    return new Map(items.map((item) => [item.slot, item]));
}

function range(start: number, length: number): number[] {
    return Array.from({ length }, (_unused, index) => start + index);
}

/**
 * The stacks in a `data get entity ... Inventory` reply.
 *
 * Anything that is not that reply - a server that refused, a player who is not
 * on, an empty inventory - is an empty list rather than a throw: this is read to
 * fill a panel, and there is nothing an operator does differently about "no items"
 * and "could not be read" that the panel does not already say.
 */
export function parseInventory(output: string): InventoryItem[] {
    const start = output.indexOf("[");
    if (start === -1) return [];
    const list = readBalanced(output, start);
    if (list === null) return [];
    const items: InventoryItem[] = [];
    for (const entry of splitTopLevel(list.slice(1, -1))) {
        const item = readItem(entry);
        if (item) items.push(item);
    }
    return items.sort((left, right) => left.slot - right.slot);
}

/** One `{Slot: 0b, id: "minecraft:stone", count: 64}` entry, if it is one. */
function readItem(entry: string): InventoryItem | null {
    if (!entry.startsWith("{")) return null;
    const fields = new Map<string, string>();
    for (const field of splitTopLevel(entry.slice(1, -1))) {
        const colon = topLevelColon(field);
        if (colon === -1) continue;
        fields.set(field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim());
    }
    const id = unquote(fields.get("id") ?? "");
    if (!id) return null;
    // "Count" in the old shape, "count" in the componentised one; a stack that
    // names neither is a single item, which is how the game writes one.
    return { slot: readInt(fields.get("slot")) ?? 0, id, count: readInt(fields.get("count")) ?? 1 };
}
