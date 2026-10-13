/**
 * A list exported as CSV: every value in a form a spreadsheet reads back, cells
 * quoted where they must be, and nothing typed into a record able to run as a
 * formula when the file is opened.
 */

import { describe, expect, it } from "vitest";
import { fieldOf, type FieldDef } from "@polaris-app/crm/src/model/objects";
import { csvCell, csvFileName, csvValue, toCsv } from "@polaris-app/crm/src/model/csv";

const field = (object: "companies" | "people" | "opportunities", key: string): FieldDef => {
    const found = fieldOf(object, key);
    if (!found) throw new Error(`no field ${key}`);
    return found;
};

describe("csvValue", () => {
    it("writes each kind in a form an import takes back", () => {
        expect(csvValue(field("people", "name"), { first: "Ada", last: "Example" })).toBe(
            "Ada Example"
        );
        expect(
            csvValue(field("opportunities", "amount"), { amount: 1200.5, currency: "EUR" })
        ).toBe("1200.5 EUR");
        expect(csvValue(field("opportunities", "amount"), { amount: null, currency: "EUR" })).toBe(
            ""
        );
        expect(csvValue(field("companies", "idealCustomer"), true)).toBe("true");
        expect(csvValue(field("companies", "idealCustomer"), false)).toBe("false");
        expect(csvValue(field("people", "company"), { id: "x", name: "Example Co" })).toBe(
            "Example Co"
        );
        expect(csvValue(field("opportunities", "closeDate"), "2026-10-09")).toBe("2026-10-09");
        expect(csvValue(field("companies", "employees"), 42)).toBe("42");
        expect(csvValue(field("companies", "city"), null)).toBe("");
        expect(csvValue(field("companies", "city"), undefined)).toBe("");
    });
});

describe("csvCell", () => {
    it("quotes separators, quotes and line breaks", () => {
        expect(csvCell("plain")).toBe("plain");
        expect(csvCell("a,b")).toBe('"a,b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell("two\nlines")).toBe('"two\nlines"');
    });

    it("keeps typed text from running as a formula", () => {
        expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
        expect(csvCell("+1+1")).toBe("'+1+1");
        expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
        expect(csvCell("-2+3")).toBe("'-2+3");
        expect(csvCell("=1,2")).toBe('"\'=1,2"');
    });

    it("leaves negative numbers and amounts as numbers", () => {
        expect(csvCell("-3")).toBe("-3");
        expect(csvCell("-3.25 EUR")).toBe("-3.25 EUR");
    });
});

describe("toCsv", () => {
    it("writes a header, one CRLF line per record and a byte-order mark", () => {
        const fields = [field("companies", "name"), field("companies", "employees")];
        const csv = toCsv(
            fields,
            [
                { values: { name: "Example, Inc", employees: 10 } },
                { values: { name: "Other", employees: null } }
            ],
            (one) => (one.key === "name" ? "Name" : "Employees")
        );
        expect(csv).toBe('﻿Name,Employees\r\n"Example, Inc",10\r\nOther,\r\n');
    });

    it("writes only the header for an empty list", () => {
        expect(toCsv([field("companies", "name")], [], () => "Name")).toBe("﻿Name\r\n");
    });
});

describe("csvFileName", () => {
    it("names the file after the list and the day", () => {
        const day = new Date("2026-10-09T12:00:00Z");
        expect(csvFileName("Companies", day)).toBe("companies-2026-10-09.csv");
        expect(csvFileName("Oportunidades ñandú", day)).toBe("oportunidades-nandu-2026-10-09.csv");
        expect(csvFileName("!!!", day)).toBe("records-2026-10-09.csv");
    });
});
