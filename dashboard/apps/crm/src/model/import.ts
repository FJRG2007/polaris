/**
 * A CSV file read into records: the file split into cells, its columns matched
 * to fields, and every row checked by the same `normalizeInput` a cell's
 * editor runs - so the preview shows exactly what the server will refuse.
 *
 * Pure and client-safe. The browser runs it for the preview; the server runs
 * it again on every batch it is sent, and stores only what passes.
 */

import type { FieldDef } from "./objects";
import { normalizeInput, parseAmount, type InvalidReason } from "./values";

/** The most rows one import takes. */
export const MAX_IMPORT_ROWS = 10_000;

/** The largest file one import reads, in bytes. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** The most columns a file may have. */
export const MAX_IMPORT_COLUMNS = 64;

/** The longest cell kept, in characters. Longer ones are refused per field. */
export const MAX_IMPORT_CELL = 2_000;

/** How many rows one request to the server carries. */
export const IMPORT_BATCH = 250;

export type ParseFailure = "empty" | "tooManyRows" | "tooManyColumns" | "unclosedQuote";

export type ParsedCsv =
    | { readonly ok: true; readonly header: string[]; readonly rows: string[][] }
    | { readonly ok: false; readonly reason: ParseFailure };

/** The separator a file uses: the one of comma, semicolon or tab that appears
 *  most in its first line outside quotes. Spreadsheets in many locales save
 *  with a semicolon. */
export function detectDelimiter(text: string): string {
    const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
    let quoted = false;
    for (const char of text) {
        if (char === '"') quoted = !quoted;
        else if (!quoted && (char === "\n" || char === "\r")) break;
        else if (!quoted && char in counts) counts[char]! += 1;
    }
    return Object.entries(counts).reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

/**
 * A CSV file as its header and rows (RFC 4180: quoted cells may hold
 * separators, doubled quotes and line breaks). A byte-order mark is dropped,
 * blank lines are skipped, and the file is refused past the row or column
 * ceiling rather than read halfway.
 */
export function parseCsv(input: string): ParsedCsv {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const separator = detectDelimiter(text);
    const lines: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    const endRow = (): boolean => {
        row.push(cell);
        cell = "";
        if (row.some((value) => value.trim() !== "")) lines.push(row);
        row = [];
        // The header plus the ceiling: one more is a file too long.
        return lines.length <= MAX_IMPORT_ROWS + 1;
    };
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index]!;
        if (quoted) {
            if (char !== '"') cell += char;
            else if (text[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else quoted = false;
        } else if (char === '"' && cell === "") quoted = true;
        else if (char === separator) {
            row.push(cell);
            cell = "";
            if (row.length >= MAX_IMPORT_COLUMNS) return { ok: false, reason: "tooManyColumns" };
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[index + 1] === "\n") index += 1;
            if (!endRow()) return { ok: false, reason: "tooManyRows" };
        } else cell += char;
    }
    if (quoted) return { ok: false, reason: "unclosedQuote" };
    if ((cell !== "" || row.length > 0) && !endRow()) return { ok: false, reason: "tooManyRows" };
    const [header, ...rows] = lines;
    if (!header || rows.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, header: header.map((name) => name.trim()), rows };
}

/** A name compared loosely: no accents, no case, no punctuation. */
function loose(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

/**
 * Which field each column of the file goes to, guessed from the column's name
 * against each field's label and key. A field takes one column at most; a
 * column nothing matches is left out (null).
 */
export function guessMapping(
    header: readonly string[],
    fields: readonly FieldDef[],
    labelOf: (field: FieldDef) => string
): (string | null)[] {
    const taken = new Set<string>();
    return header.map((name) => {
        const wanted = loose(name);
        const field = fields.find(
            (candidate) =>
                !taken.has(candidate.key) &&
                wanted !== "" &&
                (loose(labelOf(candidate)) === wanted || loose(candidate.key) === wanted)
        );
        if (!field) return null;
        taken.add(field.key);
        return field.key;
    });
}

const TRUE = new Set(["true", "yes", "y", "si", "sí", "1", "x", "verdadero"]);
const FALSE = new Set(["false", "no", "n", "0", "falso"]);

/** "Ada Lovelace" -> first "Ada", last "Lovelace": the form an export writes. */
export function splitName(text: string): { first: string; last: string } {
    const trimmed = text.trim().replace(/\s+/g, " ");
    const space = trimmed.indexOf(" ");
    return space < 0
        ? { first: trimmed, last: "" }
        : { first: trimmed.slice(0, space), last: trimmed.slice(space + 1) };
}

/**
 * A cell's text as the value an editor would send for the field: "1200.5 EUR"
 * an amount and its currency, "yes" a yes, "1.234,5" a number. What does not
 * read as the field's kind is passed on as typed, for the check to refuse.
 */
export function cellInput(field: FieldDef, cell: string): unknown {
    const text = cell.trim();
    switch (field.kind) {
        case "fullName":
            return splitName(text);
        case "number":
            return text === "" ? null : (parseAmount(text) ?? text);
        case "currency": {
            if (text === "") return { amount: null, currency: "" };
            const match = /^([A-Za-z]{3})?\s*([^A-Za-z]*?)\s*([A-Za-z]{3})?$/.exec(text);
            const amount = match ? parseAmount(match[2] ?? "") : null;
            if (!match || amount === null) return text;
            return { amount, currency: (match[3] ?? match[1] ?? "").toUpperCase() };
        }
        case "boolean": {
            const word = text.toLowerCase();
            if (TRUE.has(word)) return true;
            if (FALSE.has(word) || word === "") return false;
            return text;
        }
        case "date":
            // A date and time keeps its day: "2026-10-09T10:00:00Z" -> "2026-10-09".
            return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text;
        case "select": {
            const option = field.options?.find(
                (value) => value.toLowerCase() === text.toLowerCase()
            );
            return option ?? text;
        }
        default:
            return text;
    }
}

export interface RowProblem {
    readonly key: string;
    readonly reason: InvalidReason | "missing" | "ambiguous" | "notOnShelf";
}

export interface CheckedRow {
    /** The values to store, normalized; references are still names. */
    readonly values: Record<string, unknown>;
    /** A reference field's name as written, to be found on the server. */
    readonly refs: Record<string, string>;
    readonly problems: RowProblem[];
}

/**
 * One row checked against its fields. `columns[i]` is the field column `i`
 * goes to, or null for a column left out. A row without the record's name is
 * refused; every other empty cell leaves its field empty.
 */
export function checkRow(
    columns: readonly (FieldDef | null)[],
    cells: readonly string[],
    primary: FieldDef
): CheckedRow {
    const values: Record<string, unknown> = {};
    const refs: Record<string, string> = {};
    const problems: RowProblem[] = [];
    columns.forEach((field, index) => {
        if (!field) return;
        const cell = (cells[index] ?? "").trim();
        if (cell === "" && !field.primary) return;
        if (cell.length > MAX_IMPORT_CELL) {
            problems.push({ key: field.key, reason: "tooLong" });
            return;
        }
        if (field.kind === "relation" || field.kind === "member") {
            refs[field.key] = cell;
            return;
        }
        const normalized = normalizeInput(field, cellInput(field, cell));
        if (normalized.ok) values[field.key] = normalized.value;
        else problems.push({ key: field.key, reason: normalized.reason });
    });
    if (!columns.some((field) => field?.key === primary.key)) {
        problems.push({ key: primary.key, reason: "required" });
    }
    return { values, refs, problems };
}

/** Rows cut into the batches the server is sent. */
export function batches<T>(rows: readonly T[], size: number = IMPORT_BATCH): T[][] {
    const out: T[][] = [];
    for (let start = 0; start < rows.length; start += size)
        out.push(rows.slice(start, start + size));
    return out;
}
