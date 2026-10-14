/**
 * The links and address kinds a field somebody adds can be: what may be
 * written into them, how they read, filter, import and export.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: { Decimal: class {} } }));

import { csvValue } from "@polaris-app/crm/src/model/csv";
import { cellInput } from "@polaris-app/crm/src/model/import";
import { filterWhere } from "@polaris-app/crm/src/lib/filters";
import { plainText } from "@polaris-app/crm/src/screens/format";
import { operatorsFor } from "@polaris-app/crm/src/model/filters";
import { customDef, fieldInputSchema } from "@polaris-app/crm/src/model/fields";
import { CUSTOM_KINDS, slotFamily, type FieldDef } from "@polaris-app/crm/src/model/objects";
import {
    MAX_LINKS,
    addressLine,
    normalizeInput,
    readAddress,
    readLinks
} from "@polaris-app/crm/src/model/values";

const sites: FieldDef = customDef({
    id: "f1",
    slot: "cText1",
    label: "Sites",
    kind: "links",
    options: []
});
const office: FieldDef = customDef({
    id: "f2",
    slot: "cText2",
    label: "Office",
    kind: "address",
    options: []
});

const stored = (field: FieldDef, raw: unknown): string => {
    const result = normalizeInput(field, raw);
    if (!result.ok) throw new Error(result.reason);
    return result.value as string;
};

describe("links", () => {
    it("is a field somebody can add, kept in a text slot with no choices", () => {
        expect(CUSTOM_KINDS).toContain("links");
        expect(slotFamily("links")).toBe("cText");
        const input = fieldInputSchema.parse({ label: "Sites", kind: "links", options: ["x"] });
        expect(input.options).toEqual([]);
    });

    it("keeps each address once, as a full URL, typed with spaces or commas", () => {
        const value = stored(sites, "example.com, https://blog.example.com/a,b  example.com");
        expect(readLinks(value)).toEqual(["https://example.com/", "https://blog.example.com/a,b"]);
        expect(stored(sites, readLinks(value))).toBe(value);
        expect(stored(sites, value)).toBe(value);
        expect(stored(sites, "")).toBe("");
        expect(stored(sites, null)).toBe("");
        expect(stored(sites, " , ")).toBe("");
    });

    it("refuses anything that is not a web address, or too many", () => {
        expect(normalizeInput(sites, "example.com javascript:alert(1)")).toEqual({
            ok: false,
            reason: "url"
        });
        expect(normalizeInput(sites, "not a link")).toEqual({ ok: false, reason: "url" });
        expect(normalizeInput(sites, [1])).toEqual({ ok: false, reason: "url" });
        expect(normalizeInput(sites, { a: 1 })).toEqual({ ok: false, reason: "url" });
        const many = Array.from({ length: MAX_LINKS + 1 }, (_, index) => `s${index}.example.com`);
        expect(normalizeInput(sites, many)).toEqual({ ok: false, reason: "tooMany" });
        expect(normalizeInput(sites, many.slice(1)).ok).toBe(true);
    });

    it("exports one per line and imports that back", () => {
        const value = stored(sites, "example.com blog.example.com");
        const cell = csvValue(sites, value);
        expect(cell).toBe("https://example.com/\nhttps://blog.example.com/");
        expect(stored(sites, cellInput(sites, cell))).toBe(value);
        expect(plainText(sites, value, {} as never, "en-US")).toBe(
            "https://example.com/ https://blog.example.com/"
        );
    });

    it("filters as text", () => {
        expect(operatorsFor("links")[0]).toBe("contains");
        expect(
            filterWhere(
                "companies",
                {
                    conjunction: "and",
                    rules: [{ id: "r", key: "cText1", operator: "isEmpty", value: null }]
                },
                [sites]
            )
        ).toEqual({ AND: [{ cText1: "" }] });
    });
});

describe("address", () => {
    it("is a field somebody can add, kept in a text slot", () => {
        expect(CUSTOM_KINDS).toContain("address");
        expect(slotFamily("address")).toBe("cText");
    });

    it("keeps its parts one per line, trimmed, and reads them back", () => {
        const value = stored(office, {
            street: "  Main  Street 1 ",
            city: "Springfield",
            postcode: "12345",
            country: "Example Land"
        });
        expect(value).toBe("Main Street 1\nSpringfield\n\n12345\nExample Land");
        expect(readAddress(value)).toEqual({
            street: "Main Street 1",
            city: "Springfield",
            state: "",
            postcode: "12345",
            country: "Example Land"
        });
        expect(addressLine(value)).toBe("Main Street 1, Springfield, 12345, Example Land");
        expect(stored(office, value)).toBe(value);
        expect(stored(office, { street: " ", city: "" })).toBe("");
        expect(stored(office, null)).toBe("");
    });

    it("takes text typed on one line as the street", () => {
        expect(readAddress(stored(office, "Main Street 1, Springfield"))).toMatchObject({
            street: "Main Street 1, Springfield",
            city: ""
        });
    });

    it("keeps the lines past the last part with the street, not shifted", () => {
        const pasted = "Flat 2\r\nMain Street 1\nSpringfield\nIL\n12345\nExample Land";
        expect(readAddress(pasted)).toEqual({
            street: "Flat 2, Main Street 1",
            city: "Springfield",
            state: "IL",
            postcode: "12345",
            country: "Example Land"
        });
    });

    it("refuses a part that is not text, or too long", () => {
        expect(normalizeInput(office, { street: 3 })).toEqual({ ok: false, reason: "address" });
        expect(normalizeInput(office, 3)).toEqual({ ok: false, reason: "address" });
        expect(normalizeInput(office, ["Main Street"])).toEqual({ ok: false, reason: "address" });
        expect(normalizeInput(office, { city: "x".repeat(201) })).toEqual({
            ok: false,
            reason: "tooLong"
        });
    });

    it("exports its lines and imports them back, and filters as text", () => {
        const value = stored(office, { street: "Main Street 1", country: "Example Land" });
        const cell = csvValue(office, value);
        expect(stored(office, cellInput(office, cell))).toBe(value);
        expect(plainText(office, value, {} as never, "en-US")).toBe("Main Street 1, Example Land");
        expect(operatorsFor("address")[0]).toBe("contains");
    });
});
