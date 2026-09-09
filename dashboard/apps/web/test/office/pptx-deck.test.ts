import { describe, expect, it } from "vitest";
import { writePptx } from "@/lib/office/ooxml";
import type { RenderNode } from "@polaris/pptx-render";
import { renderPptxDeck } from "@/lib/office/pptx-deck";

/**
 * A PowerPoint file, read by the engine that understands one.
 *
 * Drive has shown .pptx files for a long time through a parser written here that
 * reads shapes and paragraphs and positions them absolutely. It has no theme
 * inheritance, no layout or master chain, no gradient or picture fills, no
 * charts and no tables - so a deck built from a template, which is every deck
 * anybody is handed, draws in the wrong colours at the wrong sizes with no sign
 * to the reader that it is doing so.
 *
 * This is the real engine instead, and what these pin is that it is genuinely
 * wired: a deck written by the exporter comes back with its pages, its slide
 * geometry, and its words where the words are.
 *
 * The deck is built rather than committed as a fixture. A .pptx in the
 * repository is a binary nobody can review, and the exporter that writes this
 * one is the same engine's - so the two halves are tested against each other
 * rather than against a file whose provenance is a download.
 */
describe("reading a PowerPoint file", () => {
    /** Every string the renderer decided to draw, anywhere in a page. */
    const words = (nodes: readonly RenderNode[]): string[] => {
        const found: string[] = [];
        const walk = (list: readonly RenderNode[]): void => {
            for (const node of list) {
                const layout = (node as { text?: { lines?: { runs?: { text?: string }[] }[] } })
                    .text;
                for (const line of layout?.lines ?? []) {
                    for (const run of line.runs ?? []) if (run.text) found.push(run.text);
                }
                const children = (node as { children?: RenderNode[] }).children;
                if (children) walk(children);
            }
        };
        walk(nodes);
        return found;
    };

    it("gives back one page per slide, in order", async () => {
        const bytes = await writePptx([
            { notes: "", lines: ["First page"] },
            { notes: "", lines: ["Second page"] },
            { notes: "", lines: ["Third page"] }
        ]);
        const deck = await renderPptxDeck(bytes);
        expect(deck.slides).toHaveLength(3);
        expect(words(deck.slides[0]!.nodes).join(" ")).toContain("First");
        expect(words(deck.slides[2]!.nodes).join(" ")).toContain("Third");
    });

    it("resolves the geometry against the width it was asked for", async () => {
        // The whole reason the width is a parameter: the coordinates in a page
        // already include the scale, so a deck is rebuilt for a reader's width
        // rather than drawn once and stretched.
        const bytes = await writePptx([{ notes: "", lines: ["Anything"] }]);
        const narrow = await renderPptxDeck(bytes, 640);
        const wide = await renderPptxDeck(bytes, 1280);
        expect(narrow.slides[0]!.widthPx).toBe(640);
        expect(wide.slides[0]!.widthPx).toBe(1280);
        // 16:9, and the height follows rather than being asked for.
        expect(wide.slides[0]!.heightPx).toBeGreaterThan(narrow.slides[0]!.heightPx);
        expect(wide.slides[0]!.heightPx / wide.slides[0]!.widthPx).toBeCloseTo(
            narrow.slides[0]!.heightPx / narrow.slides[0]!.widthPx,
            5
        );
    });

    it("draws something for a page that has content", async () => {
        // A page that parses but builds no nodes is the failure this replaces:
        // it renders as a blank rectangle and looks like an empty slide rather
        // than like a deck that was not understood.
        const deck = await renderPptxDeck(
            await writePptx([{ notes: "", lines: ["Alpha", "Beta", "Gamma"] }])
        );
        expect(deck.slides[0]!.nodes.length).toBeGreaterThan(0);
        expect(words(deck.slides[0]!.nodes).join(" ")).toContain("Beta");
    });

    it("refuses a file that is not a presentation, rather than answering an empty deck", async () => {
        // An empty deck and an unreadable file look identical on screen, and only
        // one of them is worth telling somebody about.
        await expect(
            renderPptxDeck(new TextEncoder().encode("this is not a pptx"))
        ).rejects.toThrow();
    });
});
