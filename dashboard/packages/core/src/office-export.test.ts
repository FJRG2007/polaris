/**
 * What lands in somebody else's program.
 *
 * An export has one chance to be right: it is opened by Excel on a machine we
 * have never seen, or by a browser from a Downloads folder, and there is no
 * round trip in which a mistake shows up. So what is pinned here is the
 * escaping - the part that is silently wrong, and in one case actively
 * dangerous.
 */

import * as x from "./office-export.js";
import { describe, expect, it } from "vitest";

describe("a field in a comma-separated file", () => {
    it("is left alone when nothing about it needs quoting", () => {
        expect(x.csvField("Acme")).toBe("Acme");
    });

    it("is quoted when it holds the separator", () => {
        expect(x.csvField("Acme, Inc")).toBe('"Acme, Inc"');
    });

    it("doubles the quotes inside it", () => {
        expect(x.csvField('He said "no"')).toBe('"He said ""no"""');
    });

    it("is quoted when it holds a newline, so a cell is not a row", () => {
        expect(x.csvField("one\ntwo")).toBe('"one\ntwo"');
    });

    it("is quoted when it begins or ends with a space, which readers eat", () => {
        expect(x.csvField(" padded")).toBe('" padded"');
        expect(x.csvField("padded ")).toBe('"padded "');
    });

    it("defuses a cell a spreadsheet would run", () => {
        // The one that matters. A comparison somebody filled in with `=cmd|...`
        // is, without this, a file that runs it on the machine of whoever it was
        // sent to.
        expect(x.csvField("=1+1")).toBe("'=1+1");
        expect(x.csvField("+44 20 7946")).toBe("'+44 20 7946");
        expect(x.csvField("-1")).toBe("'-1");
        expect(x.csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    });

    it("quotes a dangerous cell that also needs quoting, in that order", () => {
        expect(x.csvField('=cmd|"/c calc"')).toBe('"\'=cmd|""/c calc"""');
    });
});

describe("a whole sheet", () => {
    it("separates rows the way the format says", () => {
        expect(x.toCsv([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d");
    });

    it("has nothing to say about no rows", () => {
        expect(x.toCsv([])).toBe("");
    });
});

describe("a document as Markdown", () => {
    it("leads with the title and keeps the headings", () => {
        const out = x.toMarkdown("The plan", [
            { kind: "h2", text: "Background" },
            { kind: "p", text: "It started in March." }
        ]);
        expect(out).toContain("# The plan");
        expect(out).toContain("## Background");
        expect(out).toContain("It started in March.");
    });

    it("does not let a paragraph become a list", () => {
        // "1. " at the start of a paragraph is a numbered list to every reader
        // in the world, and it was a sentence to whoever typed it.
        expect(x.toMarkdown("", [{ kind: "p", text: "1. was the first year" }])).toContain(
            "1\\. was the first year"
        );
        expect(x.toMarkdown("", [{ kind: "p", text: "- not a bullet" }])).toContain(
            "\\- not a bullet"
        );
    });

    it("keeps a real list a list", () => {
        expect(x.toMarkdown("", [{ kind: "li", text: "first" }])).toContain("- first");
    });

    it("drops empty blocks rather than leaving holes", () => {
        expect(x.toMarkdown("T", [{ kind: "p", text: "   " }]).trim()).toBe("# T");
    });
});

describe("a table as Markdown", () => {
    it("has the separator row that makes it a table", () => {
        const out = x.tableToMarkdown([["Name", "Price"], ["Acme", "10"]]);
        expect(out.split("\n")[1]).toBe("| --- | --- |");
    });

    it("escapes a cell that would end the column", () => {
        expect(x.tableToMarkdown([["a|b"]])).toContain("a\\|b");
    });

    it("pads a short row, so the columns stay lined up", () => {
        const out = x.tableToMarkdown([["a", "b", "c"], ["one"]]);
        expect(out.split("\n")[2]).toBe("| one |  |  |");
    });

    it("has nothing to say about no rows", () => {
        expect(x.tableToMarkdown([])).toBe("");
    });
});

describe("a document as a page", () => {
    it("never lets the document's own text be markup", () => {
        const out = x.toHtml("A & B", [{ kind: "p", text: "<script>alert(1)</script>" }]);
        expect(out).not.toContain("<script>alert(1)</script>");
        expect(out).toContain("&lt;script&gt;");
        expect(out).toContain("A &amp; B");
    });

    it("gathers consecutive items into one list", () => {
        const out = x.toHtml("", [
            { kind: "li", text: "one" },
            { kind: "li", text: "two" },
            { kind: "p", text: "after" }
        ]);
        expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
        expect(out).toContain("<p>after</p>");
    });

    it("carries its own styling, because nothing is beside it in a folder", () => {
        expect(x.toHtml("T", [])).toContain("<style>");
    });
});

describe("what the file is called", () => {
    it("is the document's own name", () => {
        expect(x.exportFilename("Q3 plan", "docx")).toBe("Q3 plan.docx");
    });

    it("never walks up a directory or escapes a header", () => {
        expect(x.exportFilename("../../etc/passwd", "csv")).not.toContain("/");
        expect(x.exportFilename("../../etc/passwd", "csv")).not.toContain("..");
        expect(x.exportFilename('a"b\nc', "csv")).not.toContain('"');
        expect(x.exportFilename('a"b\nc', "csv")).not.toContain("\n");
    });

    it("is never nothing", () => {
        expect(x.exportFilename("", "csv")).toBe("document.csv");
        expect(x.exportFilename("///", "csv")).toBe("document.csv");
    });
});
