import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "@/components/rich-text/markdown";
import { headingSlug, hiddenBlocks, outlineOf, renderedFence } from "@/components/rich-text/outline";

const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(markdown));

describe("inline math", () => {
    it("reads a code span between dollar signs as a formula", () => {
        const doc = markdownToDoc("Area $`\\pi r^2`$ here");
        expect(doc.content?.[0]?.content).toEqual([
            { type: "text", text: "Area " },
            { type: "inlineMath", attrs: { latex: "\\pi r^2" } },
            { type: "text", text: " here" }
        ]);
    });

    it("round-trips formulas, two in a row included", () => {
        expect(roundTrip("$`a`$ and $`b^2`$")).toBe("$`a`$ and $`b^2`$");
    });

    it("leaves prices and plain code spans alone", () => {
        const doc = markdownToDoc("It cost $5 and `x` and $6");
        const types = doc.content?.[0]?.content?.map((node) => node.type);
        expect(types).not.toContain("inlineMath");
    });

    it("fences a formula holding a backtick with a longer run", () => {
        const md = docToMarkdown({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "inlineMath", attrs: { latex: "a`b" } }] }]
        });
        expect(md).toBe("$``a`b``$");
        expect(markdownToDoc(md).content?.[0]?.content?.[0]).toEqual({
            type: "inlineMath",
            attrs: { latex: "a`b" }
        });
    });
});

describe("table of contents", () => {
    it("reads [TOC] on its own line as the block and writes it back", () => {
        const doc = markdownToDoc("# One\n\n[TOC]\n\ntext [TOC] inline");
        expect(doc.content?.[1]).toEqual({ type: "tableOfContents" });
        expect(doc.content?.[2]?.type).toBe("paragraph");
        expect(roundTrip("# One\n\n[toc]\n\nBody")).toBe("# One\n\n[TOC]\n\nBody");
    });
});

describe("rendered fences", () => {
    it("keeps math and mermaid fences as code blocks", () => {
        const md = "```math\nE = mc^2\n```\n\n```mermaid\ngraph TD; A-->B\n```";
        expect(roundTrip(md)).toBe(md);
        expect(renderedFence("Mermaid")).toBe("mermaid");
        expect(renderedFence("ts")).toBeNull();
    });
});

describe("outline", () => {
    it("lists top-level headings with unique anchors", () => {
        const doc = markdownToDoc("# Intro\n\ntext\n\n## Café Ñu\n\n> # quoted\n\n# Intro");
        expect(outlineOf(doc.content).map((entry) => [entry.level, entry.id, entry.index])).toEqual([
            [1, "intro", 0],
            [2, "cafe-nu", 2],
            [1, "intro-2", 4]
        ]);
        expect(headingSlug("!!!")).toBe("section");
    });

    it("folds a section and its subsections, up to the next heading of its rank", () => {
        // h1, p, h2, p, h1, p
        const levels = [1, null, 2, null, 1, null];
        expect([...hiddenBlocks(levels, new Set([0]))]).toEqual([1, 2, 3]);
        expect([...hiddenBlocks(levels, new Set([2]))]).toEqual([3]);
        expect([...hiddenBlocks(levels, new Set([1]))]).toEqual([]);
    });
});
