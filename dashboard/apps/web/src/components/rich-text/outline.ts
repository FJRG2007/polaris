/**
 * A document's outline: its headings, in order, each with an address.
 *
 * Pure, so the table of contents the reader draws and the one the editor draws
 * come from the same walk, and so it can be tested without a DOM. Only headings
 * at the top level count: a heading inside a quote or a list is part of that
 * block, not a section of the document.
 */

import type { JSONContent } from "@tiptap/core";

export interface OutlineEntry {
    readonly level: number;
    readonly text: string;
    /** The heading's anchor, unique within the document. */
    readonly id: string;
    /** Which top-level block it is. */
    readonly index: number;
}

/** The fences drawn as something other than code. */
export const RENDERED_FENCES = ["math", "mermaid"] as const;
export type RenderedFence = (typeof RENDERED_FENCES)[number];

export function renderedFence(language: string | null | undefined): RenderedFence | null {
    const token = (language ?? "").trim().toLowerCase();
    return (RENDERED_FENCES as readonly string[]).includes(token) ? (token as RenderedFence) : null;
}

/** A heading's text as an anchor: lowercase words joined by dashes. */
export function headingSlug(text: string): string {
    const slug = text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "section";
}

function textOf(node: JSONContent): string {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "inlineMath") return String(node.attrs?.latex ?? "");
    if (node.type === "reference") return String(node.attrs?.label ?? "");
    return (node.content ?? []).map(textOf).join("");
}

/** The headings of a list of top-level blocks. */
export function outlineOf(blocks: readonly JSONContent[] | undefined): OutlineEntry[] {
    const seen = new Map<string, number>();
    const out: OutlineEntry[] = [];
    (blocks ?? []).forEach((block, index) => {
        if (block.type !== "heading") return;
        const text = textOf(block).trim();
        const base = headingSlug(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        out.push({
            level: Number(block.attrs?.level ?? 1) || 1,
            text,
            id: count === 0 ? base : `${base}-${count + 1}`,
            index
        });
    });
    return out;
}

/**
 * The top-level blocks a set of folded headings hides.
 *
 * A folded heading hides everything after it up to the next heading of the
 * same or a higher rank, the way an outline does - a folded section takes its
 * subsections with it.
 *
 * @param levels - Each top-level block's heading level, or null when it is not
 *   a heading.
 * @param folded - The indices of the headings that are folded.
 */
export function hiddenBlocks(
    levels: readonly (number | null)[],
    folded: ReadonlySet<number>
): Set<number> {
    const hidden = new Set<number>();
    for (const start of folded) {
        const level = levels[start];
        if (level === null || level === undefined) continue;
        for (let index = start + 1; index < levels.length; index++) {
            const next = levels[index];
            if (next !== null && next !== undefined && next <= level) break;
            hidden.add(index);
        }
    }
    return hidden;
}
