/**
 * Records as a CSV file: one column per field, one row per record, every value
 * in a form a spreadsheet reads back and an import takes again - a day as
 * "2026-10-09", an amount as "1200.5 EUR", a yes/no as "true"/"false".
 *
 * Pure and client-safe, so the file a reader downloads is the one a test reads.
 */

import { readChoices, readLinks } from "./values";
import type { FieldDef, FieldValue, FullName, Money, Ref } from "./objects";

/** Where a cell begins a formula in a spreadsheet: such a cell is written as
 *  text, so a value somebody typed never runs as one when the file is opened. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One value as the text of its cell. */
export function csvValue(field: FieldDef, value: FieldValue | undefined): string {
    if (value === null || value === undefined) return "";
    switch (field.kind) {
        case "fullName": {
            const name = value as FullName;
            return [name.first, name.last].filter(Boolean).join(" ");
        }
        case "currency": {
            const money = value as Money;
            if (money.amount === null) return "";
            return money.currency ? `${money.amount} ${money.currency}` : String(money.amount);
        }
        // "1200.5 EUR", the form an import reads back into the same field.
        case "money": {
            const code = field.options?.[0];
            return code ? `${value} ${code}` : String(value);
        }
        case "member":
        case "relation":
            // A relation somebody added: its records' names, "; " between them,
            // the form an import reads back.
            if (Array.isArray(value)) return value.map((ref: Ref) => ref.name).join("; ");
            return (value as { name: string }).name;
        case "boolean":
            return value ? "true" : "false";
        case "multiSelect":
            return readChoices(value).join(", ");
        // One per line in the cell, as an address is: an import reads it back.
        case "links":
            return readLinks(value).join("\n");
        default:
            return String(value);
    }
}

/** A cell as CSV writes it: quoted when it holds a separator, a quote or a
 *  line break, and kept from being read as a formula. A number stays a number:
 *  "-3" is not a formula. */
export function csvCell(text: string): string {
    const safe =
        FORMULA_START.test(text) && !/^-?\d+(\.\d+)?( [A-Z]{3})?$/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * The whole file: a header of field names, then the records. Lines end in
 * CRLF and the file starts with a byte-order mark, the form spreadsheet
 * programs open as UTF-8 without asking.
 */
export function toCsv(
    fields: readonly FieldDef[],
    records: readonly { readonly values: Readonly<Record<string, FieldValue>> }[],
    labelOf: (field: FieldDef) => string
): string {
    const lines = [
        fields.map((field) => csvCell(labelOf(field))).join(","),
        ...records.map((record) =>
            fields.map((field) => csvCell(csvValue(field, record.values[field.key]))).join(",")
        )
    ];
    return `﻿${lines.join("\r\n")}\r\n`;
}

/** A file name for a list: "companies-2026-10-09.csv". */
export function csvFileName(name: string, now: Date): string {
    const slug = name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return `${slug || "records"}-${now.toISOString().slice(0, 10)}.csv`;
}
