/**
 * A view's filter is read whole for today's fields, keeps a rule somebody is
 * still writing, and counts only the rules that narrow anything.
 */

import { describe, expect, it } from "vitest";
import {
    activeRules,
    completeFilter,
    operatorsFor,
    readFilter,
    ruleComplete
} from "@polaris-app/crm/src/model/filters";

const rule = (key: string, operator: string, value: unknown, id = key) =>
    ({ id, key, operator, value }) as never;

describe("readFilter", () => {
    it("answers no filter for anything unreadable", () => {
        expect(readFilter("companies", null)).toEqual({ conjunction: "and", rules: [] });
        expect(readFilter("companies", { conjunction: "xor", rules: [] }).rules).toEqual([]);
    });

    it("drops rules on gone fields or with an operator the field does not have", () => {
        const filter = readFilter("companies", {
            conjunction: "or",
            rules: [
                rule("gone", "contains", "x"),
                rule("employees", "contains", "x"),
                rule("city", "contains", "Madrid")
            ]
        });
        expect(filter).toEqual({
            conjunction: "or",
            rules: [rule("city", "contains", "Madrid")]
        });
    });

    it("keeps a rule still being written, emptying a value its operator cannot use", () => {
        const filter = readFilter("opportunities", {
            conjunction: "and",
            rules: [rule("amount", "greaterThan", "a lot"), rule("closeDate", "before", "2026-13-40")]
        });
        expect(filter.rules).toEqual([
            rule("amount", "greaterThan", null),
            rule("closeDate", "before", null)
        ]);
    });

    it("keeps only a select's own options among its choices", () => {
        const filter = readFilter("opportunities", {
            conjunction: "and",
            rules: [
                rule("stage", "isAnyOf", [
                    { id: "proposal", name: "" },
                    { id: "lost", name: "" }
                ])
            ]
        });
        expect(filter.rules[0]).toMatchObject({ value: [{ id: "proposal", name: "" }] });
    });

    it("keeps only real ids among the people or records chosen", () => {
        const id = "22222222-2222-4222-8222-222222222222";
        const filter = readFilter("people", {
            conjunction: "and",
            rules: [rule("company", "isAnyOf", [{ id, name: "Acme" }, { id: "1 OR 1=1", name: "x" }])]
        });
        expect(filter.rules[0]).toMatchObject({ value: [{ id, name: "Acme" }] });
    });

    it("reads groups one level down and drops the empty ones", () => {
        const filter = readFilter("people", {
            conjunction: "and",
            rules: [
                { id: "g1", conjunction: "or", rules: [rule("city", "isEmpty", null)] },
                { id: "g2", conjunction: "or", rules: [rule("gone", "isEmpty", null)] }
            ]
        });
        expect(filter.rules).toEqual([
            { id: "g1", conjunction: "or", rules: [rule("city", "isEmpty", null)] }
        ]);
    });

    it("stops at thirty rules", () => {
        const many = Array.from({ length: 40 }, (_, index) =>
            rule("city", "isEmpty", null, `r${index}`)
        );
        expect(readFilter("people", { conjunction: "and", rules: many }).rules).toHaveLength(30);
    });
});

describe("ruleComplete and activeRules", () => {
    it("counts a rule once its value is there, and one with no value at once", () => {
        expect(ruleComplete("companies", rule("city", "contains", "  "))).toBe(false);
        expect(ruleComplete("companies", rule("city", "contains", "Ma"))).toBe(true);
        expect(ruleComplete("companies", rule("city", "isEmpty", null))).toBe(true);
        expect(ruleComplete("companies", rule("employees", "greaterThan", 10))).toBe(true);
        expect(ruleComplete("companies", rule("accountOwner", "isAnyOf", []))).toBe(false);
        const filter = readFilter("companies", {
            conjunction: "and",
            rules: [
                rule("city", "contains", ""),
                { id: "g", conjunction: "or", rules: [rule("idealCustomer", "isTrue", null)] }
            ]
        });
        expect(activeRules("companies", filter)).toBe(1);
        expect(completeFilter("companies", filter).rules).toEqual([
            { id: "g", conjunction: "or", rules: [rule("idealCustomer", "isTrue", null)] }
        ]);
    });

    it("offers no empty test on a field that is never empty", () => {
        expect(operatorsFor("select")).not.toContain("isEmpty");
        expect(operatorsFor("dateTime")).not.toContain("isEmpty");
        expect(operatorsFor("relation")).toContain("isEmpty");
    });
});
