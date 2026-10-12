/**
 * Fields somebody adds: the typed input, the slot each kind is kept in, and
 * the slot columns read, filtered, sorted and grouped like a built-in field.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: { Decimal: class {} } }));

import { readConfig } from "@polaris-app/crm/src/model/views";
import { normalizeInput } from "@polaris-app/crm/src/model/values";
import { columnOf, toRecord } from "@polaris-app/crm/src/lib/columns";
import { listOrder, listWhere } from "@polaris-app/crm/src/lib/query";
import { fieldOf, SLOTS, slotFamily, slotOf } from "@polaris-app/crm/src/model/objects";
import { customDef, fieldInputSchema, validStored } from "@polaris-app/crm/src/model/fields";

const shelf = { orgId: "org-1", userId: null, key: "org:org-1", orgName: "Org" };
const source = customDef({
    id: "f1",
    slot: "cText1",
    label: "Source",
    kind: "select",
    options: ["Web", "Event"]
});
const score = customDef({ id: "f2", slot: "cNum2", label: "Score", kind: "number", options: [] });

describe("field input", () => {
    it("normalizes the name and drops choices of a kind without them", () => {
        const parsed = fieldInputSchema.parse({ label: "  Lead   source ", kind: "text", options: ["a"] });
        expect(parsed).toEqual({ label: "Lead source", kind: "text", options: [] });
    });

    it("refuses a select with no choices or the same choice twice", () => {
        expect(fieldInputSchema.safeParse({ label: "S", kind: "select", options: [] }).success).toBe(false);
        expect(
            fieldInputSchema.safeParse({ label: "S", kind: "select", options: ["Web", " web "] }).success
        ).toBe(false);
    });

    it("refuses an empty name and an unknown kind", () => {
        expect(fieldInputSchema.safeParse({ label: "   ", kind: "text" }).success).toBe(false);
        expect(fieldInputSchema.safeParse({ label: "S", kind: "rating" }).success).toBe(false);
    });
});

describe("slots", () => {
    it("keeps each kind in its family", () => {
        expect(slotFamily("number")).toBe("cNum");
        expect(slotFamily("date")).toBe("cDate");
        expect(slotFamily("boolean")).toBe("cBool");
        expect(slotFamily("select")).toBe("cText");
        expect(SLOTS).toHaveLength(25);
    });

    it("knows a slot key and nothing past the last one", () => {
        expect(slotOf("cText10")).toBe("cText");
        expect(slotOf("cNum6")).toBeNull();
        expect(slotOf("name")).toBeNull();
        expect(validStored("number", "cNum1")).toBe(true);
        expect(validStored("number", "cText1")).toBe(false);
    });

    it("maps a date slot to a day and the others to their column", () => {
        expect(columnOf("people", "cDate3")).toEqual({ type: "day", column: "cDate3" });
        expect(columnOf("people", "cNum1")).toEqual({ type: "scalar", column: "cNum1" });
    });

    it("reads every slot of a row", () => {
        const record = toRecord("companies", {
            id: "r1",
            position: 0,
            deletedAt: null,
            name: "Acme",
            cText1: "Web",
            cNum2: 4.5,
            cDate1: new Date("2026-03-04T00:00:00.000Z"),
            cBool1: true
        });
        expect(record.values.cText1).toBe("Web");
        expect(record.values.cNum2).toBe(4.5);
        expect(record.values.cDate1).toBe("2026-03-04");
        expect(record.values.cBool1).toBe(true);
    });
});

describe("custom fields in a list", () => {
    it("finds an added field only with the shelf's fields", () => {
        expect(fieldOf("companies", "cText1")).toBeUndefined();
        expect(fieldOf("companies", "cText1", [source])?.label).toBe("Source");
    });

    it("filters by a choice and by a decimal as typed", () => {
        const where = listWhere("companies", shelf, {
            custom: [source, score],
            filter: {
                conjunction: "and",
                rules: [
                    { id: "a", key: "cText1", operator: "isAnyOf", value: [{ id: "Web", name: "" }] },
                    { id: "b", key: "cNum2", operator: "greaterThan", value: 2.5 }
                ]
            }
        });
        expect(JSON.stringify(where)).toContain('"cText1":{"in":["Web"]}');
        expect(JSON.stringify(where)).toContain('"cNum2":{"gt":2.5}');
    });

    it("drops a rule on a field the shelf does not have", () => {
        const where = listWhere("companies", shelf, {
            filter: {
                conjunction: "and",
                rules: [{ id: "a", key: "cText1", operator: "isAnyOf", value: [{ id: "Web", name: "" }] }]
            }
        });
        expect(JSON.stringify(where)).not.toContain("cText1");
    });

    it("sorts an added number with its empty rows last", () => {
        expect(listOrder("companies", [{ key: "cNum2", direction: "desc" }])[0]).toEqual({
            cNum2: { sort: "desc", nulls: "last" }
        });
    });

    it("keeps a view's column for an added field and groups by an added choice", () => {
        const config = readConfig(
            "companies",
            { columns: [{ key: "name", width: 200, hidden: false, aggregate: null }, { key: "cText1", width: 170, hidden: false, aggregate: null }], groupBy: "cText1" },
            [source]
        );
        expect(config.columns.map((column) => column.key)).toContain("cText1");
        expect(config.groupBy).toBe("cText1");
        expect(readConfig("companies", { groupBy: "cText1" }).groupBy).toBeNull();
    });
});

describe("added values", () => {
    it("takes any decimal for an added number and an unset added choice", () => {
        expect(normalizeInput(score, "-12.345")).toEqual({ ok: true, value: -12.345 });
        expect(normalizeInput(source, "")).toEqual({ ok: true, value: "" });
        expect(normalizeInput(source, "Other").ok).toBe(false);
    });
});
