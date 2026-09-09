/**
 * A file somebody already has, opened as a document.
 *
 * What is pinned here is mostly the round trip, because it is the only check
 * that means anything: the editors store a CRDT rather than a format, so an
 * import is right exactly when what comes back out of the exporter is what went
 * in. Anything looser passes while the document opens empty - the cells written
 * under a sheet id the shape does not declare, the paragraphs written as nodes
 * the schema does not name - and both of those are silent.
 */

import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { exportDocument } from "@/lib/office/export";
import { importFile, importableKind, OfficeImportError } from "@/lib/office/import";

const utf8 = new TextEncoder();

/** What the exporter makes of what the importer wrote. */
async function roundTrip(filename: string, bytes: Uint8Array, format: string): Promise<string> {
    const imported = await importFile(filename, bytes);
    const out = await exportDocument(imported.kind, imported.title, imported.update, format);
    return new TextDecoder().decode(out?.bytes ?? new Uint8Array());
}

describe("what can be opened", () => {
    it("knows a spreadsheet from a document", () => {
        expect(importableKind("Budget 2026.xlsx")).toBe("sheet");
        expect(importableKind("notes.CSV")).toBe("sheet");
        expect(importableKind("contract.docx")).toBe("doc");
        expect(importableKind("README.md")).toBe("doc");
    });

    it("says so by name when it cannot", async () => {
        expect(importableKind("scan.pdf")).toBeNull();
        await expect(importFile("scan.pdf", utf8.encode("%PDF-1.4"))).rejects.toBeInstanceOf(
            OfficeImportError
        );
        await expect(importFile("empty.csv", new Uint8Array())).rejects.toBeInstanceOf(
            OfficeImportError
        );
    });

    it("refuses a file whose bytes are not what its name says", async () => {
        // A renamed file opened as an empty spreadsheet is worse than a refusal:
        // whatever it actually was is gone and nothing said so.
        await expect(
            importFile("accounts.xlsx", utf8.encode("this is not a workbook"))
        ).rejects.toBeInstanceOf(OfficeImportError);
    });
});

describe("a spreadsheet", () => {
    it("comes back out of the exporter as the grid that went in", async () => {
        const csv = "Item,Cost\nCoffee,4.5\nBread,2\n";
        const out = await roundTrip("Shopping.csv", utf8.encode(csv), "csv");
        expect(out.trim().split(/\r?\n/)).toEqual(["Item,Cost", "Coffee,4.5", "Bread,2"]);
    });

    it("keeps every sheet, under the name it had", async () => {
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["a", "b"]]), "Enero");
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["c"]]), "Febrero");
        const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));

        const imported = await importFile("Ventas.xlsx", bytes);
        expect(imported.kind).toBe("sheet");
        expect(imported.title).toBe("Ventas");

        const out = await exportDocument("sheet", "Ventas", imported.update, "xlsx");
        const back = XLSX.read(out?.bytes ?? new Uint8Array(), { type: "array" });
        expect(back.SheetNames).toEqual(["Enero", "Febrero"]);
    });

    it("leaves an empty cell empty rather than writing a blank into it", async () => {
        const out = await roundTrip("Gaps.csv", utf8.encode("a,,c\n"), "csv");
        expect(out.trim()).toBe("a,,c");
    });
});

describe("a document", () => {
    const markdown = [
        "# Quarterly review",
        "",
        "The first paragraph.",
        "",
        "- one",
        "- two",
        "",
        "> Somebody said this",
        "",
        "```",
        "const answer = 42;",
        "```"
    ].join("\n");

    it("keeps its headings, list, quotation and code through a round trip", async () => {
        const out = await roundTrip("Review.md", utf8.encode(markdown), "md");
        expect(out).toContain("# Quarterly review");
        expect(out).toContain("The first paragraph.");
        expect(out).toContain("- one");
        expect(out).toContain("- two");
        expect(out).toContain("Somebody said this");
        expect(out).toContain("const answer = 42;");
    });

    it("gathers the items of a list into one list rather than leaving them loose", async () => {
        const imported = await importFile("List.md", utf8.encode("- one\n- two\n- three\n"));
        // The exporter walks the tree, so three items reaching it means the
        // three list items were inside a list node it recognised.
        const out = await exportDocument("doc", "List", imported.update, "md");
        const lines = new TextDecoder().decode(out?.bytes).trim().split(/\r?\n/);
        expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(3);
    });

    it("reads a Word document Polaris itself wrote", async () => {
        // The strongest check available without a fixture: export a document to
        // docx through the real OOXML engine, then read it back.
        const first = await importFile("Review.md", utf8.encode(markdown));
        const docx = await exportDocument("doc", "Review", first.update, "docx");
        expect(docx?.bytes.length ?? 0).toBeGreaterThan(0);

        const back = await importFile("Review.docx", docx?.bytes ?? new Uint8Array());
        const out = await exportDocument("doc", "Review", back.update, "md");
        const text = new TextDecoder().decode(out?.bytes);
        expect(text).toContain("# Quarterly review");
        expect(text).toContain("The first paragraph.");
        expect(text).toContain("- one");
    });

    it("takes its name from the file, without the extension", async () => {
        const imported = await importFile("Notes from Tuesday.txt", utf8.encode("Hello"));
        expect(imported.title).toBe("Notes from Tuesday");
    });
});
