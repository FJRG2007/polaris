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

import * as Y from "yjs";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { OFFICE_FIELDS } from "@/lib/office/content";
import { exportDocument } from "@/lib/office/export";
import { readSheetCellKey } from "@/lib/office/sheet";
import { importFile, importableKind, OfficeImportError } from "@/lib/office/import";

const utf8 = new TextEncoder();

/** The document, as the tree the editor would bind to. */
function opened(update: Uint8Array): Y.Doc {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    return doc;
}

/** A workbook written by hand, so the range it declares can disagree with the
 *  cells it holds - which is what several generators do. */
async function sheetDeclaring(ref: string, rows: string): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file(
        "[Content_Types].xml",
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
            <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        </Types>`
    );
    zip.file(
        "_rels/.rels",
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
        </Relationships>`
    );
    zip.file(
        "xl/workbook.xml",
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
            <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
        </workbook>`
    );
    zip.file(
        "xl/_rels/workbook.xml.rels",
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        </Relationships>`
    );
    zip.file(
        "xl/worksheets/sheet1.xml",
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
            <dimension ref="${ref}"/><sheetData>${rows}</sheetData>
        </worksheet>`
    );
    return zip.generateAsync({ type: "uint8array" });
}

/** A Word document written by hand, so a numbering can say what its markers
 *  are. Word's own packages carry both kinds and Polaris's writer carries one. */
async function wordDocument(body: string): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file(
        "[Content_Types].xml",
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        </Types>`
    );
    zip.file(
        "_rels/.rels",
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>`
    );
    zip.file(
        "word/numbering.xml",
        `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
            <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
            <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
            <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
        </w:numbering>`
    );
    zip.file(
        "word/document.xml",
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>${body}</w:body>
        </w:document>`
    );
    return zip.generateAsync({ type: "uint8array" });
}

/** One numbered paragraph, under the numbering `numId` names. */
function numbered(numId: string, text: string): string {
    return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

/** A package that arrives small and unpacks to more memory than there is. One
 *  entry of nothing at all, which deflates to a few kilobytes and declares the
 *  size it becomes in the directory every zip carries. */
async function zipBomb(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("word/document.xml", new Uint8Array(96 * 1024 * 1024));
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** The workbook shape the importer wrote, as the browser would read it back -
 *  through the same encoding, because that is where a key can still be lost. */
function shapeOf(update: Uint8Array): { sheets: Record<string, { name?: string }> } {
    return opened(update)
        .getMap<{ sheets: Record<string, { name?: string }> }>(OFFICE_FIELDS.sheet.shape)
        .get("workbook")!;
}

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

    it("brings a date in as a date rather than as the number behind one", async () => {
        // A workbook stores a date as days since 1900 and the format beside it
        // is what makes it readable. None of that format is carried, so what
        // arrives has to be the date itself.
        const out = await roundTrip("When.csv", utf8.encode("When\n2026-01-15\n"), "csv");
        expect(out.trim().split(/\r?\n/)).toEqual(["When", "2026-01-15"]);

        // The same date as a workbook stores one: the serial, with the format
        // beside it that is all there is to say it is a date at all.
        const sheet = { "!ref": "A1:A1", A1: { t: "n", v: 46037, z: "m/d/yy" } };
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet as XLSX.WorkSheet, "S");
        const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
        expect((await roundTrip("When.xlsx", bytes, "csv")).trim()).toBe("2026-01-15");
    });

    it("reads the cells a sheet holds rather than the range it declares", async () => {
        // What LibreOffice and several other generators write into a file with
        // two cells in it. Walking that range is a million rows allocated.
        const bytes = await sheetDeclaring(
            "A1:AMJ1048576",
            '<row r="1"><c r="A1" t="str"><v>hi</v></c></row>'
        );
        const imported = await importFile("Wide.xlsx", bytes);
        const doc = opened(imported.update);
        expect([...doc.getMap(OFFICE_FIELDS.sheet.cells).keys()]).toEqual(["Sheet1:0:0"]);
    });

    it("refuses a workbook with more in it than a spreadsheet anybody opens", async () => {
        const rows = `a\n`.repeat(100_002);
        await expect(importFile("Huge.csv", utf8.encode(rows))).rejects.toBeInstanceOf(
            OfficeImportError
        );
    });

    it("refuses a package by what it unpacks to rather than by what arrived", async () => {
        // A few kilobytes on the wire and a hundred megabytes once opened. The
        // refusal has to come out of the size the package declares: a check
        // that runs after the reader has built the thing runs after the memory
        // is already gone.
        const bytes = await zipBomb();
        expect(bytes.length).toBeLessThan(1024 * 1024);
        // By that sentence and not another: every reader here refuses an
        // unreadable file too, and a refusal that arrives after the hundred
        // megabytes were allocated is the bug rather than the fix.
        const unpacked = /unpacks to more than Polaris opens/;
        await expect(importFile("Bomb.xlsx", bytes)).rejects.toThrow(unpacked);
        await expect(importFile("Bomb.docx", bytes)).rejects.toThrow(unpacked);
    });

    it("keeps a sheet whose name is a key no plain object can hold", async () => {
        // Excel allows "__proto__" as a sheet name, and assigning it as a key
        // sets an object's prototype instead of giving it that key - so the
        // sheet disappears and the shape reaches every reader's browser as
        // something that writes onto Object.prototype.
        const book = {
            SheetNames: ["__proto__"],
            Sheets: Object.fromEntries([["__proto__", XLSX.utils.aoa_to_sheet([["hi"]])]])
        } as XLSX.WorkBook;
        const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));

        const imported = await importFile("Odd.xlsx", bytes);
        const shape = shapeOf(imported.update);
        const ids = Object.keys(shape.sheets);
        expect(ids).toHaveLength(1);
        expect(Object.getPrototypeOf(shape.sheets)).toBe(Object.prototype);
        expect(({} as { cellData?: unknown }).cellData).toBeUndefined();

        // And the cells went in under the same id the shape declares, which is
        // the whole of what makes the sheet open with anything in it.
        const keys = [...opened(imported.update).getMap(OFFICE_FIELDS.sheet.cells).keys()];
        expect(keys.map((key) => readSheetCellKey(key)?.sheetId)).toEqual([ids[0]]);
    });

    it("brings a formula in as a formula rather than as the number it last was", async () => {
        const sheet = {
            "!ref": "A1:A3",
            A1: { t: "n", v: 2 },
            A2: { t: "n", v: 3 },
            A3: { t: "n", v: 5, f: "SUM(A1:A2)" }
        };
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet as XLSX.WorkSheet, "S");
        const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));

        const imported = await importFile("Budget.xlsx", bytes);
        const cells = opened(imported.update).getMap<{ v?: unknown; f?: string }>(
            OFFICE_FIELDS.sheet.cells
        );
        expect(cells.get("S:2:0")).toEqual({ v: 5, f: "=SUM(A1:A2)" });
        // The value is still beside it, because that is what every exporter
        // reads and nothing here recalculates.
        expect((await roundTrip("Budget.xlsx", bytes, "csv")).trim().split(/\r?\n/)).toEqual([
            "2",
            "3",
            "5"
        ]);
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

    it("gives a heading the level the editor's own schema knows", async () => {
        // A number rather than the digit that was matched, and never deeper
        // than the schema goes: the attribute is handed straight to it, and a
        // level it does not know is drawn as an H1 - every heading the same
        // size, which is the document arriving broken rather than imported.
        const imported = await importFile(
            "Levels.md",
            utf8.encode("# One\n\n## Two\n\n#### Four\n")
        );
        const headings = opened(imported.update)
            .getXmlFragment(OFFICE_FIELDS.doc.body)
            .toArray()
            .filter((node): node is Y.XmlElement => node instanceof Y.XmlElement)
            .map((node) => node.getAttribute("level"));
        expect(headings).toEqual([1, 2, 3]);
    });

    it("keeps a numbered list numbered rather than turning it into bullets", async () => {
        const bytes = await wordDocument(
            `${numbered("2", "First")}${numbered("2", "Second")}${numbered("1", "Loose")}`
        );
        const imported = await importFile("Steps.docx", bytes);
        const lists = opened(imported.update)
            .getXmlFragment(OFFICE_FIELDS.doc.body)
            .toArray()
            .filter((node): node is Y.XmlElement => node instanceof Y.XmlElement)
            .map((node) => node.nodeName);
        expect(lists).toEqual(["orderedList", "bulletList"]);
    });

    it("keeps a numbered list numbered all the way back out of the exporter", async () => {
        const steps = "1. First\n2. Second\n3. Third\n";
        const markdownOut = await roundTrip("Steps.md", utf8.encode(steps), "md");
        expect(markdownOut).toContain("1. First");
        expect(markdownOut).toContain("2. Second");
        expect(markdownOut).toContain("3. Third");
        expect(markdownOut).not.toContain("- First");

        const htmlOut = await roundTrip("Steps.md", utf8.encode(steps), "html");
        expect(htmlOut).toContain("<ol>");
        expect(htmlOut).not.toContain("<ul>");
    });

    it("keeps it numbered through Word as well, which is where the markers live", async () => {
        // Out through the real OOXML engine and back in through the numbering
        // part: the only check that the order survives leaving Polaris.
        const imported = await importFile("Steps.md", utf8.encode("1. First\n2. Second\n"));
        const docx = await exportDocument("doc", "Steps", imported.update, "docx");
        const back = await importFile("Steps.docx", docx?.bytes ?? new Uint8Array());
        const out = await exportDocument("doc", "Steps", back.update, "md");
        const text = new TextDecoder().decode(out?.bytes);
        expect(text).toContain("1. First");
        expect(text).toContain("2. Second");
    });

    it("reads a wrapped file as the paragraphs it has, not one per line", async () => {
        // A soft line break inside a block is not a paragraph break - in
        // Markdown by the specification, and in a hard-wrapped text file by
        // what whoever wrapped it meant.
        const wrapped =
            "A paragraph that somebody\nwrapped at the width of\ntheir terminal.\n\nThe next one.\n";
        const out = await roundTrip("Readme.md", utf8.encode(wrapped), "md");
        const body = out.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("# "));
        expect(body).toEqual([
            "A paragraph that somebody wrapped at the width of their terminal.",
            "The next one."
        ]);
    });

    it("takes its name from the file, without the extension", async () => {
        const imported = await importFile("Notes from Tuesday.txt", utf8.encode("Hello"));
        expect(imported.title).toBe("Notes from Tuesday");
    });
});
