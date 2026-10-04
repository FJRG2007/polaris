/**
 * A formatted document leaves with its formatting.
 *
 * The document editor gained a toolbar - fonts, sizes, colours, highlights,
 * alignment, indents, links, tables - and every one of those is stored in the
 * Yjs tree the export reads. The export used to flatten each paragraph to its
 * bare text, so a document set in red, centred and bold arrived in Word as
 * plain left-aligned text. These build the tree the way the editor's own
 * binding does (y-prosemirror, against the document schema) and read the
 * Word package and the page that come out.
 */

import * as Y from "yjs";
import JSZip from "jszip";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { OFFICE_FIELD } from "@/lib/office/content";
import { exportDocument } from "@/lib/office/export";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import { documentExtensions } from "@/components/rich-text/document-schema";

const schema = getSchema(documentExtensions(""));

/** A stored document, written through the same binding the editor uses. */
function stored(content: unknown[]): Uint8Array {
    const doc = prosemirrorJSONToYDoc(schema, { type: "doc", content }, OFFICE_FIELD);
    return Y.encodeStateAsUpdate(doc);
}

const text = (value: string, marks: unknown[] = []) => ({ type: "text", text: value, marks });

const formatted = stored([
    {
        type: "paragraph",
        attrs: { textAlign: "center", indent: 2 },
        content: [
            text("Bold red ", [
                { type: "bold" },
                { type: "textStyle", attrs: { color: "#dc2626", fontFamily: "Georgia", fontSize: "18pt" } }
            ]),
            text("marked", [{ type: "highlight", attrs: { color: "#fef08a" } }, { type: "underline" }]),
            text(" and "),
            text("linked", [{ type: "link", attrs: { href: "https://example.com/a?b=1&c=2" } }])
        ]
    },
    {
        type: "table",
        content: [
            {
                type: "tableRow",
                content: [
                    { type: "tableHeader", content: [{ type: "paragraph", content: [text("Name")] }] },
                    { type: "tableHeader", content: [{ type: "paragraph", content: [text("Role")] }] }
                ]
            },
            {
                type: "tableRow",
                content: [
                    { type: "tableCell", content: [{ type: "paragraph", content: [text("Ada")] }] },
                    { type: "tableCell", content: [{ type: "paragraph", content: [text("Engineer")] }] }
                ]
            }
        ]
    },
    {
        type: "taskList",
        content: [
            {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [text("First")] }]
            },
            {
                type: "taskItem",
                attrs: { checked: true },
                content: [{ type: "paragraph", content: [text("Second")] }]
            }
        ]
    }
]);

async function wordParts(): Promise<{ body: string; rels: string }> {
    const out = await exportDocument("doc", "Report", formatted, "docx");
    const zip = await JSZip.loadAsync(out?.bytes ?? new Uint8Array());
    return {
        body: (await zip.file("word/document.xml")?.async("string")) ?? "",
        rels: (await zip.file("word/_rels/document.xml.rels")?.async("string")) ?? ""
    };
}

describe("exporting a formatted document to Word", () => {
    it("keeps bold, colour, font, size, underline and highlight on the runs", async () => {
        const { body } = await wordParts();
        expect(body).toContain("<w:b/>");
        expect(body).toContain('w:color w:val="DC2626"');
        expect(body).toMatch(/w:rFonts[^>]*Georgia/);
        expect(body).toContain('w:sz w:val="36"');
        expect(body).toMatch(/<w:u w:val="single"\/>/);
        expect(body).toMatch(/w:shd [^>]*w:fill="FEF08A"/);
    });

    it("keeps the paragraph's alignment and indent", async () => {
        const { body } = await wordParts();
        expect(body).toContain('<w:jc w:val="center"/>');
        expect(body).toMatch(/<w:ind [^>]*w:left="1440"/);
    });

    it("writes a link as a hyperlink with its address declared", async () => {
        const { body, rels } = await wordParts();
        const id = /<w:hyperlink r:id="([^"]+)"/.exec(body)?.[1];
        expect(id).toBeTruthy();
        expect(rels).toContain(`Id="${id}"`);
        expect(rels).toContain('Target="https://example.com/a?b=1&amp;c=2"');
        expect(rels).toContain('TargetMode="External"');
    });

    it("writes a table as a table, cell by cell", async () => {
        const { body } = await wordParts();
        expect(body).toContain("<w:tbl>");
        for (const cell of ["Name", "Role", "Ada", "Engineer"]) expect(body).toContain(`>${cell}<`);
    });

    it("writes each checklist item as its own list item", async () => {
        const { body } = await wordParts();
        expect(body).toContain(">First<");
        expect(body).toContain(">Second<");
        expect(body).not.toContain("FirstSecond");
    });
});

describe("exporting a formatted document to a page and to Markdown", () => {
    it("carries the formatting into the page, escaped", async () => {
        const out = await exportDocument("doc", "Report", formatted, "html");
        const html = new TextDecoder().decode(out?.bytes);
        expect(html).toContain('style="text-align:center;margin-left:4rem"');
        expect(html).toContain("<strong>");
        expect(html).toContain("color:#dc2626");
        expect(html).toContain("background-color:#fef08a");
        expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">');
        expect(html).toContain("<th>Name</th>");
    });

    it("writes the table as a Markdown table", async () => {
        const out = await exportDocument("doc", "Report", formatted, "md");
        const md = new TextDecoder().decode(out?.bytes);
        expect(md).toContain("| Name | Role |");
        expect(md).toContain("| Ada | Engineer |");
    });

    it("never writes a stored value that is not a colour or a safe link", async () => {
        const hostile = stored([
            {
                type: "paragraph",
                content: [
                    text("x", [
                        { type: "textStyle", attrs: { color: "red;background:url(evil)" } },
                        { type: "link", attrs: { href: "javascript:alert(1)" } }
                    ])
                ]
            }
        ]);
        const out = await exportDocument("doc", "T", hostile, "html");
        const html = new TextDecoder().decode(out?.bytes);
        expect(html).not.toContain("url(evil)");
        expect(html).not.toContain("javascript:");
    });
});
