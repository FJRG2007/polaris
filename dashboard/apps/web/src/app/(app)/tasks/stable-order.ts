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
 * And then it lets go. Holding for ever is the other half of the problem: a
 * board sorted by urgency that never reorders is a board that is not sorted, and
 * the reader had to reload the page to see the arrangement they asked for. So
 * the hold is a beat rather than a decision - long enough that the row does not
 * leave under the pointer that changed it, short enough that the screen is in
 * order again before anybody goes looking for the reload button. A burst of
 * edits settles once, when the burst stops.
 *
 * The one thing that is held for good is an order somebody dragged into place.
 * That is the reader saying where a row goes, not the data moving underneath
 * them, and a screen that undid it a second and a half later would be a screen
 * that undid it. It is held until they sort differently, search, or reload.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

/**
 * How long the screen keeps an arrangement the data has moved on from.
 *
 * Long enough to cover the click that caused it and the one after it, short
 * enough that nobody reads it as the list being broken. Every change pushes it
 * back, so re-prioritising ten tasks reorders once at the end rather than ten
 * times under the pointer.
 */
export const SETTLE_AFTER_MS = 1500;

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

    /** Set by `settle`, which is only ever a drag. See the file comment: an order
     *  somebody put a row into by hand is not one to let go of. */
    const dragged = useRef(false);

    /**
     * Bumped when the hold has been let go of. The one thing here that causes a
     * render of its own - everything else is derived from what is already being
     * drawn, and this is the screen catching up with an order it decided not to
     * show a moment ago.
     */
    const [released, setReleased] = useState(0);

    const ordered = useMemo(() => {
        const ids = items.map((item) => item.id);
        const fresh = held.current.arrangement !== arrangement;
        if (fresh) dragged.current = false;
        const order = fresh ? ids : mergeOrder(held.current.order, ids);
        held.current = { arrangement, order };

        const byId = new Map(items.map((item) => [item.id, item]));
        return order.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
        // `released` is what re-runs this once the hold is dropped. It is not read
        // in here, and that is exactly what it is for.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, arrangement, released]);

    /**
     * Let go, once the changes stop.
     *
     * Restarted on every change, so a burst of them reorders once at the end.
     * Nothing is scheduled while the screen already agrees with the engine, which
     * is the common case by far and must not render again.
     */
    const drifted = ordered.some((item, at) => item.id !== items[at]?.id);
    useEffect(() => {
        if (!drifted || dragged.current) return;
        const timer = window.setTimeout(() => {
            held.current = { arrangement: held.current.arrangement, order: [] };
            setReleased((count) => count + 1);
        }, SETTLE_AFTER_MS);
        return () => window.clearTimeout(timer);
    }, [drifted, items]);

    const arrange = useCallback(
        (ids: readonly string[]) => mergeOrder(held.current.order, ids),
        []
    );

    // No state and no render of its own: whatever asks for this is changing
    // something else in the same breath - the overlay a drag paints - and that
    // is the render this has to be in place for.
    const settle = useCallback((ids: readonly string[]) => {
        held.current = { arrangement: held.current.arrangement, order: [...ids] };
        dragged.current = true;
    }, []);

    return { items: ordered, arrange, settle };
}
