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

import { useCallback, useEffect, useRef, useState } from "react";

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
 * absorbs the rest of the row. `share` is how many panels are measuring against
 * that same thing and still asking it for room: what a conversation has to spare
 * is one pool, and a pool offered whole to each of them is one they all spend at
 * once. Never below `bounds.min`: a row too narrow to hold both is a reason to
 * stop the panel growing, not to fold it away, and a ceiling under the floor
 * would invert the divider it is handed to.
 *
 * Nothing measured yet leaves the stated limit, which is all there is to go on
 * until the panel has been drawn once.
 */
export function paneCeiling(
    bounds: { readonly min: number; readonly max: number },
    panel: number,
    beside: number,
    floor: number = CONVERSATION_FLOOR,
    share: number = 1
): number {
    if (!Number.isFinite(panel) || panel <= 0 || !Number.isFinite(beside)) return bounds.max;
    const parts = Number.isFinite(share) && share > 1 ? Math.floor(share) : 1;
    const spare = beside - floor;
    // Rounded down, so shares of a pool that does not divide evenly come to less
    // than the pool rather than more - a pixel too many is this mechanism in
    // reverse, given back on the next measurement and taken again on the one
    // after. A shortfall is owed by each of them in full: every panel has to
    // stand out of the way for the conversation to be whole again, and whatever
    // that gives back too much of comes round as spare.
    const room = spare > 0 ? Math.floor(spare / parts) : spare;
    return Math.max(bounds.min, Math.min(bounds.max, Math.round(panel + room)));
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
    /** The number as it stands, readable from inside a measurement: what it is
     *  now is what says whether this panel is still asking for room. */
    const held = useRef(bounds.max);
    const measure = useCallback((next: HTMLElement | null) => setNode(next), []);
    const { min, max } = bounds;

    useEffect(() => {
        const row = node?.parentElement ?? null;
        // Nothing to measure with - no panel drawn yet, no row around it, or no
        // observer to keep a measurement true once it has been taken. The stated
        // ceiling is then the only one.
        if (!node || !row || typeof ResizeObserver === "undefined") {
            held.current = max;
            setCeiling(max);
            return;
        }

        /** What is being watched for a change of size, and what is being counted
         *  against. Told apart so a column that is not on screen is still watched
         *  for coming back, without claiming a share of a pool it is not in. */
        let watched: HTMLElement | null = null;
        let counted: HTMLElement | null = null;

        const read = () => {
            // Found again on every reading rather than once at mount. What this
            // panel is beside lives in the page under /chat, which is replaced on
            // every navigation and again the moment the skeleton gives way to the
            // conversation - so an element resolved once is one that is gone by
            // the first message, and the ceiling taken from it would be the
            // stated one for the rest of the session.
            const beside = growing(row, node);
            if (beside !== watched) {
                if (watched) watcher.unobserve(watched);
                watched = beside;
                if (beside) watcher.observe(beside);
            }
            // A column that is not being drawn measures zero, which would read as
            // a row with nothing to spare and pin the panel at its floor - which
            // is what the narrow layouts are, where one column is the whole
            // screen and the other is not there. What is not on screen is not a
            // constraint.
            const against = beside && drawn(beside) ? beside : null;
            if (against !== counted) {
                const was = counted;
                // Set before either call, so a panel asked to read again from
                // inside one of them finds this one already where it belongs.
                counted = against;
                if (was) release(was, entry);
                if (against) claim(against, entry);
            }
            if (!against) {
                held.current = max;
                return setCeiling(max);
            }
            const panel = node.offsetWidth;
            const next = paneCeiling(
                { min, max },
                panel,
                against.offsetWidth,
                floor,
                asking(against)
            );
            // Held at a ceiling rather than settled inside one is what makes a
            // panel a claimant on the room going spare: it is as wide as it is
            // allowed to be and would be wider. Against the tighter of the two
            // ceilings, the one it had and the one it is getting, because either
            // of them pins it - and a panel taken for settled is one whose share
            // somebody else spends, which is the overshoot this counting is here
            // to avoid. Room a panel is not asking for belongs to whoever is.
            entry.asking = panel >= Math.min(held.current, next);
            held.current = next;
            // Only when it moved: this observes elements whose size this number
            // decides, so a state write per measurement is a loop with a render
            // in it rather than a settling one.
            setCeiling((was) => (was === next ? was : next));
        };

        const entry: Claimant = { read, asking: true };
        const watcher = new ResizeObserver(read);
        watcher.observe(node);
        // A page swapped underneath need not change the size of anything being
        // watched, so a resize alone would never ask for the reading that finds
        // what replaced it. Cheap on purpose: what this watches is a
        // conversation, where something changes on every message, and all it does
        // per change is ask whether what it had is still on the page.
        const shuffle = new MutationObserver(() => {
            if (!watched?.isConnected) read();
        });
        shuffle.observe(row, { childList: true, subtree: true });
        read();

        return () => {
            watcher.disconnect();
            shuffle.disconnect();
            if (counted) release(counted, entry);
        };
    }, [node, min, max, floor]);

    return { ceiling, measure };
}

/** One panel's standing in a pool: how to make it read again, and whether it is
 *  still asking that pool for room. */
interface Claimant {
    readonly read: () => void;
    asking: boolean;
}

/**
 * Every panel measuring against the same thing.
 *
 * What a conversation has to spare is one pool, and each panel works its own
 * ceiling out from the same measurement of it. Offered whole to each of them, it
 * is a pool they all take at once: two panels a hundred short each give a
 * hundred back, each then sees two hundred going spare and takes it, and the two
 * of them are a hundred over again - a cycle a resize observer runs every frame,
 * with the conversation under its floor on half of them.
 *
 * So they are counted, by the element they are counting against, and each of
 * them is told when another arrives or leaves: the size of the pool is part of
 * every ceiling drawn from it. Held weakly, because the key is a node in a page
 * that gets replaced - a strong one here would keep every conversation ever
 * opened.
 */
const pools = new WeakMap<HTMLElement, Set<Claimant>>();

/** Join the pool measuring against this element, and say so - an arrival changes
 *  what everybody already in it may grow to. */
function claim(beside: HTMLElement, entry: Claimant): void {
    const pool = pools.get(beside) ?? new Set<Claimant>();
    pools.set(beside, pool);
    pool.add(entry);
    for (const other of [...pool]) if (other !== entry) other.read();
}

/** Leave it, and say so - what this one was holding is theirs now. */
function release(beside: HTMLElement, entry: Claimant): void {
    const pool = pools.get(beside);
    if (!pool?.delete(entry)) return;
    for (const other of [...pool]) other.read();
}

/** How many panels are still asking this one for room, never fewer than one: a
 *  pool nobody is asking from divides into itself. */
function asking(beside: HTMLElement): number {
    let count = 0;
    for (const entry of pools.get(beside) ?? []) if (entry.asking) count += 1;
    return Math.max(1, count);
}

/** Whether it is on the page and being drawn, which is what makes its width
 *  worth reading. */
function drawn(element: HTMLElement): boolean {
    return element.isConnected && window.getComputedStyle(element).display !== "none";
}

/**
 * Whether room is handed out inside it at all.
 *
 * `flex-grow` on the child of anything else is a declaration nothing acts on, so
 * a number read off one says nothing about the box that was actually laid out.
 * The message list is exactly that - an ordinary scrolling block, whose children
 * are free to carry the class for a reason of their own - and walking into one
 * would hand back something narrower than the conversation and hold every panel
 * near its minimum.
 */
function divides(element: HTMLElement): boolean {
    const display = window.getComputedStyle(element).display;
    return display === "flex" || display === "inline-flex";
}

/** The one child that takes whatever is left, ignoring the panel itself. */
function growingChild(parent: HTMLElement, skip: HTMLElement | null): HTMLElement | null {
    if (!divides(parent)) return null;
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
 * It stops at the first element that divides nothing, or has nothing growing
 * inside it, which is the conversation from either row.
 */
function growing(row: HTMLElement, panel: HTMLElement | null): HTMLElement | null {
    let found = growingChild(row, panel);
    if (!found) return null;
    for (let deeper = growingChild(found, null); deeper; deeper = growingChild(found, null)) {
        found = deeper;
    }
    return found;
}
