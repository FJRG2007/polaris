/**
 * The Overview grid's arithmetic: every row spans the whole width, in the order
 * the cards are in.
 *
 * The two failures worth pinning are the ones a reader sees: a row that stops
 * short of the edge, and a card that moved because the layout was rearranged
 * around it.
 */

import { describe, expect, it } from "vitest";
import { packOverviewSpans, type PackItem } from "@/lib/overview/pack";

/** A card, at the width it is set to and the widths it is legible at. */
function card(preferred: number, min = 1, max = 4): PackItem {
    return { preferred, min, max };
}

/** The rows the grid would draw from a run of spans: it fills a row until the
 *  next card does not fit, exactly as the browser does. */
function rows(spans: readonly number[], width: number): number[][] {
    const out: number[][] = [];
    let row: number[] = [];
    let used = 0;
    for (const span of spans) {
        if (used + span > width) {
            out.push(row);
            row = [];
            used = 0;
        }
        row.push(span);
        used += span;
    }
    if (row.length > 0) out.push(row);
    return out;
}

describe("laying the cards out", () => {
    it("fills every row to the full width, at every width", () => {
        const items = [card(1), card(2), card(3), card(1), card(4), card(2), card(1)];

        for (const width of [1, 2, 3, 4, 5, 6, 7, 8]) {
            for (const row of rows(packOverviewSpans(items, width), width)) {
                expect(row.reduce((total, span) => total + span, 0)).toBe(width);
            }
        }
    });

    it("gives every card the width it was set to when the row already adds up", () => {
        expect(packOverviewSpans([card(2), card(2), card(1), card(3)], 4)).toEqual([2, 2, 1, 3]);
    });

    it("narrows the card that would spill over rather than ending the row early", () => {
        // Three columns taken, the next card set to three, and one column left.
        expect(packOverviewSpans([card(3), card(3)], 4)).toEqual([3, 1]);
    });

    it("widens the last cards when there is nothing left to put beside them", () => {
        expect(packOverviewSpans([card(1), card(1)], 4)).toEqual([2, 2]);
    });

    it("never draws a card below the width it stays legible at", () => {
        // The pinned-links card starts at two columns, and a row of three has one
        // to spare: it waits for the next row rather than being squeezed into it.
        expect(packOverviewSpans([card(2), card(2, 2, 4)], 3)[1]).toBeGreaterThanOrEqual(2);
    });

    it("keeps a card inside its widest size while there are rows below it", () => {
        // A card that needs three columns cannot go in the one the first row has
        // left, so that row is short - and its cards are already as wide as they
        // are worth drawing, which is where it stays.
        expect(packOverviewSpans([card(2, 1, 2), card(3, 3, 3), card(3, 3, 3)], 6)).toEqual([2, 3, 6]);
    });

    it("takes a card down from the row above rather than leaving one on its own", () => {
        // Six columns and four cards of two: the fourth would sit alone against
        // four empty columns, so the row above hands one down and refills itself.
        const spans = packOverviewSpans([card(2), card(2), card(2), card(2)], 6);

        expect(rows(spans, 6)).toEqual([
            [3, 3],
            [3, 3]
        ]);
    });

    it("is the same layout every time it is asked", () => {
        const items = [card(2), card(1), card(3), card(1)];

        expect(packOverviewSpans(items, 5)).toEqual(packOverviewSpans(items, 5));
    });

    it("draws one card per row on the narrowest grid", () => {
        expect(packOverviewSpans([card(4), card(2), card(1)], 1)).toEqual([1, 1, 1]);
    });
});
