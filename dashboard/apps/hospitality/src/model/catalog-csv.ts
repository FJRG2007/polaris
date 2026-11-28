/**
 * The menu as a spreadsheet: one product per row, the columns below, in a CSV
 * that Excel, LibreOffice and Google Sheets open and save as they are.
 *
 * Reading is forgiving, because the file was typed by hand: headers in English
 * or Spanish and in any case, "12,50" or "12.50" or "12,50 EUR" for a price,
 * "10" or "10%" for the tax, `;` or `,` between columns (Excel in Spain saves
 * with `;`). A row it cannot read is reported by its number, never dropped in
 * silence.
 *
 * Pure.
 */

import { ALLERGENS, type Allergen } from "./allergens";

export const CSV_COLUMNS = [
    "category",
    "name",
    "price",
    "tax",
    "allergens",
    "sku",
    "description",
    "available",
    "station",
    "image"
] as const;
type Column = (typeof CSV_COLUMNS)[number];

const HEADER_ALIASES: Readonly<Record<string, Column>> = {
    category: "category",
    categoria: "category",
    familia: "category",
    name: "name",
    nombre: "name",
    producto: "name",
    articulo: "name",
    price: "price",
    precio: "price",
    pvp: "price",
    tax: "tax",
    iva: "tax",
    impuesto: "tax",
    allergens: "allergens",
    alergenos: "allergens",
    sku: "sku",
    codigo: "sku",
    code: "sku",
    barcode: "sku",
    description: "description",
    descripcion: "description",
    available: "available",
    disponible: "available",
    station: "station",
    estacion: "station",
    image: "image",
    imagen: "image",
    foto: "image"
};

export interface CsvProduct {
    readonly category: string;
    readonly name: string;
    readonly price: number;
    readonly taxRateBp: number;
    readonly allergens: Allergen[];
    readonly sku: string | null;
    readonly description: string;
    readonly available: boolean;
    readonly station: string | null;
    readonly imageUrl: string | null;
}

export interface CsvRead {
    readonly products: CsvProduct[];
    /** 1-based row numbers (the header is row 1) and why each was skipped. */
    readonly skipped: Array<{ row: number; reason: "name" | "price" | "category" }>;
}

/** Splits CSV text into rows of cells (quotes, doubled quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
    const source = text.replace(/^﻿/, "");
    const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
    const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (quoted) {
            if (ch === '"' && source[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"' && cell === "") quoted = true;
        else if (ch === delimiter) {
            row.push(cell);
            cell = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && source[i + 1] === "\n") i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        } else cell += ch;
    }
    if (cell !== "" || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const fold = (value: string) =>
    value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .trim()
        .toLowerCase();

/** "12,50", "12.50", "1.234,50", "12,50 EUR" -> cents; null when it is not a price. */
export function parsePrice(raw: string): number | null {
    let text = raw.replace(/[^\d.,-]/g, "");
    if (!/\d/.test(text)) return null;
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    if (lastComma > lastDot) text = text.replace(/\./g, "").replace(",", ".");
    else text = text.replace(/,/g, "");
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
    return Math.round(value * 100);
}

/** "10", "10%", "10,5" -> basis points; empty is the default 10 % of food in Spain. */
export function parseTax(raw: string): number | null {
    const text = raw.replace(/%/g, "").replace(",", ".").trim();
    if (text === "") return 1000;
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0 || value > 100) return null;
    return Math.round(value * 100);
}

function parseAllergens(raw: string): Allergen[] {
    const known = new Map<string, Allergen>();
    for (const a of ALLERGENS) {
        known.set(a.key, a.key);
        for (const alias of a.aliases) known.set(alias, a.key);
    }
    const out = new Set<Allergen>();
    for (const part of raw.split(/[|,;/]+/)) {
        const key = known.get(fold(part));
        if (key) out.add(key);
    }
    return [...out];
}

const NO = new Set(["no", "n", "false", "0", "falso"]);

export function readCatalogCsv(text: string): CsvRead {
    const rows = parseCsv(text);
    const header = (rows[0] ?? []).map((h) => HEADER_ALIASES[fold(h).replace(/\s+/g, "")] ?? null);
    const at = (row: string[], column: Column) => {
        const index = header.indexOf(column);
        return index >= 0 ? (row[index] ?? "").trim() : "";
    };
    const products: CsvProduct[] = [];
    const skipped: CsvRead["skipped"] = [];
    rows.slice(1).forEach((row, i) => {
        const number = i + 2;
        const name = at(row, "name");
        if (!name) return void skipped.push({ row: number, reason: "name" });
        const category = at(row, "category");
        if (!category) return void skipped.push({ row: number, reason: "category" });
        const price = parsePrice(at(row, "price"));
        const taxRateBp = parseTax(at(row, "tax"));
        if (price === null || taxRateBp === null) return void skipped.push({ row: number, reason: "price" });
        const image = at(row, "image");
        products.push({
            category: category.slice(0, 80),
            name: name.slice(0, 120),
            price,
            taxRateBp,
            allergens: parseAllergens(at(row, "allergens")),
            sku: at(row, "sku").slice(0, 64) || null,
            description: at(row, "description").slice(0, 500),
            available: !NO.has(fold(at(row, "available"))),
            station: at(row, "station").slice(0, 40) || null,
            imageUrl: /^https?:\/\//i.test(image) || image.startsWith("/") ? image.slice(0, 500) : null
        });
    });
    return { products, skipped };
}

/** A cell as CSV writes it. A leading = + - @ is prefixed so a spreadsheet never runs it as a formula. */
export function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",;\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function writeCatalogCsv(products: readonly CsvProduct[]): string {
    const money = (cents: number) => (cents / 100).toFixed(2);
    const lines = [CSV_COLUMNS.join(",")];
    for (const p of products) {
        lines.push(
            [
                p.category,
                p.name,
                money(p.price),
                String(p.taxRateBp / 100),
                p.allergens.join("|"),
                p.sku ?? "",
                p.description,
                p.available ? "yes" : "no",
                p.station ?? "",
                p.imageUrl ?? ""
            ]
                .map(csvCell)
                .join(",")
        );
    }
    return `﻿${lines.join("\r\n")}\r\n`;
}
