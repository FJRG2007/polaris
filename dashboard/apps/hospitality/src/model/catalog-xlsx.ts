/**
 * The menu as an Excel workbook, both ways, by way of the CSV the catalogue
 * already reads and writes: an .xlsx is turned into that CSV before import, and
 * the exported CSV is laid into a sheet. So both formats check every row the
 * same way, and the workbook loader is fetched only when someone picks one.
 *
 * Every cell is written as text, so nothing in a menu becomes a formula.
 */

import { parseCsv } from "./catalog-csv";

/** Quoted for the CSV reader only: this text never reaches a spreadsheet. */
function quote(value: string): string {
    return /[",;\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

type Xlsx = typeof import("xlsx");

function load(): Promise<Xlsx> {
    return import("xlsx");
}

/** The first sheet of a workbook as catalogue CSV. */
export async function xlsxToCsv(bytes: ArrayBuffer, xlsx?: Xlsx): Promise<string> {
    const lib = xlsx ?? (await load());
    const book = lib.read(new Uint8Array(bytes), { type: "array" });
    const name = book.SheetNames[0];
    const sheet = name ? book.Sheets[name] : undefined;
    if (!sheet) return "";
    const rows = lib.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
    return rows.map((row) => row.map((cell) => quote(String(cell ?? ""))).join(",")).join("\r\n");
}

/** The exported catalogue CSV as an .xlsx file. */
export async function csvToXlsx(csv: string, sheetName: string, xlsx?: Xlsx): Promise<Uint8Array> {
    const lib = xlsx ?? (await load());
    const rows = parseCsv(csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv).map((row) => row.map((cell) => cell.replace(/^'(?=[=+\-@\t\r])/, "")));
    const sheet = lib.utils.aoa_to_sheet(rows.map((row) => row.map((cell) => ({ t: "s", v: cell }))));
    const book = lib.utils.book_new();
    lib.utils.book_append_sheet(book, sheet, sheetName.slice(0, 31) || "Menu");
    return new Uint8Array(lib.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
