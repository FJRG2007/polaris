"use client";

/**
 * How wide a side panel may actually be drawn, as opposed to how wide it is
 * allowed to be.
 *
 * A panel's own limits answer "is this panel usable at this size", which is a
 * question about the panel. They cannot answer "is anything else still usable",
 * because a limit written next to a panel knows nothing about what is beside it
 * or how wide the window is - and the two are not the same question. Every panel
 * in this row sits at its stated size and the conversation takes what is left,
 * so a ceiling reached by two panels at once comes out of the conversation
 * first, and then off the edge of the screen: the panel somebody widened is the
 * one that ends up half drawn beyond it, with the button that closes it cut off.
 *
 * So the ceiling is measured rather than stated. What a panel may grow to is
 * whatever it is now plus whatever the conversation beside it has to spare above
 * the floor - the same thing `callBandLimit` does for the call, where a share of
 * a column has to reach a divider working in pixels.
 *
 * Applied to what is drawn and not only to the drag, because a width is
 * remembered: a panel sized on a wide monitor is opened again in a narrow window
 * and would otherwise arrive at a size nothing on this screen could have chosen.
 * The remembered number is left alone - it is what that screen said, and it is
 * right again the moment there is room for it.
 */

import { useCallback, useEffect, useState } from "react";

/**
 * The narrowest the conversation is left, in pixels.
 *
 * Roughly a phone's width: the column is a message, its author and a composer,
 * and below about this it stops being a conversation and becomes a list of
 * single words. It is a floor rather than a share, because what makes it
 * readable does not change with the size of the window.
 */
export const CONVERSATION_FLOOR = 360;

/**
 * The ceiling that leaves the conversation its floor.
 *
 * `panel` and `beside` are measured widths - the panel itself, and whatever
 * absorbs the rest of the row. Never below `bounds.min`: a row too narrow to
 * hold both is a reason to stop the panel growing, not to fold it away, and a
 * ceiling under the floor would invert the divider it is handed to.
 *
 * Nothing measured yet leaves the stated limit, which is all there is to go on
 * until the panel has been drawn once.
 */
export function paneCeiling(
    bounds: { readonly min: number; readonly max: number },
    panel: number,
    beside: number,
    floor: number = CONVERSATION_FLOOR
): number {
    if (!Number.isFinite(panel) || panel <= 0 || !Number.isFinite(beside)) return bounds.max;
    return Math.max(bounds.min, Math.min(bounds.max, Math.round(panel + beside - floor)));
}

/**
 * The same, kept up to date with the row it is in.
 *
 * `measure` goes on the panel element. What it is beside is found rather than
 * named, because the panels are drawn by three different components and none of
 * them can see the others: in a row where everything else holds its width, the
 * one child that grows is the one every extra pixel comes out of.
 */
export function usePaneCeiling(
    bounds: { readonly min: number; readonly max: number },
    floor: number = CONVERSATION_FLOOR
): { readonly ceiling: number; readonly measure: (node: HTMLElement | null) => void } {
    const [node, setNode] = useState<HTMLElement | null>(null);
    const [ceiling, setCeiling] = useState(bounds.max);
    const measure = useCallback((next: HTMLElement | null) => setNode(next), []);
    const { min, max } = bounds;

    useEffect(() => {
        const row = node?.parentElement ?? null;
        const beside = row && typeof ResizeObserver !== "undefined" ? growing(row, node) : null;
        // Nothing to measure against - no observer, no row, or a row where every
        // child holds its own width. The stated ceiling is then the only one.
        if (!node || !beside) {
            setCeiling(max);
            return;
        }
        const read = () => {
            // A column that is not being drawn measures zero, which would read as
            // a row with nothing to spare and pin the panel at its floor - which
            // is what the narrow layouts are, where one column is the whole
            // screen and the other is not there. What is not on screen is not a
            // constraint.
            if (!drawn(beside)) return setCeiling(max);
            const next = paneCeiling({ min, max }, node.offsetWidth, beside.offsetWidth, floor);
            // Only when it moved: this observes elements whose size this number
            // decides, so a state write per measurement is a loop with a render
            // in it rather than a settling one.
            setCeiling((was) => (was === next ? was : next));
        };
        read();
        const watcher = new ResizeObserver(read);
        watcher.observe(node);
        watcher.observe(beside);
        return () => watcher.disconnect();
    }, [node, min, max, floor]);

    return { ceiling, measure };
}

/** Whether it is on the page and being drawn, which is what makes its width
 *  worth reading. */
function drawn(element: HTMLElement): boolean {
    return element.isConnected && window.getComputedStyle(element).display !== "none";
}

/** The one child that takes whatever is left, ignoring the panel itself. */
function growingChild(parent: HTMLElement, skip: HTMLElement | null): HTMLElement | null {
    for (const child of Array.from(parent.children)) {
        if (child === skip || !(child instanceof HTMLElement)) continue;
        if (window.getComputedStyle(child).flexGrow !== "0") return child;
    }
    return null;
}

/**
 * The element that actually absorbs whatever this panel does not take.
 *
 * Not the row's own growing child, which is only the same thing when that child
 * is the conversation. For the conversation list it is the whole content column,
 * and the thread and members panels live inside that column with handles of
 * their own - so measuring it counts room another panel has already claimed as
 * slack this one may grow into. At 1024 with the members column open at its
 * default and a width remembered from a wider monitor, that arithmetic left the
 * conversation below its floor with nobody having dragged anything.
 *
 * So the search keeps going down. Descending through a column is safe because
 * every child of one spans its full width; width is only ever divided at a row,
 * and there the growing child is by definition the one the slack comes out of.
 * It stops at the first element with nothing growing inside it, which is the
 * conversation from either row.
 */
function growing(row: HTMLElement, panel: HTMLElement | null): HTMLElement | null {
    let found = growingChild(row, panel);
    if (!found) return null;
    for (let deeper = growingChild(found, null); deeper; deeper = growingChild(found, null)) {
        found = deeper;
    }
    return found;
}
