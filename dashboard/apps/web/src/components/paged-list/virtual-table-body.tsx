"use client";

/**
 * The body of a table that may hold thousands of rows, drawing only the ones on
 * screen.
 *
 * The page itself scrolls - the shell has no scrolling panel of its own - so the
 * rows are windowed against the window, offset by where the table starts. Above
 * and below the drawn rows sit two empty rows the height of everything not
 * drawn, which keeps the scrollbar honest and the columns lined up: a table
 * cannot be absolutely positioned row by row without losing the column widths
 * that are the reason it is a table.
 *
 * Rows are measured once drawn, so a row that wraps to two lines on a phone
 * takes the room it needs. Before anything is measured - on the server, and in
 * the first paint - a screenful is drawn from the estimate, so the list is there
 * before any script runs.
 *
 * `onNearEnd` fires when the last rows come into view, which is how the next
 * page is asked for: well before the end, so scrolling does not stop at it.
 */

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";

/** How close to the last row, in rows, the next page is asked for. */
const NEAR_END = 15;

/** What a drawn row needs to be measured. Spread onto the row element. */
export interface VirtualRowProps {
    readonly ref: Ref<HTMLTableRowElement>;
    readonly "data-index": number;
}

/** useLayoutEffect, without the warning a server render gives for it. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function VirtualTableBody<T>({
    items,
    estimate,
    colSpan,
    getKey,
    renderRow,
    onNearEnd,
    footer
}: {
    items: readonly T[];
    /** A row's height before it is measured, in pixels. */
    estimate: number;
    colSpan: number;
    getKey: (item: T) => string;
    renderRow: (item: T, row: VirtualRowProps) => ReactNode;
    onNearEnd?: () => void;
    /** Drawn after the rows: the loading line, the end of the list. */
    footer?: ReactNode;
}) {
    const body = useRef<HTMLTableSectionElement>(null);
    const [margin, setMargin] = useState(0);

    // Where the table starts on the page. Read again when the window changes
    // size, because what sits above it reflows.
    useIsomorphicLayoutEffect(() => {
        const measure = () => {
            const element = body.current;
            if (element) setMargin(element.getBoundingClientRect().top + window.scrollY);
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, []);

    const virtualizer = useWindowVirtualizer({
        count: items.length,
        estimateSize: () => estimate,
        overscan: 8,
        scrollMargin: margin,
        getItemKey: (index) => getKey(items[index]!),
        // A screenful before anything is measured, so the server's render and the
        // first paint are a list rather than an empty table.
        initialRect: { width: 1280, height: 1000 }
    });
    const rows = virtualizer.getVirtualItems();
    const last = rows[rows.length - 1];

    useEffect(() => {
        if (onNearEnd && last && last.index >= items.length - NEAR_END) onNearEnd();
    }, [last, items.length, onNearEnd]);

    const above = rows[0] ? rows[0].start - margin : 0;
    const below = last ? virtualizer.getTotalSize() - (last.end - margin) : 0;

    return (
        <tbody ref={body}>
            {above > 0 ? (
                <tr aria-hidden="true">
                    <td colSpan={colSpan} style={{ height: above, padding: 0 }} />
                </tr>
            ) : null}
            {rows.map((row) =>
                renderRow(items[row.index]!, {
                    ref: virtualizer.measureElement,
                    "data-index": row.index
                })
            )}
            {below > 0 ? (
                <tr aria-hidden="true">
                    <td colSpan={colSpan} style={{ height: below, padding: 0 }} />
                </tr>
            ) : null}
            {footer}
        </tbody>
    );
}
