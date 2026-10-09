/**
 * What a CRM field accepts, and the one form it is kept in: the same check runs
 * in the cell editor and on the server, so a value the box shows as valid is
 * the value stored.
 */

import { describe, expect, it } from "vitest";
import { fieldOf, type CrmObject } from "@polaris-app/crm/src/model/objects";
import { normalizeInput, parseAmount, typedCount } from "@polaris-app/crm/src/model/values";

const field = (object: CrmObject, key: string) => {
    const found = fieldOf(object, key);
    if (!found) throw new Error(`no field ${object}.${key}`);
    return found;
};

describe("normalizeInput", () => {
    it("trims text and refuses an empty name", () => {
        expect(normalizeInput(field("companies", "name"), "  Acme  ")).toEqual({ ok: true, value: "Acme" });
        expect(normalizeInput(field("companies", "name"), "   ")).toEqual({ ok: false, reason: "required" });
        expect(normalizeInput(field("companies", "city"), "")).toEqual({ ok: true, value: "" });
        expect(normalizeInput(field("companies", "city"), "x".repeat(501))).toEqual({
            ok: false,
            reason: "tooLong"
        });
    });

    it("capitalizes each word of a person's name and needs one of its parts", () => {
        expect(normalizeInput(field("people", "name"), { first: " ana maría ", last: "garcía" })).toEqual({
            ok: true,
            value: { first: "Ana María", last: "García" }
        });
        expect(normalizeInput(field("people", "name"), { first: "", last: " " })).toEqual({
            ok: false,
            reason: "required"
        });
    });

    it("lowercases an email and refuses one that is not", () => {
        expect(normalizeInput(field("people", "email"), " Ana@Example.COM ")).toEqual({
            ok: true,
            value: "ana@example.com"
        });
        expect(normalizeInput(field("people", "email"), "ana@")).toEqual({ ok: false, reason: "email" });
        expect(normalizeInput(field("people", "email"), "")).toEqual({ ok: true, value: "" });
    });

    it("keeps a website's host only, for the domain", () => {
        expect(normalizeInput(field("companies", "domain"), "https://www.Acme.com/about")).toEqual({
            ok: true,
            value: "acme.com"
        });
        expect(normalizeInput(field("companies", "domain"), "not a domain")).toEqual({
            ok: false,
            reason: "domain"
        });
    });

    it("gives a link a scheme and refuses anything but the web", () => {
        expect(normalizeInput(field("companies", "linkedinUrl"), "linkedin.com/company/acme")).toEqual({
            ok: true,
            value: "https://linkedin.com/company/acme"
        });
        expect(normalizeInput(field("companies", "linkedinUrl"), "javascript:alert(1)")).toMatchObject({
            ok: false
        });
    });

    it("takes whole numbers of employees, and nothing for empty", () => {
        expect(normalizeInput(field("companies", "employees"), "250")).toEqual({ ok: true, value: 250 });
        expect(normalizeInput(field("companies", "employees"), "")).toEqual({ ok: true, value: null });
        expect(normalizeInput(field("companies", "employees"), "2.5")).toEqual({
            ok: false,
            reason: "wholeNumber"
        });
        expect(normalizeInput(field("companies", "employees"), -1)).toEqual({ ok: false, reason: "wholeNumber" });
    });

    it("rounds an amount to cents and needs a known currency", () => {
        expect(normalizeInput(field("opportunities", "amount"), { amount: 1200.456, currency: "EUR" })).toEqual({
            ok: true,
            value: { amount: 1200.46, currency: "EUR" }
        });
        expect(normalizeInput(field("opportunities", "amount"), { amount: 10, currency: "XXX" })).toEqual({
            ok: false,
            reason: "currency"
        });
        expect(normalizeInput(field("opportunities", "amount"), { amount: null, currency: "EUR" })).toEqual({
            ok: true,
            value: { amount: null, currency: "" }
        });
    });

    it("takes a real calendar day only", () => {
        expect(normalizeInput(field("opportunities", "closeDate"), "2026-02-28")).toEqual({
            ok: true,
            value: "2026-02-28"
        });
        expect(normalizeInput(field("opportunities", "closeDate"), "2026-02-30")).toEqual({
            ok: false,
            reason: "date"
        });
        expect(normalizeInput(field("opportunities", "closeDate"), null)).toEqual({ ok: true, value: null });
    });

    it("takes one of a choice's options and a reference by id", () => {
        expect(normalizeInput(field("opportunities", "stage"), "proposal")).toEqual({ ok: true, value: "proposal" });
        expect(normalizeInput(field("opportunities", "stage"), "won")).toEqual({ ok: false, reason: "option" });
        const id = "6f1c2b0e-1d2a-4a8b-9c3d-2e4f5a6b7c8d";
        expect(normalizeInput(field("people", "company"), id)).toEqual({ ok: true, value: id });
        expect(normalizeInput(field("people", "company"), "acme")).toEqual({ ok: false, reason: "option" });
        expect(normalizeInput(field("people", "company"), null)).toEqual({ ok: true, value: null });
    });

    it("never writes a field Polaris keeps itself", () => {
        expect(normalizeInput(field("companies", "createdAt"), "2026-01-01T00:00:00Z")).toMatchObject({ ok: false });
    });
});

describe("parseAmount", () => {
    it("reads either language's punctuation", () => {
        expect(parseAmount("1.234,5")).toBe(1234.5);
        expect(parseAmount("1,234.5")).toBe(1234.5);
        expect(parseAmount("1,500")).toBe(1500);
        expect(parseAmount("12,5")).toBe(12.5);
        expect(parseAmount("€ 2 000")).toBe(2000);
        expect(parseAmount("abc")).toBeNull();
        expect(parseAmount("1.500.000")).toBe(1500000);
        expect(parseAmount("1,500,000.25")).toBe(1500000.25);
    });
});

describe("typedCount", () => {
    const employees = field("companies", "employees");

    it("reads grouping and refuses a fraction instead of dropping its separator", () => {
        expect(normalizeInput(employees, typedCount("1.500"))).toEqual({ ok: true, value: 1500 });
        expect(normalizeInput(employees, typedCount("1 500 000"))).toEqual({ ok: true, value: 1500000 });
        expect(normalizeInput(employees, typedCount("2.5"))).toEqual({ ok: false, reason: "wholeNumber" });
        expect(normalizeInput(employees, typedCount("1.000,5"))).toEqual({ ok: false, reason: "wholeNumber" });
        expect(normalizeInput(employees, typedCount("12abc"))).toEqual({ ok: false, reason: "number" });
        expect(normalizeInput(employees, typedCount("  "))).toEqual({ ok: true, value: null });
    });
});
