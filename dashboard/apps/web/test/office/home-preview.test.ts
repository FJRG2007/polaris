/**
 * The Office home's previews: what the route cuts a document down to, that the
 * cut always passes the schema the browser reads it with, and the layout a
 * browser keeps.
 */

import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { OFFICE_FIELD } from "@/lib/office/content";
import { previewDocument } from "@/lib/office/export";
import { parseOfficeLayout } from "@/lib/office/layout";
import {
    PREVIEW_BLOCKS,
    PREVIEW_COLUMNS,
    PREVIEW_ROWS,
    PREVIEW_TEXT,
    clipBlocks,
    clipGrid,
    clipLine,
    clipSlides,
    officePreviewSchema
} from "@/lib/office/preview";

/** A stored document, shaped the way the editor's binding writes one. */
function storedDoc(blocks: { name: string; level?: number; text: string }[]): Uint8Array {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(OFFICE_FIELD);
    for (const block of blocks) {
        const element = new Y.XmlElement(block.name);
        if (block.level) element.setAttribute("level", String(block.level));
        element.insert(0, [new Y.XmlText(block.text)]);
        fragment.push([element]);
    }
    return Y.encodeStateAsUpdate(doc);
}

function storedSheet(cells: Record<string, unknown>): Uint8Array {
    const doc = new Y.Doc();
    const map = doc.getMap("cells");
    for (const [key, value] of Object.entries(cells)) map.set(key, { v: value });
    return Y.encodeStateAsUpdate(doc);
}

describe("clipLine", () => {
    it("flattens whitespace and cuts to the limit", () => {
        expect(clipLine("  a \n\t b  ")).toBe("a b");
        expect(clipLine("x".repeat(PREVIEW_TEXT + 50))).toHaveLength(PREVIEW_TEXT);
    });

    it("never ends on half of a character", () => {
        const line = `${"x".repeat(PREVIEW_TEXT - 1)}\u{1F600}`;
        const cut = clipLine(line);
        expect(cut).toBe("x".repeat(PREVIEW_TEXT - 1));
    });
});

describe("clipGrid", () => {
    it("keeps the top-left corner and drops empty trailing rows and columns", () => {
        const rows = [
            ["a", "", "", ""],
            ["", "b", "", ""],
            ["", "", "", ""]
        ];
        expect(clipGrid(rows)).toEqual([
            ["a", ""],
            ["", "b"]
        ]);
    });

    it("never exceeds the tile's rows and columns", () => {
        const big = Array.from({ length: 100 }, () => Array.from({ length: 40 }, () => "v"));
        const cut = clipGrid(big);
        expect(cut).toHaveLength(PREVIEW_ROWS);
        expect(cut.every((row) => row.length === PREVIEW_COLUMNS)).toBe(true);
    });

    it("is empty for an empty sheet", () => {
        expect(clipGrid([["", ""], [""]])).toEqual([]);
    });
});

describe("clipBlocks and clipSlides", () => {
    it("skips empty paragraphs, draws a table by its first row, stops at the limit", () => {
        const blocks = [
            { kind: "h1", text: "Title" },
            { kind: "p", text: "   " },
            {
                kind: "table",
                text: "",
                rows: [
                    ["Name", "Total"],
                    ["x", "1"]
                ]
            },
            ...Array.from({ length: 40 }, (_, at) => ({ kind: "p", text: `line ${at}` }))
        ];
        const cut = clipBlocks(blocks);
        expect(cut[0]).toEqual({ kind: "h1", text: "Title" });
        expect(cut[1]).toEqual({ kind: "table", text: "Name Total" });
        expect(cut).toHaveLength(PREVIEW_BLOCKS);
    });

    it("keeps the first slide and counts them all", () => {
        expect(clipSlides([{ lines: ["Hello", "", "World"] }, { lines: ["Two"] }])).toEqual({
            lines: ["Hello", "World"],
            count: 2
        });
        expect(clipSlides([])).toEqual({ lines: [], count: 0 });
    });
});

describe("previewDocument", () => {
    it("reads a document's first blocks", () => {
        const stored = storedDoc([
            { name: "heading", level: 1, text: "Plan" },
            { name: "paragraph", text: "First step" }
        ]);
        const preview = previewDocument("doc", stored);
        expect(officePreviewSchema.parse(preview)).toEqual(preview);
        expect(preview).toEqual({
            kind: "doc",
            blocks: [
                { kind: "h1", text: "Plan" },
                { kind: "p", text: "First step" }
            ]
        });
    });

    it("reads only the corner of a sheet's first sheet", () => {
        const stored = storedSheet({
            "s1:0:0": "Item",
            "s1:0:1": 42,
            "s1:500:3": "far below",
            "s1:1:99": "far right"
        });
        const preview = previewDocument("sheet", stored);
        expect(officePreviewSchema.parse(preview)).toEqual(preview);
        expect(preview).toEqual({ kind: "sheet", rows: [["Item", "42"]] });
    });

    it("has nothing to draw for an empty document or a drawing", () => {
        expect(previewDocument("doc", null)).toEqual({ kind: "none" });
        expect(previewDocument("diagram", storedSheet({ "s1:0:0": "x" }))).toEqual({
            kind: "none"
        });
    });
});

describe("parseOfficeLayout", () => {
    it("is the grid unless the list was kept", () => {
        expect(parseOfficeLayout("list")).toBe("list");
        expect(parseOfficeLayout("grid")).toBe("grid");
        expect(parseOfficeLayout(null)).toBe("grid");
        expect(parseOfficeLayout("tiles")).toBe("grid");
    });
});
