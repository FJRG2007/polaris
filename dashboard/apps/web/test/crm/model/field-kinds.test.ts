/**
 * The rating and multi-select kinds a field somebody adds can be: what may be
 * written into them, how they filter, import and export.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: { Decimal: class {} } }));

import { csvValue } from "@polaris-app/crm/src/model/csv";
import { cellInput } from "@polaris-app/crm/src/model/import";
import { filterWhere } from "@polaris-app/crm/src/lib/filters";
import { slotFamily, type FieldDef } from "@polaris-app/crm/src/model/objects";
import { customDef, fieldInputSchema } from "@polaris-app/crm/src/model/fields";
import { normalizeInput, readChoices } from "@polaris-app/crm/src/model/values";

const tags: FieldDef = customDef({
    id: "f1",
    slot: "cText1",
    label: "Tags",
    kind: "multiSelect",
    options: ["Red", "Blue", 'Say "hi"']
});
const score: FieldDef = customDef({
    id: "f2",
    slot: "cNum1",
    label: "Score",
    kind: "rating",
    options: []
});

describe("rating", () => {
    it("is kept in a number slot, one to five stars or none", () => {
        expect(slotFamily("rating")).toBe("cNum");
        expect(normalizeInput(score, 4)).toEqual({ ok: true, value: 4 });
        expect(normalizeInput(score, " 2 ")).toEqual({ ok: true, value: 2 });
        expect(normalizeInput(score, null)).toEqual({ ok: true, value: null });
        expect(normalizeInput(score, 0)).toEqual({ ok: true, value: null });
        for (const wrong of [6, -1, 2.5, "lots", true]) {
            expect(normalizeInput(score, wrong)).toEqual({ ok: false, reason: "rating" });
        }
    });

    it("filters as a number and imports a typed digit", () => {
        expect(
            filterWhere(
                "companies",
                {
                    conjunction: "and",
                    rules: [{ id: "r", key: "cNum1", operator: "greaterThan", value: 3 }]
                },
                [score]
            )
        ).toEqual({ cNum1: { gt: 3 } });
        expect(cellInput(score, "4")).toBe(4);
        expect(cellInput(score, "")).toBeNull();
    });
});

describe("multi-select", () => {
    it("needs named choices, like a single choice", () => {
        expect(
            fieldInputSchema.safeParse({ label: "Tags", kind: "multiSelect", options: [] }).success
        ).toBe(false);
        expect(
            fieldInputSchema.parse({ label: "Tags", kind: "multiSelect", options: ["Red"] }).options
        ).toEqual(["Red"]);
    });

    it("keeps known choices once each, in option order, as a JSON list", () => {
        expect(normalizeInput(tags, ["Blue", "red", "Blue"])).toEqual({
            ok: true,
            value: JSON.stringify(["Red", "Blue"])
        });
        expect(normalizeInput(tags, "blue, Red")).toEqual({
            ok: true,
            value: JSON.stringify(["Red", "Blue"])
        });
        expect(normalizeInput(tags, JSON.stringify(["Blue"]))).toEqual({
            ok: true,
            value: JSON.stringify(["Blue"])
        });
        expect(normalizeInput(tags, [])).toEqual({ ok: true, value: "" });
        expect(normalizeInput(tags, "")).toEqual({ ok: true, value: "" });
        expect(normalizeInput(tags, ["Green"])).toEqual({ ok: false, reason: "option" });
        expect(normalizeInput(tags, 3)).toEqual({ ok: false, reason: "option" });
        expect(readChoices("not json")).toEqual([]);
    });

    it("filters by a choice's quoted name, so one never matches inside another", () => {
        const where = (operator: string, value: unknown) =>
            filterWhere(
                "companies",
                {
                    conjunction: "and",
                    rules: [{ id: "r", key: "cText1", operator, value }]
                } as never,
                [tags]
            );
        const quoted = JSON.stringify(['Say "hi"']).slice(1, -1);
        expect(
            where("isAnyOf", [
                { id: "Red", name: "" },
                { id: 'Say "hi"', name: "" }
            ])
        ).toEqual({
            OR: [{ cText1: { contains: '"Red"' } }, { cText1: { contains: quoted } }]
        });
        expect(where("isNoneOf", [{ id: "Blue", name: "" }])).toEqual({
            NOT: { OR: [{ cText1: { contains: '"Blue"' } }] }
        });
        expect(where("isEmpty", null)).toEqual({ cText1: "" });
        expect(where("isNotEmpty", null)).toEqual({ NOT: { cText1: "" } });
    });

    it('imports "Red; blue" and exports "Red, Blue"', () => {
        const typed = cellInput(tags, "Red; blue");
        expect(typed).toEqual(["Red", "Blue"]);
        const stored = normalizeInput(tags, typed);
        expect(stored.ok && csvValue(tags, stored.value as string)).toBe("Red, Blue");
    });
});
