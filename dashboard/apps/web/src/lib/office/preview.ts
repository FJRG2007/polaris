/**
 * The small picture of a document on the Office home: its first page, sheet or
 * slide, as the words and shape that are on it.
 *
 * Drawn by the browser from a few hundred bytes rather than rendered to an image
 * on the server. A document here is a CRDT, not a file, and there is no renderer
 * on the server that turns one into a page - so what the server hands back is the
 * start of the content, already cut to what a tile can show, and the tile lays it
 * out as a miniature page, grid or slide. It is the same content the exports read
 * (`lib/office/export`), so a preview never shows something the document does not
 * say.
 *
 * Pure and safe in the browser: the shape the route answers with, and the cut
 * that keeps it small, so both ends agree on one schema.
 */

import { z } from "zod";

/** Lines of a page a tile shows. More would be below its bottom edge. */
export const PREVIEW_BLOCKS = 14;
/** Rows and columns of a sheet a tile shows. */
export const PREVIEW_ROWS = 12;
export const PREVIEW_COLUMNS = 6;
/** Lines of a slide a tile shows. */
export const PREVIEW_LINES = 6;
/** The longest text one line or cell carries; the tile truncates long before. */
export const PREVIEW_TEXT = 160;

const text = z.string().max(PREVIEW_TEXT);
const grid = z.array(z.array(text).max(PREVIEW_COLUMNS)).max(PREVIEW_ROWS);

export const officePreviewSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("doc"),
        /** "h1".."h6", "p", "li", "oli", "quote", "code", "table". */
        blocks: z.array(z.object({ kind: z.string().max(8), text })).max(PREVIEW_BLOCKS)
    }),
    z.object({ kind: z.literal("sheet"), rows: grid }),
    z.object({ kind: z.literal("comparison"), rows: grid }),
    z.object({
        kind: z.literal("slides"),
        /** The first slide's words, its title first. */
        lines: z.array(text).max(PREVIEW_LINES),
        /** How many slides the deck has. */
        count: z.number().int().nonnegative()
    }),
    /** A kind that has no preview of its words - a drawing - or nothing yet. */
    z.object({ kind: z.literal("none") })
]);

export type OfficePreview = z.infer<typeof officePreviewSchema>;

/** One line cut to what a preview carries, never ending on half a character. */
export function clipLine(value: string): string {
    const flat = value.replace(/\s+/g, " ").trim();
    if (flat.length <= PREVIEW_TEXT) return flat;
    const cut = flat.slice(0, PREVIEW_TEXT);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The top-left corner of a grid, trimmed of the empty rows and columns at its
 *  bottom and right, so a sheet with one cell filled is not a page of blanks. */
export function clipGrid(rows: readonly (readonly string[])[]): string[][] {
    const cut = rows
        .slice(0, PREVIEW_ROWS)
        .map((row) => row.slice(0, PREVIEW_COLUMNS).map(clipLine));
    let width = 0;
    for (const row of cut) {
        for (let at = row.length - 1; at >= width; at -= 1) {
            if (row[at]) {
                width = at + 1;
                break;
            }
        }
    }
    let height = cut.length;
    while (height > 0 && !cut[height - 1]?.some(Boolean)) height -= 1;
    return cut
        .slice(0, height)
        .map((row) => Array.from({ length: width }, (_, at) => row[at] ?? ""));
}

/** A document's first blocks. A table is drawn as its first row's words; an
 *  empty paragraph is skipped, since a tile has no room for blank lines. */
export function clipBlocks(
    blocks: readonly { kind: string; text: string; rows?: readonly (readonly string[])[] }[]
): { kind: string; text: string }[] {
    const kept: { kind: string; text: string }[] = [];
    for (const block of blocks) {
        if (kept.length >= PREVIEW_BLOCKS) break;
        const words = block.kind === "table" ? (block.rows?.[0] ?? []).join("  ") : block.text;
        const line = clipLine(words);
        if (!line) continue;
        kept.push({ kind: block.kind.slice(0, 8), text: line });
    }
    return kept;
}

/** A deck's first slide, and how many there are. */
export function clipSlides(slides: readonly { lines: readonly string[] }[]): {
    lines: string[];
    count: number;
} {
    const first = slides[0]?.lines ?? [];
    return {
        lines: first.map(clipLine).filter(Boolean).slice(0, PREVIEW_LINES),
        count: slides.length
    };
}
