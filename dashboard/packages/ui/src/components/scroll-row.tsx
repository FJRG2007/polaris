"use client";

/**
 * A row of things wider than the space it has.
 *
 * Section rails, tab strips, filter chips: a line of links that fits on a wide
 * screen and does not on a narrow one. `overflow-x-auto` is what every one of
 * them reached for, and on a desktop with a wheel mouse that is not a scroll
 * region at all - the wheel scrolls the page, there is no sideways gesture, and
 * the thin scrollbar under a strip that is two rems tall is easy to miss
 * entirely. What people actually did was drag a selection across the row to make
 * it move, which is somebody working around the interface rather than using it,
 * and it is how the last section of a project - Analytics, on a ten-entry rail -
 * became unreachable.
 *
 * So this does the three things a horizontal strip owes its reader:
 *
 * - **the wheel scrolls it sideways**, and only while there is somewhere to go
 *   in that direction, so a strip that has reached its end hands the gesture
 *   back to the page rather than swallowing it;
 * - **the ends fade** when there is more past them, which is the only signal on
 *   screen that anything is out there;
 * - **it stops being any of this** when everything fits, which is the usual case
 *   on a wide screen and the case where a mask or a captured wheel would both be
 *   wrong.
 *
 * Deliberately one element rather than a wrapper with the fades drawn over it:
 * this replaces the `div` or `ul` that was already there, in a dozen layouts
 * that had a border, a flex rule or a negative margin on it, and a wrapper would
 * have quietly changed all of them. The fade is a mask, applied by the
 * stylesheet off the two data attributes set here.
 */

import { cn } from "../lib/cn";
import { useCallback, useEffect, useRef, type ElementType, type ReactNode } from "react";

/** How far a wheel notch moves the row. A notch is about a line of text, which
 *  sideways is nothing at all - this is roughly one item per notch. */
const STEP = 3;

export function ScrollRow({
    as: Tag = "div",
    className,
    children,
    ...rest
}: {
    /** The element this is. A rail is a `ul`, a tab strip is often a `nav`. */
    as?: ElementType;
    className?: string;
    children?: ReactNode;
} & Record<string, unknown>) {
    const held = useRef<HTMLElement | null>(null);

    /** Say whether there is anything past each end, for the fade. */
    const measure = useCallback(() => {
        const node = held.current;
        if (!node) return;
        const room = node.scrollWidth - node.clientWidth;
        // A rounding error is not an end somebody can scroll to.
        const start = node.scrollLeft > 1;
        const end = room > 1 && node.scrollLeft < room - 1;
        node.dataset.moreStart = String(start);
        node.dataset.moreEnd = String(end);
    }, []);

    useEffect(() => {
        const node = held.current;
        if (!node) return;

        /**
         * The wheel, turned sideways.
         *
         * Only a vertical gesture is taken: a trackpad that is already scrolling
         * horizontally does it natively and better. And it is only taken while
         * the row can actually move that way, so the page keeps scrolling once
         * the strip has reached its end - a region that eats the wheel at its
         * own boundary is the thing that makes a page feel stuck.
         */
        function onWheel(event: WheelEvent): void {
            const row = held.current;
            if (!row || event.ctrlKey) return;
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
            const room = row.scrollWidth - row.clientWidth;
            if (room <= 1) return;
            const forward = event.deltaY > 0;
            if (forward ? row.scrollLeft >= room - 1 : row.scrollLeft <= 1) return;
            event.preventDefault();
            row.scrollLeft += event.deltaY * STEP;
        }

        // Not React's own handler: it attaches wheel passively, and a passive
        // listener cannot call preventDefault - the page would scroll as well.
        node.addEventListener("wheel", onWheel, { passive: false });
        node.addEventListener("scroll", measure, { passive: true });

        // The row changes width when the window does, and its contents change
        // when a rail gains an entry or a label is renamed - so both are watched.
        // Watched rather than taken as a dependency on the children: this sits
        // inside screens that re-render on every keystroke, and re-attaching a
        // listener and an observer each time would be the strip's cost paid over
        // and over for nothing.
        const resize = new ResizeObserver(measure);
        resize.observe(node);
        const changes = new MutationObserver(measure);
        changes.observe(node, { childList: true, subtree: true, characterData: true });
        measure();

        return () => {
            node.removeEventListener("wheel", onWheel);
            node.removeEventListener("scroll", measure);
            resize.disconnect();
            changes.disconnect();
        };
    }, [measure]);

    return (
        <Tag ref={held} data-scroll-row="" className={cn("overflow-x-auto", className)} {...rest}>
            {children}
        </Tag>
    );
}
