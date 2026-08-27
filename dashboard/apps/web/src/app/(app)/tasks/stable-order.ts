"use client";

/**
 * Why a row does not move when somebody changes it.
 *
 * A screen sorted by priority puts urgent work at the top, which is what it is
 * for. But it also means that raising a task's priority tears the row out from
 * under the pointer and drops it twenty rows up - and the person doing it is
 * usually triaging, so the next thing they wanted to change was the row below
 * the one that just left. Every property the sort reads has this problem: a
 * status, a date, an estimate.
 *
 * So the arrangement is decided once and then held. The engine still sorts;
 * what it decides is taken as the order on screen the first time, and after that
 * a task already up there keeps the place it is in. New work is slotted in where
 * the sort would have put it, work that left is dropped, and asking for a
 * different arrangement - another sort, another direction, a search - throws the
 * held order away and takes the engine's afresh.
 *
 * Reloading the page does the same, which is the escape hatch: a board that has
 * drifted out of order because somebody spent an afternoon re-prioritising is
 * one refresh away from being sorted again.
 */

import { useCallback, useMemo, useRef } from "react";

/**
 * The freshly sorted order, with everything that was already on screen left
 * where it was.
 *
 * `next` is walked in the order the engine chose. An id nobody has seen before
 * is emitted at the point it was found, so a new task lands among the neighbours
 * it sorts next to; a familiar one hands over to the held sequence instead,
 * which drains up to and including it - everything the screen was holding ahead
 * of that row comes out with it, still in the order it was in.
 */
export function mergeOrder(held: readonly string[], next: readonly string[]): string[] {
    const incoming = new Set(next);
    const kept = held.filter((id) => incoming.has(id));
    // Nothing arrived and nothing left, so the held order already is the answer.
    if (kept.length === next.length) return kept;

    const known = new Set(kept);
    const emitted = new Set<string>();
    const order: string[] = [];
    let cursor = 0;

    for (const id of next) {
        if (!known.has(id)) {
            order.push(id);
            continue;
        }
        // Already flushed by a neighbour that came before it.
        if (emitted.has(id)) continue;
        while (cursor < kept.length) {
            const taken = kept[cursor] as string;
            cursor += 1;
            emitted.add(taken);
            order.push(taken);
            if (taken === id) break;
        }
    }
    // Nothing is left over to flush: everything held is by definition still on
    // the screen, so walking the screen reaches all of it.
    return order;
}

export interface StableOrder<T> {
    /** The same items, in the order the screen is holding. */
    readonly items: readonly T[];
    /**
     * Put a wider set of ids into that same order - the whole list behind a
     * filter, say. A drag writes down the arrangement it was dropped into, and
     * that has to be the arrangement on screen rather than the one the engine
     * would have chosen, or the drop lands somewhere nobody was looking.
     */
    readonly arrange: (ids: readonly string[]) => string[];
    /**
     * Take this order as the one being held, from now on.
     *
     * The one thing the held order must NOT absorb is somebody dragging a row.
     * Everything else this hook exists for - a priority raised, a status ticked,
     * a date moved - is a change the reader did not ask the row to move for, and
     * holding the arrangement through it is the whole point. A drag is the
     * opposite: it is the reader saying, in as many words, that this row goes
     * there. Held through unchanged, the screen would show the row exactly where
     * it was until a full reload rebuilt the hook - which is what it did.
     */
    readonly settle: (ids: readonly string[]) => void;
}

/**
 * Hold the order these items are in until `arrangement` says to take a new one.
 *
 * `arrangement` is what the reader asked for - the sort, its direction, the
 * search, the screen - and not what the data happens to be. That is the whole
 * point: the data changing is exactly the case the held order exists to absorb.
 */
export function useStableOrder<T extends { readonly id: string }>(
    items: readonly T[],
    arrangement: string
): StableOrder<T> {
    // A ref rather than state: this is derived from what is being rendered, and
    // setting state for it would render the screen twice for every edit.
    const held = useRef<{ arrangement: string; order: readonly string[] }>({
        arrangement,
        order: []
    });

    const ordered = useMemo(() => {
        const ids = items.map((item) => item.id);
        const order = held.current.arrangement === arrangement ? mergeOrder(held.current.order, ids) : ids;
        held.current = { arrangement, order };

        const byId = new Map(items.map((item) => [item.id, item]));
        return order.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
    }, [items, arrangement]);

    const arrange = useCallback(
        (ids: readonly string[]) => mergeOrder(held.current.order, ids),
        []
    );

    // No state and no render of its own: whatever asks for this is changing
    // something else in the same breath - the overlay a drag paints - and that
    // is the render this has to be in place for.
    const settle = useCallback((ids: readonly string[]) => {
        held.current = { arrangement: held.current.arrangement, order: [...ids] };
    }, []);

    return { items: ordered, arrange, settle };
}
