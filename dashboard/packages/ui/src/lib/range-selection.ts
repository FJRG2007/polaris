"use client";

/**
 * Choosing several items of a list the way a file explorer does: a press
 * toggles one, Shift with a press takes everything from the last one pressed to
 * this one, and Ctrl+A (Cmd+A) takes the whole list.
 *
 * Shift gives the whole stretch the state the pressed item is turning to, so a
 * stretch can be taken off as easily as it was put on. What is chosen keeps the
 * order it was chosen in, because some lists mean something by it (the order a
 * panel takes turns in); a stretch or the whole list is added in the list's own
 * order.
 */

import { useCallback, useRef, type KeyboardEvent } from "react";

/** The keys that change what a press does. */
export interface PressKeys {
    readonly shiftKey?: boolean;
}

/** What is chosen after pressing `id`, from `anchor` (the last one pressed). */
export function pressedSelection<T>(
    order: readonly T[],
    chosen: readonly T[],
    id: T,
    anchor: T | null,
    keys: PressKeys = {}
): T[] {
    const taking = !chosen.includes(id);
    const from = anchor === null ? -1 : order.indexOf(anchor);
    const to = order.indexOf(id);
    const stretch =
        keys.shiftKey && from >= 0 && to >= 0
            ? order.slice(Math.min(from, to), Math.max(from, to) + 1)
            : [id];
    if (taking) return [...chosen, ...stretch.filter((one) => !chosen.includes(one))];
    return chosen.filter((one) => !stretch.includes(one));
}

/** Everything, what was already chosen first and in its order. */
export function allChosen<T>(order: readonly T[], chosen: readonly T[]): T[] {
    return [...chosen, ...order.filter((one) => !chosen.includes(one))];
}

/**
 * `press` for each item's click (it reads Shift from the event), and `onKeyDown`
 * for the element around the list, which is where Ctrl+A is heard.
 */
export function useRangeSelection<T>(
    order: readonly T[],
    chosen: readonly T[],
    onChange: (next: T[]) => void
) {
    const anchor = useRef<T | null>(null);

    const press = useCallback(
        (id: T, keys: PressKeys = {}) => {
            onChange(pressedSelection(order, chosen, id, anchor.current, keys));
            anchor.current = id;
        },
        [order, chosen, onChange]
    );

    const onKeyDown = useCallback(
        (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
                event.preventDefault();
                onChange(allChosen(order, chosen));
            }
        },
        [order, chosen, onChange]
    );

    return { press, onKeyDown };
}
