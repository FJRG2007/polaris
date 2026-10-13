/**
 * Reading a CSV file into records: the file split into cells the way a
 * spreadsheet writes it, its columns matched to fields, and each row checked
 * with the rules a cell's editor uses - the same rules the server applies.
 */

import { describe, expect, it } from "vitest";
import { FIELDS, fieldOf, primaryField } from "@polaris-app/crm/src/model/objects";
import {
    batches,
    cellInput,
    checkRow,
    detectDelimiter,
    guessMapping,
    MAX_IMPORT_ROWS,
    parseCsv
} from "@polaris-app/crm/src/model/import";

const field = (object: "companies" | "people" | "opportunities", key: string) =>
    fieldOf(object, key)!;

describe("parseCsv", () => {
    it("reads quoted cells with separators, quotes and line breaks", () => {
        const parsed = parseCsv(
            '\uFEFFName,Note\r\n"Acme, Inc","said ""hi""\nthen left"\r\n\r\nBeta,x\r\n'
        );
        expect(parsed).toEqual({
            ok: true,
            header: ["Name", "Note"],
            rows: [
                ["Acme, Inc", 'said "hi"\nthen left'],
                ["Beta", "x"]
            ]
        });
    });

    it("reads a semicolon-separated file", () => {
        expect(detectDelimiter("Nombre;Ciudad\nAcme;Madrid")).toBe(";");
        expect(parseCsv("Nombre;Ciudad\nAcme;Madrid")).toMatchObject({
            rows: [["Acme", "Madrid"]]
        });
    });

    it("refuses an empty file, an open quote and a file past the ceiling", () => {
        expect(parseCsv("Name\n")).toEqual({ ok: false, reason: "empty" });
        expect(parseCsv('Name\n"Acme')).toEqual({ ok: false, reason: "unclosedQuote" });
        const long = `Name\n${"a\n".repeat(MAX_IMPORT_ROWS + 1)}`;
        expect(parseCsv(long)).toEqual({ ok: false, reason: "tooManyRows" });
        expect(parseCsv(`Name\n${"a\n".repeat(MAX_IMPORT_ROWS)}`)).toMatchObject({ ok: true });
        expect(parseCsv(`${"a,".repeat(70)}\n1`)).toEqual({ ok: false, reason: "tooManyColumns" });
    });
});

describe("guessMapping", () => {
    it("matches columns by label or key, loosely, each field once", () => {
        const label = (one: { key: string }) =>
            ({ name: "Name", domain: "Domain", annualRevenue: "Annual revenue" })[one.key] ??
            one.key;
        expect(
            guessMapping(
                ["NAME", "Annual Revenue", "name", "Whatever", "domain"],
                FIELDS.companies,
                label
            )
        ).toEqual(["name", "annualRevenue", null, null, "domain"]);
    });
});

describe("cellInput", () => {
    it("reads what an export writes", () => {
        expect(cellInput(field("companies", "annualRevenue"), "1200.5 EUR")).toEqual({
            amount: 1200.5,
            currency: "EUR"
        });
        expect(cellInput(field("companies", "annualRevenue"), "usd 1.234,5")).toEqual({
            amount: 1234.5,
            currency: "USD"
        });
        expect(cellInput(field("companies", "idealCustomer"), "Sí")).toBe(true);
        expect(cellInput(field("companies", "idealCustomer"), "no")).toBe(false);
        expect(cellInput(field("companies", "employees"), "1.500")).toBe(1500);
        expect(cellInput(field("people", "name"), " Ada  King Lovelace ")).toEqual({
            first: "Ada",
            last: "King Lovelace"
        });
        expect(cellInput(field("opportunities", "stage"), "Meeting")).toBe("meeting");
        expect(cellInput(field("opportunities", "closeDate"), "2026-10-09T10:00:00Z")).toBe(
            "2026-10-09"
        );
    });
});

describe("checkRow", () => {
    const columns = [
        field("companies", "name"),
        null,
        field("companies", "domain"),
        field("companies", "employees")
    ];
    const primary = primaryField("companies");

    it("normalizes what passes and leaves empty cells out", () => {
        expect(
            checkRow(columns, [" Acme ", "ignored", "https://www.Acme.com/x", ""], primary)
        ).toEqual({
            values: { name: "Acme", domain: "acme.com" },
            refs: {},
            problems: []
        });
    });

    it("says which field is wrong and why", () => {
        expect(checkRow(columns, ["", "", "not a domain", "2.5"], primary).problems).toEqual([
            { key: "name", reason: "required" },
            { key: "domain", reason: "domain" },
            { key: "employees", reason: "wholeNumber" }
        ]);
    });

    it("keeps references as names and needs the name column mapped", () => {
        const people = [field("people", "name"), field("people", "company")];
        expect(checkRow(people, ["Ada Lovelace", "Acme"], primaryField("people")).refs).toEqual({
            company: "Acme"
        });
        expect(checkRow([field("companies", "city")], ["Madrid"], primary).problems).toEqual([
            { key: "name", reason: "required" }
        ]);
    });
});

describe("batches", () => {
    it("cuts rows into batches of the given size", () => {
        expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(batches([], 2)).toEqual([]);
    });
});
