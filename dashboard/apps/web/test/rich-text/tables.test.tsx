/**
 * A GFM table is drawn as a table by the reader every screen shares, while
 * the document - and so the editor's round trip - keeps it as its Markdown.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "@/components/rich-text/rich-text";
import {
    docToMarkdown,
    markdownTable,
    markdownToDoc,
    MARKDOWN_BLOCK,
    READER_TABLE
} from "@/components/rich-text/markdown";

const TABLE = [
    "| Plan | Price | Notes |",
    "| :--- | ---: | :---: |",
    "| Free | 0 | **basic** |",
    "| Pro | 12 | `api` access |"
].join("\n");

describe("markdown tables", () => {
    it("reads a table's cells and alignment", () => {
        const table = markdownTable(TABLE);
        expect(table?.type).toBe(READER_TABLE);
        expect(table?.attrs?.align).toEqual(["left", "right", "center"]);
        expect(table?.content).toHaveLength(3);
        expect(table?.content?.[0]?.attrs?.header).toBe(true);
        const bold = table?.content?.[1]?.content?.[2]?.content?.[0];
        expect(bold?.text).toBe("basic");
        expect(bold?.marks?.[0]?.type).toBe("bold");
    });

    it("is not a table when the source is anything else", () => {
        expect(markdownTable("<div>raw</div>")).toBeNull();
        expect(markdownTable("just | a pipe")).toBeNull();
    });

    it("keeps the table as Markdown in the document, so the editor round-trips it", () => {
        const doc = markdownToDoc(TABLE);
        expect(doc.content?.[0]?.type).toBe(MARKDOWN_BLOCK);
        expect(docToMarkdown(doc)).toBe(TABLE);
    });

    it("draws a real table inside a box that scrolls, not the source", () => {
        const html = renderToStaticMarkup(<RichText value={`Prices:\n\n${TABLE}\n\nDone.`} />);
        expect(html).toContain("<table");
        expect(html).toContain("<th");
        expect(html).toContain("<strong>basic</strong>");
        expect(html).toContain("overflow-x-auto");
        expect(html).not.toContain("| Plan |");
        expect(html).toContain("<p>Done.</p>");
    });

    it("still shows raw HTML as its source", () => {
        const html = renderToStaticMarkup(<RichText value={"<div>raw</div>"} />);
        expect(html).toContain("<pre>");
        expect(html).not.toContain("<table");
    });
});
