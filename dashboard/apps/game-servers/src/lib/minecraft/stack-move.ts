/**
 * What dropping one stack on a slot does, decided before anything is written.
 *
 * The game's own rules, as a drag in the inventory screen follows them: onto an
 * empty slot it moves; onto the same item it tops that stack up to what one can
 * hold and leaves the rest where it was; onto anything else the two trade
 * places. Part of a stack - Ctrl, or a split - goes onto an empty slot or tops
 * up the same item, never onto something different.
 *
 * Pure, so the rules are pinned by a test rather than by whatever a server
 * happened to do the day somebody tried it.
 */

import type { InventoryItem } from "./inventory";

export type StackMove =
    /** The whole stack goes, and whatever was there comes back in its place. */
    | { readonly kind: "swap" }
    /** Onto the same item: `target` is its new size, `source` what stays behind. */
    | { readonly kind: "merge"; readonly target: number; readonly source: number }
    /** Part of it onto an empty slot. */
    | { readonly kind: "split"; readonly moved: number; readonly source: number }
    /** The same item, already a full stack: nothing to do, as in the game. */
    | { readonly kind: "full" }
    | { readonly kind: "refuse"; readonly why: "occupied" | "indivisible" };

/** Whether two stacks are the same item, down to their data - which is what lets
 *  the game put them in one stack. */
export function stacksTogether(left: InventoryItem, right: InventoryItem): boolean {
    return left.id === right.id && (left.data?.snbt ?? null) === (right.data?.snbt ?? null);
}

export function planStackMove(
    source: InventoryItem,
    target: InventoryItem | null,
    /** How many of the source to move; the whole stack when absent. */
    count: number | undefined,
    /** The most one stack of this item holds. */
    maxStack: number
): StackMove {
    const part = count === undefined ? source.count : Math.max(1, Math.min(count, source.count));

    if (target !== null && stacksTogether(source, target)) {
        const room = maxStack - target.count;
        if (room <= 0) return { kind: "full" };
        const moving = Math.min(part, room);
        return { kind: "merge", target: target.count + moving, source: source.count - moving };
    }

    if (part < source.count) {
        // A stack carrying its own data is one item wearing that data, and there
        // is no half of it.
        if (source.data !== null) return { kind: "refuse", why: "indivisible" };
        if (target !== null) return { kind: "refuse", why: "occupied" };
        return { kind: "split", moved: part, source: source.count - part };
    }
    return { kind: "swap" };
}
