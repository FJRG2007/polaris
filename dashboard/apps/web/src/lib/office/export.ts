/**
 * A document, as a file somebody else's program can open.
 *
 * Reads what the editors store - a Yjs document - and answers with bytes. The
 * arranging and every piece of escaping is pure and lives in "@polaris/core";
 * this is the half that knows what each editor keeps and how to pack a zip.
 *
 * **Word and PowerPoint go through the real engines.** `@polaris/docx` and
 * `@polaris/pptx` are ported from GenOffice (Apache-2.0, see NOTICE) and are the
 * OOXML packages proper - styles, numbering, sections, layouts, the parts a
 * reader other than Word will look for. This file used to write those two by
 * hand: a zip with the minimum set of parts, which opened, and which was a
 * document with no styles in it.
 *
 * The spreadsheet still goes through the library the Drive viewer already
 * carries, so there is one spreadsheet writer in this repository rather than
 * two.
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
import * as XLSX from "xlsx";
import * as deck from "./deck";
import * as core from "@polaris/core";
import { writeDocx, writePptx } from "./ooxml";
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
        // they have none of their own. Which list it is has to travel with them:
        // an item that reaches a writer as "li" is written with a bullet, and a
        // procedure whose steps arrive as bullets stops saying they are in an
        // order.
        if (name === "bulletList" || name === "orderedList") {
            for (const child of node.toArray()) walk(child, name === "bulletList" ? "li" : "oli");
            return;
        }
        if (name === "listItem") {
            for (const child of node.toArray()) walk(child, inherited || "li");
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
            return { bytes: await writeDocx(title, blocks), filename: named("docx"), contentType: type };
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
            return { bytes: await writePptx(slides), filename: named("pptx"), contentType: type };
        }
        return null;
    }

    // A drawing leaves through the canvas that is already showing it - see the
    // note at the top of this file.
    return null;
}
