/**
 * Fitting the Overview's cards to the row they are in.
 *
 * The grid is a whole number of equal columns and every card carries a width of
 * its own, so the widths in a row almost never add up to the columns there are.
 * Left at that the grid ends the row early, and the screen finishes with a card
 * floating beside a strip of nothing - the arrangement reads as a mistake even
 * though every card is exactly the width it was set to.
 *
 * So a stored width is where a card starts, not where it ends. Cards go into a
 * row in their own order at the width they asked for; the one that would spill
 * over is narrowed to what the row has left, and a row that still falls short is
 * widened card by card until it spans the whole width. What is never traded is
 * the order: the card that is third is third at every screen width. Nor is
 * legibility, with one exception - a card is never drawn below the narrowest size
 * its catalogue entry allows, and never above the widest either, except on a last
 * row that has run out of cards to fill itself with.
 *
 * Pure, and separate from the grid, because it is the one part of the layout
 * that is arithmetic and can be read back in a test at every column count.
 */

/** One card's room to move, in columns. */
export interface PackItem {
    /** The width it is set to. */
    readonly preferred: number;
    /** The narrowest it stays legible at. */
    readonly min: number;
    /** The widest it is worth drawing. */
    readonly max: number;
}

interface Bounds {
    min: number;
    max: number;
    preferred: number;
}

/** A stretch of cards sharing one row, as indices into the list. */
interface Row {
    start: number;
    end: number;
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high);
}

/** The widest this stretch of cards could be drawn, all of them at their limit. */
function capacity(bounds: readonly Bounds[], row: Row): number {
    let total = 0;
    for (let index = row.start; index < row.end; index += 1) total += bounds[index]!.max;
    return total;
}

/**
 * Make one row span the width exactly.
 *
 * A column at a time in both directions, rather than taking it all from one
 * card: what is spare gets shared out from the front, and what is over comes off
 * the back, so the cards nearest the top of the row stay closest to the width
 * they were set to. A row that runs out of room to give in either direction is
 * left as it is rather than drawn at a size its cards are not legible at.
 */
function fit(bounds: readonly Bounds[], spans: number[], row: Row, width: number, relax = false): void {
    let total = 0;
    for (let index = row.start; index < row.end; index += 1) total += spans[index]!;
    while (total > width) {
        let narrowed = false;
        for (let index = row.end - 1; index >= row.start && total > width; index -= 1) {
            if (spans[index]! <= bounds[index]!.min) continue;
            spans[index] = spans[index]! - 1;
            total -= 1;
            narrowed = true;
        }
        if (!narrowed) return;
    }
    while (total < width) {
        let widened = false;
        for (let index = row.start; index < row.end && total < width; index += 1) {
            if (spans[index]! >= bounds[index]!.max) continue;
            spans[index] = spans[index]! + 1;
            total += 1;
            widened = true;
        }
        if (!widened) break;
    }
    // The last row, with every card already at its widest and columns still to
    // spare: one card left over on a very wide grid. Widest is about how much
    // width a card can USE, and a row that stops halfway across the screen reads
    // as something broken, so here the limit gives way rather than the row.
    while (relax && total < width) {
        for (let index = row.start; index < row.end && total < width; index += 1) {
            spans[index] = spans[index]! + 1;
            total += 1;
        }
    }
}

/**
 * How many columns each card spans, given how many the grid has.
 *
 * The returned list is in the order it was given: this decides widths, never
 * positions.
 */
export function packOverviewSpans(items: readonly PackItem[], columns: number): number[] {
    const width = Math.max(1, Math.floor(columns));
    const bounds: Bounds[] = items.map((item) => {
        const min = clamp(item.min, 1, width);
        const max = clamp(Math.max(item.max, min), min, width);
        return { min, max, preferred: clamp(item.preferred, min, max) };
    });

    const spans = bounds.map((bound) => bound.preferred);
    const rows: Row[] = [];
    let start = 0;
    while (start < bounds.length) {
        let used = 0;
        let end = start;
        while (end < bounds.length) {
            const left = width - used;
            const bound = bounds[end]!;
            if (bound.preferred <= left) {
                spans[end] = bound.preferred;
                used += bound.preferred;
                end += 1;
                continue;
            }
            // It does not fit as it stands. Narrowing it into the gap keeps the row
            // whole and keeps this card where its reader put it; only a card that
            // would not be legible at that width waits for the next row.
            if (bound.min <= left) {
                spans[end] = left;
                used = width;
                end += 1;
            }
            break;
        }
        // A card wider than the entire grid: it takes the row on its own, at the
        // width the grid has.
        if (end === start) {
            spans[start] = width;
            end = start + 1;
        }
        rows.push({ start, end });
        start = end;
    }

    // A last row that cannot reach the width however wide its cards are drawn -
    // one card left over on a grid of eight columns - borrows from the row above,
    // which then refills itself. Two rows of the right width beat a full row and a
    // stub. The row above only gives while it can still fill without what it gave.
    while (rows.length > 1) {
        const last = rows[rows.length - 1]!;
        const above = rows[rows.length - 2]!;
        if (capacity(bounds, last) >= width) break;
        if (above.end - above.start < 2) break;
        if (capacity(bounds, { start: above.start, end: above.end - 1 }) < width) break;
        above.end -= 1;
        last.start -= 1;
    }

    rows.forEach((row, index) => fit(bounds, spans, row, width, index === rows.length - 1));
    return spans;
}
