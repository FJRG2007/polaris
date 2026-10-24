/**
 * The parts of a search panel that are not drawing: how text is compared, where
 * a match sits in a line so it can be marked, and how the arrow keys move
 * through a list. Pure, so they can be asserted without a browser.
 */

import { allowedEdits, editDistance, normalizeSearchText } from "@polaris/core/search-text";

const WORD = /[\p{L}\p{N}]+/gu;

/** The words of a query as the search compares them: lowercase, accents dropped. */
export function searchTerms(query: string): string[] {
    return normalizeSearchText(query).match(WORD) ?? [];
}

/** A stretch of a line to mark, as `[start, end)` offsets into the original text. */
export type MatchRange = readonly [number, number];

/**
 * What in `text` made it match `terms`, the way the search itself matched it:
 * a term inside a word, compared without case or accents ("reenv" marks the
 * start of "reenvio" written with its accent), and failing that a whole word
 * the term is a forgivable typo of. Ranges are offsets into the text as given,
 * sorted and never overlapping.
 */
export function highlightRanges(text: string, terms: readonly string[]): MatchRange[] {
    const wanted = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
    if (!wanted.length || !text) return [];
    const ranges: MatchRange[] = [];
    for (const match of text.matchAll(WORD)) {
        const word = match[0];
        const start = match.index ?? 0;
        // Fold one character at a time, so a folded offset maps back to the original.
        let folded = "";
        const begins: number[] = [];
        const ends: number[] = [];
        for (let at = 0; at < word.length;) {
            const char = String.fromCodePoint(word.codePointAt(at)!);
            const piece = normalizeSearchText(char);
            for (let n = 0; n < piece.length; n++) {
                begins.push(at);
                ends.push(at + char.length);
            }
            folded += piece;
            at += char.length;
        }
        let found: MatchRange | null = null;
        for (const term of wanted) {
            const at = folded.indexOf(term);
            if (at !== -1) {
                found = [start + begins[at]!, start + ends[at + term.length - 1]!];
                break;
            }
        }
        if (!found) {
            const near = wanted.some((term) => {
                const limit = allowedEdits(term);
                return limit > 0 && editDistance(term, folded, limit) <= limit;
            });
            if (near) found = [start, start + word.length];
        }
        if (found) ranges.push(found);
    }
    return ranges;
}

/**
 * The row a key moves the highlight to in a list of `count` rows, or `null`
 * when the key is not one that moves it. The arrows wrap at either end.
 */
export function stepActive(key: string, active: number, count: number): number | null {
    if (key === "ArrowDown") return count === 0 ? 0 : (active + 1) % count;
    if (key === "ArrowUp") return count === 0 ? 0 : (active - 1 + count) % count;
    if (key === "Home") return 0;
    if (key === "End") return Math.max(0, count - 1);
    return null;
}

/** Consecutive rows under the same label, each with its place in the whole list. */
export interface RowGroup<Row> {
    readonly label: string;
    readonly rows: { row: Row; position: number }[];
}

/** Rows grouped by `label`, keeping their order: a label met again starts a new group. */
export function groupRows<Row>(rows: readonly Row[], label: (row: Row) => string): RowGroup<Row>[] {
    const groups: { label: string; rows: { row: Row; position: number }[] }[] = [];
    rows.forEach((row, position) => {
        const name = label(row);
        const last = groups[groups.length - 1];
        if (last?.label === name) last.rows.push({ row, position });
        else groups.push({ label: name, rows: [{ row, position }] });
    });
    return groups;
}
