/**
 * The menu spreadsheet: forgiving on the way in, safe on the way out.
 */

import { describe, expect, it } from "vitest";
import { csvCell, parsePrice, readCatalogCsv, writeCatalogCsv } from "@polaris-app/hospitality/src/model/catalog-csv";

describe("reading a menu", () => {
    it("reads a Spanish Excel file with semicolons, accents and comma decimals", () => {
        const read = readCatalogCsv(
            "﻿Categoría;Nombre;Precio;IVA;Alérgenos\nBebidas;Caña;2,50 €;10%;Gluten\nPostres;\"Tarta; queso\";5;;leche|huevos\n"
        );
        expect(read.skipped).toEqual([]);
        expect(read.products).toMatchObject([
            { category: "Bebidas", name: "Caña", price: 250, taxRateBp: 1000, allergens: ["gluten"] },
            { category: "Postres", name: "Tarta; queso", price: 500, taxRateBp: 1000, allergens: ["milk", "eggs"] }
        ]);
    });

    it("names the rows it could not read", () => {
        const read = readCatalogCsv("category,name,price\nDrinks,,1\n,Water,1\nDrinks,Water,free\nDrinks,Water,1.80\n");
        expect(read.skipped).toEqual([
            { row: 2, reason: "name" },
            { row: 3, reason: "category" },
            { row: 4, reason: "price" }
        ]);
        expect(read.products).toHaveLength(1);
    });

    it("reads prices the way people type them", () => {
        expect(parsePrice("1.234,50")).toBe(123_450);
        expect(parsePrice("12.5")).toBe(1250);
        expect(parsePrice("abc")).toBeNull();
    });
});

describe("writing a menu", () => {
    it("reads back what it wrote", () => {
        const products = readCatalogCsv('category,name,price,tax,allergens,sku\nDrinks,"Water, still",1.80,10,,W1\n').products;
        expect(readCatalogCsv(writeCatalogCsv(products)).products).toEqual(products);
    });

    it("never lets a spreadsheet run a cell as a formula", () => {
        expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
        expect(csvCell("-5")).toBe("'-5");
    });
});
