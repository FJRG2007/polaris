/**
 * Role rules as data: stored rows read back with anything unreadable left
 * open, a rule checked against the fields it names, and "own records" as the
 * clause that narrows a query to them.
 */

import { describe, expect, it } from "vitest";
import * as roles from "@polaris-app/crm/src/model/roles";

describe("readRules", () => {
    it("is open for every kind of record without rows", () => {
        expect(roles.readRules([])).toEqual(roles.OPEN_RULES);
    });

    it("reads a stored row and leaves unreadable parts open", () => {
        const rules = roles.readRules([
            { object: "companies", rows: "own", hidden: '["employees"]', readOnly: '["city"]' },
            { object: "people", rows: "bogus", hidden: "not json", readOnly: "[1]" },
            { object: "nothing", rows: "own", hidden: "[]", readOnly: "[]" }
        ]);
        expect(rules.companies).toEqual({ rows: "own", hidden: ["employees"], readOnly: ["city"] });
        expect(rules.people).toEqual(roles.OPEN_RULE);
        expect(rules.opportunities).toEqual(roles.OPEN_RULE);
    });
});

describe("checkRule", () => {
    it("keeps each key once and drops a hidden field from read-only", () => {
        expect(
            roles.checkRule("companies", {
                rows: "all",
                hidden: ["employees", "employees"],
                readOnly: ["employees", "city"]
            })
        ).toEqual({ ok: true, rule: { rows: "all", hidden: ["employees"], readOnly: ["city"] } });
    });

    it("refuses a field the record does not have, and the name field", () => {
        expect(
            roles.checkRule("companies", { rows: "all", hidden: ["nope"], readOnly: [] })
        ).toEqual({
            ok: false,
            reason: "unknownField"
        });
        expect(
            roles.checkRule("companies", { rows: "all", hidden: [], readOnly: ["name"] })
        ).toEqual({
            ok: false,
            reason: "nameLocked"
        });
    });

    it("accepts a field added on the shelf", () => {
        const custom = [{ key: "cText1", kind: "text", custom: true, label: "Tier" }] as never;
        expect(
            roles.checkRule("people", { rows: "own", hidden: ["cText1"], readOnly: [] }, custom).ok
        ).toBe(true);
    });
});

describe("ownWhere", () => {
    it("matches what the reader owns or made", () => {
        expect(roles.ownWhere("opportunities", "u1")).toEqual({
            OR: [{ ownerId: "u1" }, { createdById: "u1" }]
        });
        expect(roles.ownWhere("companies", "u1")).toEqual({
            OR: [{ accountOwnerId: "u1" }, { createdById: "u1" }]
        });
        expect(roles.ownWhere("people", "u1")).toEqual({ createdById: "u1" });
    });
});

describe("hideValues", () => {
    it("removes hidden values and leaves the rest", () => {
        const record = { id: "r1", position: 0, deletedAt: null, values: { name: "A", city: "B" } };
        expect(roles.hideValues(record as never, ["city"]).values).toEqual({ name: "A" });
        expect(roles.hideValues(record as never, [])).toBe(record);
    });
});

describe("filterKeys", () => {
    it("finds every field a filter names, in nested groups too", () => {
        expect(
            [
                ...roles.filterKeys({
                    conjunction: "and",
                    rules: [
                        { key: "city", operator: "is", value: "x" },
                        {
                            conjunction: "or",
                            rules: [{ key: "employees", operator: "gt", value: 1 }]
                        }
                    ]
                })
            ].sort()
        ).toEqual(["city", "employees"]);
    });
});
