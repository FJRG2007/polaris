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
import { sheetCellKey } from "./sheet";
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

/**
 * How much of a workbook is a document somebody edits.
 *
 * Every cell becomes a key in one Yjs map, that map becomes one column of one
 * row, and that row is handed to a browser whole - so the ceiling is not about
 * how long the read takes. Past it the thing being made is not a spreadsheet
 * anybody opens, and it is refused by name rather than opened as a page that
 * never finishes loading.
 */
const MAX_CELLS = 200_000;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 1_024;

/**
 * How much a packaged file is allowed to become once it is unpacked.
 *
 * The ceiling on the way in is on the bytes that ARRIVED, and the whole point
 * of a zip is that those are the small ones: a sheet of cells deflates about
 * twentyfold, so a file well inside the upload limit still carries a workbook
 * with more in it than this machine has the memory to build. A cap checked
 * after the reader has already built it is not a cap - the process is gone
 * before it runs.
 *
 * So the size is read from the package's own directory, which says what each
 * entry becomes without inflating any of it, and a package past this is refused
 * in a sentence.
 *
 * **It is the archive's own declaration, and an archive can lie.** A zip built
 * to understate what it becomes is only caught once the bytes are inflated and
 * the count comes out wrong, which is after the allocation this exists to stop.
 * The ceiling bounds an ordinary oversized file, which is the one somebody
 * actually uploads; it is not a defence against a package written to defeat it.
 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4_096;

/** The levels the editor's own schema knows. A heading deeper than this is not
 *  a heading it can draw: it falls back to the first level, so a document of
 *  h4s would open as a document of h1s. */
const MAX_HEADING_LEVEL = 3;

/** What kind of document a file becomes, or null when it becomes none. The
 *  table itself is in core, because the picker on the screen filters by the
 *  same list. */
export function importableKind(filename: string): core.OfficeKind | null {
    return core.officeImportableKind(filename);
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
    if (kind === "sheet") return { kind, title, update: await sheetUpdate(title, bytes, filename) };
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
async function sheetUpdate(
    title: string,
    bytes: Uint8Array,
    filename: string
): Promise<Uint8Array> {
    // A modern workbook is a zip, and the reader below is lenient enough to make
    // a one-cell sheet out of anything at all - so a `.xlsx` that is not a zip
    // would open as a spreadsheet containing the first line of whatever it
    // actually was. That is a rename, and the honest answer is to refuse it.
    const zipped = /\.(?:xlsx|xlsm|ods)$/i.test(filename);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (zipped && !isZip) {
        throw new OfficeImportError(`${filename} is not a spreadsheet Polaris can read.`);
    }
    // Before the reader is handed the bytes, not after: what it builds out of
    // them is what there would be no memory left to refuse.
    if (isZip) await guardPackage(bytes, filename);

    let book: XLSX.WorkBook;
    try {
        // Dates come back as dates rather than as the number of days a workbook
        // stores one as. The format that would make 46037 read as a date is not
        // carried into the grid, so a cell that arrives as the number arrives
        // as one nothing downstream can turn back.
        book = XLSX.read(bytes, { type: "array", cellDates: true });
    } catch {
        throw new OfficeImportError(`${filename} is not a spreadsheet Polaris can read.`);
    }
    if (book.SheetNames.length === 0) throw new OfficeImportError("That workbook has no sheets.");

    const doc = new Y.Doc();
    const cells = doc.getMap<SheetCellValue>(OFFICE_FIELDS.sheet.cells);
    const sheets = new Map<string, unknown>();
    let written = 0;

    for (const name of book.SheetNames) {
        const sheet = book.Sheets[name];
        if (!sheet) continue;
        const id = sheetId(name, sheets);

        // The cells the sheet actually carries, which are its own keys - never
        // the range it declares. `!ref` is written as the whole grid,
        // `A1:AMJ1048576`, by more than one generator, and walking that is a
        // million rows allocated for a file with four cells in it.
        let tallest = 0;
        let widest = 0;
        for (const address of Object.keys(sheet)) {
            if (!CELL_ADDRESS.test(address)) continue;
            const held = cellContent(sheet[address] as XLSX.CellObject | undefined);
            if (!held) continue;
            const at = XLSX.utils.decode_cell(address);
            if (at.r >= MAX_ROWS || at.c >= MAX_COLUMNS) throw tooMuch(filename);
            written += 1;
            if (written > MAX_CELLS) throw tooMuch(filename);
            cells.set(sheetCellKey(id, at.r, at.c), held);
            tallest = Math.max(tallest, at.r + 1);
            widest = Math.max(widest, at.c + 1);
        }

        sheets.set(id, {
            id,
            name,
            // The grid the engine draws, not the grid that has something in it:
            // a sheet has to have room under its last row to type in.
            rowCount: Math.max(tallest + 20, 100),
            columnCount: Math.max(widest + 5, 26),
            cellData: {}
        });
    }

    doc.getMap<unknown>(OFFICE_FIELDS.sheet.shape).set("workbook", {
        id: `import-${Date.now()}`,
        name: title,
        sheetOrder: [...sheets.keys()],
        // Built as entries rather than by assignment, because assigning a key
        // is not the same thing as having one: `sheets["__proto__"] = x` sets
        // the object's prototype and leaves it with no such key at all.
        sheets: Object.fromEntries(sheets)
    });
    return Y.encodeStateAsUpdate(doc);
}

/**
 * The id a sheet is stored under: its own name, so a round trip keeps the tab
 * somebody named - except for the one name that cannot be a key.
 *
 * `__proto__` is an accessor on every plain object, so a sheet stored under it
 * is a sheet that vanishes on the way in and, on the way back out, a workbook
 * whose shape writes onto `Object.prototype` in the browser of everybody who
 * opens the document. Excel allows the name; this does not, and says so by
 * numbering it instead of dropping it.
 */
function sheetId(name: string, taken: ReadonlyMap<string, unknown>): string {
    const safe = name === "__proto__" || !name ? `Sheet ${taken.size + 1}` : name;
    if (!taken.has(safe)) return safe;
    let at = taken.size + 1;
    while (taken.has(`${safe} (${at})`)) at += 1;
    return `${safe} (${at})`;
}

/** A cell's own key, as a workbook writes one. Everything else in the object is
 *  the sheet's metadata, which is named with a leading `!`. */
const CELL_ADDRESS = /^[A-Z]+[1-9][0-9]*$/;

/**
 * A package, bounded by what it says it becomes rather than by what arrived.
 *
 * Read from the entries JSZip has already listed, which is the package's own
 * directory - no entry is inflated to ask it. An entry that does not say what it
 * becomes counts as the whole ceiling, because an unknown size is not a small
 * one.
 */
function boundPackage(zip: JSZip, filename: string): void {
    let total = 0;
    let entries = 0;
    for (const entry of Object.values(zip.files)) {
        // A folder is a name and nothing else - there is nothing in one to
        // inflate, and it carries no size to read.
        if (entry.dir) continue;
        entries += 1;
        total += inflatedSize(entry);
        if (entries > MAX_ZIP_ENTRIES) {
            throw tooBig(filename, `more than ${MAX_ZIP_ENTRIES.toLocaleString("en-US")} parts`);
        }
        if (total > MAX_INFLATED_BYTES) {
            throw tooBig(filename, `past ${MAX_INFLATED_BYTES / (1024 * 1024)} MB of content`);
        }
    }
}

/** The same bound, for a reader that is handed the bytes rather than the
 *  package. Bytes that are not a package at all are left to the reader that
 *  follows, which is the one that can say what they were. */
async function guardPackage(bytes: Uint8Array, filename: string): Promise<void> {
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(bytes);
    } catch {
        return;
    }
    boundPackage(zip, filename);
}

/** What one entry says it becomes, from the size JSZip kept beside the
 *  compressed bytes when it read the package's directory. */
function inflatedSize(entry: JSZip.JSZipObject): number {
    const held = (entry as { _data?: { uncompressedSize?: unknown } })._data;
    const size = held?.uncompressedSize;
    return typeof size === "number" && size >= 0 ? size : MAX_INFLATED_BYTES + 1;
}

/** The refusal for a file that unpacks to more than there is room for, said in
 *  the terms it was refused on rather than in the size it arrived at - the whole
 *  point is that the one somebody can see is the small one. */
function tooBig(filename: string, why: string): OfficeImportError {
    return new OfficeImportError(`${filename} unpacks to more than Polaris opens: ${why}.`);
}

/** The refusal for a workbook past what Polaris opens, said by name so nobody
 *  tries the same file twice. */
function tooMuch(filename: string): OfficeImportError {
    const size = (count: number): string => count.toLocaleString("en-US");
    return new OfficeImportError(
        `${filename} reaches further than Polaris opens as a spreadsheet: past ${size(MAX_ROWS)} rows, ${size(MAX_COLUMNS)} columns or ${size(MAX_CELLS)} cells.`
    );
}

/** What the editor keeps for one cell: its value, and the formula that produced
 *  it when there was one. The engine reads both, so a total that was a sum
 *  arrives as a sum rather than as the number it happened to be that day. */
interface SheetCellValue {
    readonly v: string | number | boolean | null;
    readonly f?: string;
}

/**
 * One cell, as the editor keeps one - or nothing, for a cell with nothing in it.
 *
 * A formula is kept beside the value rather than instead of it: the value is
 * what the workbook last computed and what every exporter reads, and the formula
 * is what makes the cell follow the ones above it once somebody edits them. A
 * cell that is only a formula, with no result cached beside it, is still a cell.
 */
function cellContent(cell: XLSX.CellObject | undefined): SheetCellValue | null {
    const value = cellValue(cell);
    // SheetJS keeps the formula without its leading "=", and the engine wants
    // one - the same expression, written the way a spreadsheet writes it.
    const formula = typeof cell?.f === "string" && cell.f.trim() ? `=${cell.f}` : "";
    if (value === null && !formula) return null;
    return formula ? { v: value, f: formula } : { v: value };
}

/**
 * What one cell holds, as a value a Yjs map can carry.
 *
 * A date is why this is not `cell.v`: a `Date` is not something Yjs encodes, and
 * the number behind one is unreadable without the format that is not carried
 * here. So a date becomes the text of the date, written the one way that is the
 * same in every country.
 */
function cellValue(cell: XLSX.CellObject | undefined): string | number | boolean | null {
    if (!cell || cell.t === "z") return null;
    if (cell.t === "e") return cell.w ?? null;
    const value = cell.v;
    if (value === undefined || value === null || value === "") return null;
    if (value instanceof Date) return readableDate(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    return String(value);
}

/**
 * A date, as text that sorts and means the same thing in every country.
 *
 * Whether the midnight behind a date was put in this machine's zone or in UTC is
 * not something the cell says - a workbook's serial is read as the one and a
 * text file's `2026-01-15` as the other - and reading it the wrong way moves the
 * date a day. So the reading that lands on midnight is the one the file meant. A
 * cell that carries a real time of day lands on neither, and is read here the
 * way the machine reading it would show it.
 */
function readableDate(value: Date): string {
    const pad = (part: number): string => String(part).padStart(2, "0");
    if (value.getUTCHours() === 0 && value.getUTCMinutes() === 0) {
        return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    }
    const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    const clock = value.getHours() * 60 + value.getMinutes();
    return clock === 0 ? day : `${day} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
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
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(bytes);
    } catch {
        throw new OfficeImportError(`${filename} is not a Word document Polaris can read.`);
    }
    // Before either part is inflated. A document part is one deflate stream and
    // reading it is one string as long as it turns out to be: a package inside
    // the upload limit can carry one no machine here can hold, and the refusal
    // has to come out before the allocation rather than after it.
    boundPackage(zip, filename);

    let xml: string;
    let numbering: string;
    try {
        xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
        numbering = (await zip.file("word/numbering.xml")?.async("string")) ?? "";
    } catch {
        throw new OfficeImportError(`${filename} is not a Word document Polaris can read.`);
    }
    if (!xml) throw new OfficeImportError(`${filename} has no document part in it.`);

    const counted = countedNumbering(numbering);
    const blocks: core.DocBlock[] = [];
    for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
        const paragraph = match[1] ?? "";
        const text = paragraphText(paragraph);
        if (!text.trim()) continue;
        blocks.push({ kind: paragraphKind(paragraph, counted), text });
    }
    return blocks;
}

/**
 * The numberings that count rather than bullet.
 *
 * A numbered paragraph carries an id and nothing else; what its marker looks
 * like lives in `word/numbering.xml`, two hops away - the id names a `w:num`,
 * which names an abstract numbering, which is where each level's format sits.
 * The hops are worth making because "1. 2. 3." arriving as "- - -" changes what
 * the document SAYS rather than how it looks: a procedure whose steps are in an
 * order stops saying that they are.
 *
 * A file with no numbering part, or an id that names nothing, is a bullet - the
 * same answer as before it read one, and the safe one.
 */
function countedNumbering(xml: string): ReadonlySet<string> {
    const counted = new Set<string>();
    if (!xml) return counted;

    const formats = new Map<string, string>();
    for (const match of xml.matchAll(
        /<w:abstractNum\b[^>]*w:abstractNumId="([^"]*)"([\s\S]*?)<\/w:abstractNum>/g
    )) {
        const body = match[2] ?? "";
        const first = /<w:lvl\b[^>]*w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/.exec(body);
        const format = /<w:numFmt\b[^>]*w:val="([^"]*)"/.exec(first?.[1] ?? body)?.[1] ?? "";
        if (match[1]) formats.set(match[1], format.toLowerCase());
    }

    for (const match of xml.matchAll(/<w:num\b[^>]*w:numId="([^"]*)"([\s\S]*?)<\/w:num>/g)) {
        const abstract = /<w:abstractNumId\b[^>]*w:val="([^"]*)"/.exec(match[2] ?? "")?.[1] ?? "";
        const format = formats.get(abstract) ?? "bullet";
        if (match[1] && format !== "bullet" && format !== "none") counted.add(match[1]);
    }
    return counted;
}

/**
 * The words in one paragraph: every run's text, with the tabs and the breaks
 * the run itself carries.
 *
 * The properties are dropped before anything is read, because a tab STOP and a
 * tab CHARACTER are the same element in two places: `<w:pPr><w:tabs><w:tab/>`
 * is where somebody's ruler put the stops, and reading it as text puts one `\t`
 * per stop in front of a paragraph nobody indented.
 */
function paragraphText(paragraph: string): string {
    const runs = paragraph.replace(/<w:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:pPr>)/g, "");
    let out = "";
    for (const piece of runs.matchAll(/<w:(t|tab|br)\b([^>]*)(?:\/>|>([\s\S]*?)<\/w:\1>)/g)) {
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
function paragraphKind(paragraph: string, counted: ReadonlySet<string>): string {
    const numbering = paragraphNumbering(paragraph);
    const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(paragraph)?.[1] ?? "";
    const flat = style.toLowerCase().replace(/[^a-z0-9]/g, "");

    const heading =
        /^heading([1-6])$/.exec(flat) ?? /^(?:titulo|titre|uberschrift)([1-6])$/.exec(flat);
    if (heading) return `h${heading[1]}`;
    if (flat === "title") return "h1";
    if (flat === "subtitle") return "h2";
    if (flat.includes("quote")) return "quote";
    if (flat.includes("code") || flat === "htmlpreformatted") return "code";
    // A list is a paragraph with a numbering id on it. The style is only a hint
    // - `ListParagraph` is applied to plenty of paragraphs that are not lists,
    // and a real list item always names a numbering.
    if (numbering) return counted.has(numbering) ? "oli" : "li";
    return "p";
}

/**
 * The numbering a paragraph sits in, or nothing when it sits in none.
 *
 * `w:numId` of 0 is not an id, it is Word's way of saying there is no numbering
 * here - what a paragraph that inherited a list style through `basedOn` carries
 * once somebody took the numbers off it. Read as a list it turns a document's
 * ordinary prose into bullets, so it answers the same as no `w:numPr` at all.
 */
function paragraphNumbering(paragraph: string): string {
    const properties = /<w:numPr\b[^>]*>([\s\S]*?)<\/w:numPr>/.exec(paragraph)?.[1];
    if (!properties) return "";
    const id = (/<w:numId\b[^>]*w:val="([^"]*)"/.exec(properties)?.[1] ?? "").trim();
    return !id || Number(id) === 0 ? "" : id;
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
 *
 * **A line ending is not a paragraph ending.** A file wrapped at 72 columns is
 * one paragraph per blank line, not one per line - which is what Markdown says a
 * soft break means, and what somebody who wrapped their README meant by it. So
 * plain lines are gathered and let go at a blank line or at a line that is
 * something else: a heading, an item, a quotation, a fence.
 */
function textBlocks(text: string): core.DocBlock[] {
    const blocks: core.DocBlock[] = [];
    let fenced = false;
    let code: string[] = [];
    let prose: string[] = [];

    const paragraph = (): void => {
        if (prose.length === 0) return;
        blocks.push({ kind: "p", text: prose.join(" ") });
        prose = [];
    };

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "");
        if (/^\s*```/.test(line)) {
            paragraph();
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
        if (!line.trim()) {
            paragraph();
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            paragraph();
            blocks.push({ kind: `h${heading[1]?.length ?? 1}`, text: heading[2] ?? "" });
            continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            paragraph();
            blocks.push({ kind: "li", text: bullet[1] ?? "" });
            continue;
        }
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (numbered) {
            paragraph();
            blocks.push({ kind: "oli", text: numbered[1] ?? "" });
            continue;
        }
        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            paragraph();
            blocks.push({ kind: "quote", text: quote[1] ?? "" });
            continue;
        }
        prose.push(line.trim());
    }
    paragraph();
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
        // A number, not the digit that was matched. The attribute is handed
        // straight to the editor's schema, which knows the level 2 and does not
        // know the level "2" - and a level it does not know is drawn as an H1,
        // which is every heading in the document at the same size.
        const level = Math.min(MAX_HEADING_LEVEL, Number(heading[1] ?? 1));
        node.setAttribute("level", level as unknown as string);
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
