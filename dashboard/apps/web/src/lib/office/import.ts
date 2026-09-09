/**
 * A file somebody already has, opened as a document here.
 *
 * The other direction of `export.ts`, and it exists because the screen without
 * it is one people leave: an app that can hand you a spreadsheet and cannot take
 * one is a place to start things rather than a place to keep them.
 *
 * **What the editors store is a Yjs update, not a file.** So an import is not a
 * copy - it is a read of somebody else's format into the shape the editor binds
 * to, and the shape is the one `export.ts` writes back out. Both halves are
 * pinned by the same field names in `content.ts` for that reason: a document
 * imported and then exported has to come back recognisable.
 *
 * Deliberately not everything:
 *
 * - **Formatting is not carried.** Bold, colours, column widths, themes. What is
 *   read is the structure - headings, lists, quotes, code, cells and their
 *   values - because that is what somebody wants to keep working on, and a
 *   half-carried style is worse than none: it looks like the document is broken
 *   rather than like it was imported.
 * - **PDF is not here.** It is not a document format, it is a picture of one,
 *   and turning it back into text is its own machine - `@polaris/pdf2docx`
 *   exists for exactly that and is not wired to anything yet. A file this cannot
 *   read is refused by name rather than opened empty.
 *
 * The readers themselves are the ones already in this repository: SheetJS for
 * workbooks, which is what writes them on the way out, and JSZip for the OOXML
 * package. Nothing new was installed to read a file this app can already write.
 */

import * as Y from "yjs";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import * as core from "@polaris/core";
import { OFFICE_FIELDS } from "./content";

/** What came out of a file, ready to become a document. */
export interface ImportedDocument {
    readonly kind: core.OfficeKind;
    /** The file's own name, without its extension. */
    readonly title: string;
    /** The whole document, as one Yjs update. */
    readonly update: Uint8Array;
}

/** Raised when the file is not one of the ones below. Said by name, because
 *  "that could not be imported" leaves somebody trying the same file twice. */
export class OfficeImportError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "OfficeImportError";
    }
}

/** What each extension opens as. The list IS the answer to "what can I import",
 *  so the picker and the refusal both read it rather than each holding their
 *  own idea. */
export const IMPORTABLE: Readonly<Record<string, core.OfficeKind>> = {
    xlsx: "sheet",
    xlsm: "sheet",
    xls: "sheet",
    ods: "sheet",
    csv: "sheet",
    tsv: "sheet",
    docx: "doc",
    txt: "doc",
    md: "doc",
    markdown: "doc"
};

/** The extensions, for a file input's `accept`. */
export const IMPORTABLE_ACCEPT = Object.keys(IMPORTABLE)
    .map((one) => `.${one}`)
    .join(",");

/** What kind of document a file becomes, or null when it becomes none. */
export function importableKind(filename: string): core.OfficeKind | null {
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    return IMPORTABLE[extension] ?? null;
}

/** The name to give the document: the file's, without the extension. */
function titleOf(filename: string): string {
    const base = filename.split(/[\\/]/).pop() ?? filename;
    const cut = base.lastIndexOf(".");
    return (cut > 0 ? base.slice(0, cut) : base).trim() || base;
}

/**
 * Read a file into a document.
 *
 * Throws `OfficeImportError` for anything it cannot read, including a file whose
 * extension says one thing and whose bytes say another - a `.xlsx` that is not a
 * zip is a rename, and opening it as an empty spreadsheet would lose whatever it
 * actually was.
 */
export async function importFile(filename: string, bytes: Uint8Array): Promise<ImportedDocument> {
    const kind = importableKind(filename);
    if (!kind) {
        throw new OfficeImportError(
            `Polaris cannot open ${filename.split(".").pop()?.toLowerCase() || "that"} files yet. Spreadsheets, Word documents, CSV and plain text all work.`
        );
    }
    if (bytes.length === 0) throw new OfficeImportError("That file is empty.");

    const title = titleOf(filename);
    if (kind === "sheet") return { kind, title, update: sheetUpdate(title, bytes, filename) };
    return { kind, title, update: await docUpdate(filename, bytes) };
}

/* -------------------------------------------------------------------------- */
/* Spreadsheets                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A workbook, as the editor keeps one.
 *
 * Two halves, and both are needed: the cells go into their own map, one key per
 * cell, because that is what lets two people type in two cells at once - and the
 * SHAPE goes beside them, because the editor puts a cell back only into a sheet
 * the shape declares. A workbook imported with cells and no shape opens empty,
 * which is the whole of what makes this function longer than one line.
 *
 * The sheet's own name is its id, which is what `export.ts` reads back when it
 * writes the file out again - so a round trip keeps the tabs somebody named.
 */
function sheetUpdate(title: string, bytes: Uint8Array, filename: string): Uint8Array {
    // A modern workbook is a zip, and the reader below is lenient enough to make
    // a one-cell sheet out of anything at all - so a `.xlsx` that is not a zip
    // would open as a spreadsheet containing the first line of whatever it
    // actually was. That is a rename, and the honest answer is to refuse it.
    const zipped = /\.(?:xlsx|xlsm|ods)$/i.test(filename);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (zipped && !isZip) {
        throw new OfficeImportError(`${filename} is not a spreadsheet Polaris can read.`);
    }

    let book: XLSX.WorkBook;
    try {
        book = XLSX.read(bytes, { type: "array", cellDates: false });
    } catch {
        throw new OfficeImportError(`${filename} is not a spreadsheet Polaris can read.`);
    }
    if (book.SheetNames.length === 0) throw new OfficeImportError("That workbook has no sheets.");

    const doc = new Y.Doc();
    const cells = doc.getMap<{ v: unknown }>(OFFICE_FIELDS.sheet.cells);
    const sheets: Record<string, unknown> = {};

    for (const name of book.SheetNames) {
        const sheet = book.Sheets[name];
        if (!sheet) continue;
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
            header: 1,
            raw: true,
            blankrows: true,
            defval: null
        });

        let widest = 0;
        rows.forEach((row, index) => {
            if (!Array.isArray(row)) return;
            widest = Math.max(widest, row.length);
            row.forEach((value, column) => {
                if (value === null || value === undefined || value === "") return;
                cells.set(`${name}:${index}:${column}`, { v: value });
            });
        });

        sheets[name] = {
            id: name,
            name,
            // The grid the engine draws, not the grid that has something in it:
            // a sheet has to have room under its last row to type in.
            rowCount: Math.max(rows.length + 20, 100),
            columnCount: Math.max(widest + 5, 26),
            cellData: {}
        };
    }

    doc.getMap<unknown>(OFFICE_FIELDS.sheet.shape).set("workbook", {
        id: `import-${Date.now()}`,
        name: title,
        sheetOrder: book.SheetNames.filter((name) => name in sheets),
        sheets
    });
    return Y.encodeStateAsUpdate(doc);
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

async function docUpdate(filename: string, bytes: Uint8Array): Promise<Uint8Array> {
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    const blocks =
        extension === "docx"
            ? await docxBlocks(bytes, filename)
            : textBlocks(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    if (blocks.length === 0) throw new OfficeImportError(`${filename} has no text in it.`);

    const doc = new Y.Doc();
    fillFragment(doc.getXmlFragment(OFFICE_FIELDS.doc.body), blocks);
    return Y.encodeStateAsUpdate(doc);
}

/**
 * A Word document's paragraphs.
 *
 * Read from `word/document.xml` rather than through a full OOXML model: what is
 * wanted here is the structure and the words, and the styles that carry it are
 * the paragraph's own `w:pStyle` plus whether it sits in a numbering. The parts
 * that make a package a package - themes, numbering definitions, relationships -
 * decide how it LOOKS, and none of that survives into an editor that has its own
 * styles anyway.
 */
async function docxBlocks(bytes: Uint8Array, filename: string): Promise<core.DocBlock[]> {
    let xml: string;
    try {
        const zip = await JSZip.loadAsync(bytes);
        xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    } catch {
        throw new OfficeImportError(`${filename} is not a Word document Polaris can read.`);
    }
    if (!xml) throw new OfficeImportError(`${filename} has no document part in it.`);

    const blocks: core.DocBlock[] = [];
    for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
        const paragraph = match[1] ?? "";
        const text = paragraphText(paragraph);
        if (!text.trim()) continue;
        blocks.push({ kind: paragraphKind(paragraph), text });
    }
    return blocks;
}

/** The words in one paragraph: every run's text, with the tabs and the breaks
 *  the run itself carries. */
function paragraphText(paragraph: string): string {
    let out = "";
    for (const piece of paragraph.matchAll(/<w:(t|tab|br)\b([^>]*)(?:\/>|>([\s\S]*?)<\/w:\1>)/g)) {
        const tag = piece[1];
        if (tag === "tab") {
            out += "\t";
            continue;
        }
        if (tag === "br") {
            out += " ";
            continue;
        }
        out += decodeXml(piece[3] ?? "");
    }
    return out;
}

/** What a paragraph is, from the style it names and the numbering it sits in. */
function paragraphKind(paragraph: string): string {
    const numbered = /<w:numPr\b/.test(paragraph);
    const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(paragraph)?.[1] ?? "";
    const flat = style.toLowerCase().replace(/[^a-z0-9]/g, "");

    const heading = /^heading([1-6])$/.exec(flat) ?? /^(?:titulo|titre|uberschrift)([1-6])$/.exec(flat);
    if (heading) return `h${heading[1]}`;
    if (flat === "title") return "h1";
    if (flat === "subtitle") return "h2";
    if (flat.includes("quote")) return "quote";
    if (flat.includes("code") || flat === "htmlpreformatted") return "code";
    // A list is a paragraph with numbering on it. The style is only a hint -
    // `ListParagraph` is applied to plenty of paragraphs that are not lists, and
    // a real list item always carries `w:numPr`.
    if (numbered) return "li";
    return "p";
}

/** The five entities an OOXML part can carry. */
function decodeXml(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * Plain text and Markdown, as blocks.
 *
 * The same reader for both, because the difference is only whether the marks
 * mean anything - and a plain-text file that happens to start a line with `-` is
 * a list to every reader who looks at it, which is the answer somebody wants.
 */
function textBlocks(text: string): core.DocBlock[] {
    const blocks: core.DocBlock[] = [];
    let fenced = false;
    let code: string[] = [];

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "");
        if (/^\s*```/.test(line)) {
            if (fenced) {
                blocks.push({ kind: "code", text: code.join("\n") });
                code = [];
            }
            fenced = !fenced;
            continue;
        }
        if (fenced) {
            code.push(raw);
            continue;
        }
        if (!line.trim()) continue;

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            blocks.push({ kind: `h${heading[1]?.length ?? 1}`, text: heading[2] ?? "" });
            continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            blocks.push({ kind: "li", text: bullet[1] ?? "" });
            continue;
        }
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (numbered) {
            blocks.push({ kind: "oli", text: numbered[1] ?? "" });
            continue;
        }
        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            blocks.push({ kind: "quote", text: quote[1] ?? "" });
            continue;
        }
        blocks.push({ kind: "p", text: line.trim() });
    }
    if (fenced && code.length > 0) blocks.push({ kind: "code", text: code.join("\n") });
    return blocks;
}

/**
 * The blocks, as the tree the editor binds to.
 *
 * ProseMirror's document is an XML fragment in Yjs, so this builds the nodes the
 * editor's own schema names - and the names have to be exactly the ones
 * `export.ts` reads back, or a document imported here exports as nothing.
 *
 * Consecutive list items are gathered into one list, because that is what a list
 * is: five `listItem` nodes side by side at the top level are not a list, they
 * are five items the editor will not let anybody indent.
 */
function fillFragment(fragment: Y.XmlFragment, blocks: readonly core.DocBlock[]): void {
    let index = 0;
    while (index < blocks.length) {
        const block = blocks[index];
        if (!block) {
            index += 1;
            continue;
        }

        if (block.kind === "li" || block.kind === "oli") {
            const kind = block.kind;
            const items: core.DocBlock[] = [];
            while (index < blocks.length && blocks[index]?.kind === kind) {
                items.push(blocks[index] as core.DocBlock);
                index += 1;
            }
            const list = new Y.XmlElement(kind === "li" ? "bulletList" : "orderedList");
            for (const item of items) {
                const listItem = new Y.XmlElement("listItem");
                listItem.insert(0, [paragraphNode(item.text)]);
                list.insert(list.length, [listItem]);
            }
            fragment.insert(fragment.length, [list]);
            continue;
        }

        fragment.insert(fragment.length, [nodeFor(block)]);
        index += 1;
    }
}

function nodeFor(block: core.DocBlock): Y.XmlElement {
    const heading = /^h([1-6])$/.exec(block.kind);
    if (heading) {
        const node = new Y.XmlElement("heading");
        node.setAttribute("level", heading[1] ?? "1");
        node.insert(0, [textNode(block.text)]);
        return node;
    }
    if (block.kind === "quote") {
        const node = new Y.XmlElement("blockquote");
        node.insert(0, [paragraphNode(block.text)]);
        return node;
    }
    if (block.kind === "code") {
        const node = new Y.XmlElement("codeBlock");
        node.insert(0, [textNode(block.text)]);
        return node;
    }
    return paragraphNode(block.text);
}

function paragraphNode(text: string): Y.XmlElement {
    const node = new Y.XmlElement("paragraph");
    node.insert(0, [textNode(text)]);
    return node;
}

function textNode(text: string): Y.XmlText {
    const node = new Y.XmlText();
    node.insert(0, text);
    return node;
}
