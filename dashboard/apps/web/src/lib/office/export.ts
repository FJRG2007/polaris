/**
 * A document, as a file somebody else's program can open.
 *
 * Reads what the editors store - a Yjs document - and answers with bytes. The
 * arranging and every piece of escaping is pure and lives in "@polaris/core";
 * this is the half that knows what each editor keeps and how to pack a zip.
 *
 * **The Office formats are written by hand.** A ".docx", an ".xlsx" and a
 * ".pptx" are each a zip of XML with a fixed set of parts, and writing the
 * minimum that every reader accepts is a few hundred lines - against two
 * dependencies of a few megabytes each, carrying features nothing here uses. The
 * parts below are the ones the format requires and no more, which is also why
 * they are readable: there is nothing in them that is not needed.
 *
 * What is deliberately NOT here:
 *
 * - **The drawing.** A diagram's SVG and PNG are produced in the browser by the
 *   canvas that already has the scene, because rendering one on a server means
 *   shipping a headless browser to redraw something a tab is already showing.
 * - **PDF.** Every format below opens in something that prints, and the browser's
 *   own print is a better PDF than a hand-rolled writer would ever produce - so
 *   the document offers Print rather than a PDF that would be worse than the
 *   thing it was made from.
 */

import * as Y from "yjs";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import * as deck from "./deck";
import * as core from "@polaris/core";
import { OFFICE_FIELDS, openDocument } from "./content";

/** A finished export, ready to be a response. */
export interface ExportedFile {
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
}

const utf8 = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* Reading what the editors keep                                               */
/* -------------------------------------------------------------------------- */

/**
 * A rich-text document, flattened to blocks.
 *
 * ProseMirror's tree is an XML fragment in Yjs, so this walks the fragment
 * rather than parsing anything: each top-level element is a block, and its
 * "nodeName" is the block's kind. Nested content - a list, a quote holding
 * paragraphs - is flattened into the item it belongs to, because every format
 * below is a list of blocks and none of them nests.
 */
function docBlocks(doc: Y.Doc): core.DocBlock[] {
    const fragment = doc.getXmlFragment(OFFICE_FIELDS.doc.body);
    const blocks: core.DocBlock[] = [];

    const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlHook, inherited: string): void => {
        if (node instanceof Y.XmlText) {
            const text = node.toString();
            if (text.trim()) blocks.push({ kind: inherited, text });
            return;
        }
        if (!(node instanceof Y.XmlElement)) return;

        const name = node.nodeName;
        // A container: its children are the blocks, and they carry its kind when
        // they have none of their own.
        if (name === "bulletList" || name === "orderedList" || name === "listItem") {
            for (const child of node.toArray()) walk(child, "li");
            return;
        }
        if (name === "blockquote") {
            for (const child of node.toArray()) walk(child, "quote");
            return;
        }
        const kind =
            name === "heading"
                ? `h${Math.min(6, Math.max(1, Number(node.getAttribute("level") ?? 1)))}`
                : name === "codeBlock"
                  ? "code"
                  : name === "paragraph"
                    ? inherited || "p"
                    : inherited || "p";
        const text = node.toString().replace(/<[^>]*>/g, "");
        if (text.trim()) blocks.push({ kind, text });
    };

    for (const node of fragment.toArray()) walk(node, "");
    return blocks;
}

/** A workbook, as a grid per sheet. The cells are stored sparse and keyed
 *  "sheet:row:column", so this fills the rectangle they describe. */
function sheetGrids(doc: Y.Doc): { name: string; rows: string[][] }[] {
    const cells = doc.getMap<{ v?: unknown }>(OFFICE_FIELDS.sheet.cells);
    const bySheet = new Map<string, Map<string, string>>();

    for (const [key, cell] of cells) {
        const at = readCellKey(key);
        if (!at) continue;
        const held = bySheet.get(at.sheetId) ?? new Map<string, string>();
        const value = cell?.v;
        held.set(`${at.row}:${at.column}`, value === undefined || value === null ? "" : String(value));
        bySheet.set(at.sheetId, held);
    }

    const grids: { name: string; rows: string[][] }[] = [];
    let index = 0;
    for (const [sheetId, held] of bySheet) {
        index += 1;
        let tallest = 0;
        let wide = 0;
        for (const key of held.keys()) {
            const [row, column] = key.split(":").map(Number);
            tallest = Math.max(tallest, (row ?? 0) + 1);
            wide = Math.max(wide, (column ?? 0) + 1);
        }
        const rows = Array.from({ length: tallest }, (_, row) =>
            Array.from({ length: wide }, (_, column) => held.get(`${row}:${column}`) ?? "")
        );
        grids.push({ name: sheetName(sheetId, index), rows });
    }
    return grids.length > 0 ? grids : [{ name: "Sheet1", rows: [] }];
}

/** A cell key, read back. The last two segments are the row and the column, so a
 *  sheet id with a colon in it survives. */
function readCellKey(key: string): { sheetId: string; row: number; column: number } | null {
    const parts = key.split(":");
    if (parts.length < 3) return null;
    const column = Number(parts.pop());
    const row = Number(parts.pop());
    if (!Number.isFinite(row) || !Number.isFinite(column)) return null;
    return { sheetId: parts.join(":"), row, column };
}

/**
 * What a sheet is called inside a workbook.
 *
 * Excel refuses a name longer than 31 characters or holding any of ":\/?*[]",
 * and refuses the whole file rather than the name - so this is not cosmetic.
 * Generated ids are unreadable anyway, so they become "Sheet 1".
 */
function sheetName(sheetId: string, index: number): string {
    const cleaned = sheetId.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
    return /^[0-9a-f-]{8,}$/i.test(sheetId) || !cleaned ? `Sheet ${index}` : cleaned;
}

/** A comparison, as the table its screen draws: one row per criterion, one
 *  column per subject. */
function comparisonRows(doc: Y.Doc): string[][] {
    const subjects = doc.getArray<core.Subject>(OFFICE_FIELDS.comparison.subjects).toArray();
    const criteria = doc.getArray<core.Criterion>(OFFICE_FIELDS.comparison.criteria).toArray();
    const cells = doc.getMap<core.Cell>(OFFICE_FIELDS.comparison.cells);

    const head = ["", ...subjects.map((one) => one.name ?? "")];
    const body = criteria.map((criterion) => [
        criterion.name ?? "",
        ...subjects.map((subject) => {
            const cell = cells.get(core.cellKey(subject.id, criterion.id));
            const value = cell?.value;
            return value === undefined || value === null ? "" : String(value);
        })
    ]);
    return [head, ...body];
}

/** A deck, as its slides' words. */
function deckSlides(doc: Y.Doc): { notes: string; lines: string[] }[] {
    const slides = doc.getArray<deck.Slide>(OFFICE_FIELDS.slides.slides).toArray();
    const boxes = new Map<string, deck.Box>(doc.getMap<deck.Box>(OFFICE_FIELDS.slides.boxes));
    return slides.map((slide) => ({
        notes: slide.notes ?? "",
        lines: deck
            .boxesOn(slide.id, boxes)
            .map((box) => box.text.trim())
            .filter(Boolean)
    }));
}

/* -------------------------------------------------------------------------- */
/* Office formats                                                              */
/* -------------------------------------------------------------------------- */

/** XML text, escaped. The same five as HTML: an Office part is XML, and a
 *  document whose text holds "<" is a file every reader refuses to open. */
function xml(text: string): string {
    return core.escapeHtml(text).replace(/&#39;/g, "&apos;");
}

/** The two parts every Office format begins with, and which differ only in what
 *  they point at. Written once because getting either wrong fails the same way:
 *  the file opens as "corrupt" with nothing to say which part was wrong. */
function shell(zip: JSZip, main: string, type: string, extension: string): void {
    zip.file(
        "[Content_Types].xml",
        [
            "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
            "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>",
            "<Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/>",
            "<Default Extension='xml' ContentType='application/xml'/>",
            `<Override PartName="/${main}" ContentType="${type}"/>`,
            extension,
            "</Types>"
        ].join("")
    );
    zip.file(
        "_rels/.rels",
        [
            "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
            "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>",
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/>`,
            "</Relationships>"
        ].join("")
    );
}

/** A document, as Word. */
async function toDocx(title: string, blocks: readonly core.DocBlock[]): Promise<Uint8Array> {
    const zip = new JSZip();
    shell(
        zip,
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ""
    );

    const paragraph = (style: string, text: string): string => {
        const styled = style ? `<w:pPr><w:pStyle w:val='${style}'/></w:pPr>` : "";
        // `xml:space='preserve'` is not optional: without it Word eats leading
        // and trailing spaces, which is every indented line in a document.
        return `<w:p>${styled}<w:r><w:t xml:space='preserve'>${xml(text)}</w:t></w:r></w:p>`;
    };

    const styleFor = (kind: string): string => {
        if (/^h[1-6]$/.test(kind)) return `Heading${kind.slice(1)}`;
        if (kind === "li") return "ListParagraph";
        if (kind === "quote") return "Quote";
        return "";
    };

    const body = [
        paragraph("Title", title),
        ...blocks.map((block) => paragraph(styleFor(block.kind), block.text))
    ].join("");

    zip.file(
        "word/document.xml",
        [
            "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
            "<w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'>",
            `<w:body>${body}<w:sectPr/></w:body></w:document>`
        ].join("")
    );
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** A deck, as PowerPoint.
 *
 *  One text box per slide holding that slide's words, which is the honest
 *  version of this: the positions are fractions of the slide and translating
 *  them into EMUs faithfully is a layout engine. What comes out is every word,
 *  in order, on the right slide - which is what somebody exporting a deck to
 *  send it actually needs. */
async function toPptx(slides: readonly { notes: string; lines: string[] }[]): Promise<Uint8Array> {
    const zip = new JSZip();
    const kept = slides.length > 0 ? slides : [{ notes: "", lines: [] }];
    const overrides = kept
        .map(
            (_, index) =>
                `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        )
        .join("");
    shell(
        zip,
        "ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        overrides
    );

    const slideIds = kept
        .map((_, index) => `<p:sldId id='${256 + index}' r:id='rId${index + 1}'/>`)
        .join("");
    zip.file(
        "ppt/presentation.xml",
        [
            "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
            "<p:presentation xmlns:a='http://schemas.openxmlformats.org/drawingml/2006/main' ",
            "xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' ",
            "xmlns:p='http://schemas.openxmlformats.org/presentationml/2006/main'>",
            `<p:sldIdLst>${slideIds}</p:sldIdLst>`,
            // Sixteen by nine, in EMUs, which is the unit the format counts in.
            "<p:sldSz cx='12192000' cy='6858000'/><p:notesSz cx='6858000' cy='9144000'/>",
            "</p:presentation>"
        ].join("")
    );
    const slideLinks = kept
        .map(
            (_, index) =>
                `<Relationship Id='rId${index + 1}' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide' Target='slides/slide${index + 1}.xml'/>`
        )
        .join("");
    zip.file(
        "ppt/_rels/presentation.xml.rels",
        [
            "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
            "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>",
            slideLinks,
            "</Relationships>"
        ].join("")
    );

    kept.forEach((slide, index) => {
        const lines = slide.lines.length > 0 ? slide.lines : [""];
        const paragraphs = lines
            .map((line) => `<a:p><a:r><a:t>${xml(line)}</a:t></a:r></a:p>`)
            .join("");
        zip.file(
            `ppt/slides/slide${index + 1}.xml`,
            [
                "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
                "<p:sld xmlns:a='http://schemas.openxmlformats.org/drawingml/2006/main' ",
                "xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' ",
                "xmlns:p='http://schemas.openxmlformats.org/presentationml/2006/main'>",
                "<p:cSld><p:spTree>",
                "<p:nvGrpSpPr><p:cNvPr id='1' name=''/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>",
                "<p:grpSpPr/>",
                "<p:sp><p:nvSpPr><p:cNvPr id='2' name='Text'/><p:cNvSpPr txBox='1'/><p:nvPr/></p:nvSpPr>",
                "<p:spPr><a:xfrm><a:off x='838200' y='838200'/><a:ext cx='10515600' cy='5181600'/></a:xfrm>",
                "<a:prstGeom prst='rect'><a:avLst/></a:prstGeom></p:spPr>",
                `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`,
                "</p:spTree></p:cSld><p:clrMapOvr/></p:sld>"
            ].join("")
        );
    });

    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** A grid, as Excel. Through the library the Drive viewer already carries, so
 *  there is one spreadsheet writer here rather than two. */
function toXlsx(grids: readonly { name: string; rows: string[][] }[]): Uint8Array {
    const book = XLSX.utils.book_new();
    for (const grid of grids) {
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(grid.rows), grid.name);
    }
    return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

/* -------------------------------------------------------------------------- */
/* The one entrance                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Export one document.
 *
 * Refuses a format the kind does not offer, rather than producing an empty file
 * of it. The menu is built from the same table, so this can only be reached by
 * somebody editing the address - but a menu is not a guard.
 */
export async function exportDocument(
    kind: core.OfficeKind,
    title: string,
    stored: Uint8Array | null,
    format: string
): Promise<ExportedFile | null> {
    if (!core.canExportAs(kind, format)) return null;
    const doc = openDocument(stored);
    const named = (extension: string): string => core.exportFilename(title, extension);
    const type = core.OFFICE_EXPORT_TYPES[format] ?? "application/octet-stream";
    const text = (body: string, extension: string): ExportedFile => ({
        bytes: utf8.encode(body),
        filename: named(extension),
        contentType: type
    });

    if (kind === "doc") {
        const blocks = docBlocks(doc);
        if (format === "md") return text(core.toMarkdown(title, blocks), "md");
        if (format === "html") return text(core.toHtml(title, blocks), "html");
        if (format === "docx") {
            return { bytes: await toDocx(title, blocks), filename: named("docx"), contentType: type };
        }
        return null;
    }

    if (kind === "sheet") {
        const grids = sheetGrids(doc);
        if (format === "csv") return text(core.toCsv(grids[0]?.rows ?? []), "csv");
        if (format === "xlsx") {
            return { bytes: toXlsx(grids), filename: named("xlsx"), contentType: type };
        }
        return null;
    }

    if (kind === "comparison") {
        const rows = comparisonRows(doc);
        if (format === "csv") return text(core.toCsv(rows), "csv");
        if (format === "md") return text(core.tableToMarkdown(rows), "md");
        if (format === "xlsx") {
            return {
                bytes: toXlsx([{ name: "Comparison", rows }]),
                filename: named("xlsx"),
                contentType: type
            };
        }
        return null;
    }

    if (kind === "slides") {
        const slides = deckSlides(doc);
        if (format === "pptx") {
            return { bytes: await toPptx(slides), filename: named("pptx"), contentType: type };
        }
        return null;
    }

    // A drawing leaves through the canvas that is already showing it - see the
    // note at the top of this file.
    return null;
}
