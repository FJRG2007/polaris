/**
 * A record's activity: which fields an edit changed, what a new record was
 * made with, and a stored log read back without trusting its shape.
 */

import { describe, expect, it } from "vitest";
import type { CrmRecord } from "@polaris-app/crm/src/model/objects";
import {
    changesBetween,
    initialValues,
    MAX_CHANGES,
    readChanges,
    sameValue
} from "@polaris-app/crm/src/model/timeline";

const record = (values: CrmRecord["values"]): CrmRecord => ({
    id: "r1",
    position: 0,
    deletedAt: null,
    values
});

describe("record activity", () => {
    it("keeps only the fields whose value changed, in the order asked", () => {
        const before = record({ name: "Acme", city: "Madrid", employees: 10 });
        const after = record({ name: "Acme", city: "Lisbon", employees: 12 });
        expect(changesBetween(before, after, ["employees", "name", "city", "city"])).toEqual([
            { key: "employees", before: 10, after: 12 },
            { key: "city", before: "Madrid", after: "Lisbon" }
        ]);
    });

    it("compares a reference by the record it points at, not its name", () => {
        expect(sameValue({ id: "c1", name: "Acme" }, { id: "c1", name: "Acme Inc" })).toBe(true);
        expect(sameValue({ id: "c1", name: "Acme" }, { id: "c2", name: "Acme" })).toBe(false);
        expect(sameValue({ amount: 5, currency: "EUR" }, { amount: 5, currency: "USD" })).toBe(
            false
        );
        expect(sameValue({ first: "Ada", last: "L" }, { first: "Ada", last: "L" })).toBe(true);
        expect(sameValue(null, undefined)).toBe(true);
        expect(sameValue("", null)).toBe(false);
    });

    it("lists what a new record was made with, leaving out empty fields", () => {
        const made = record({ name: "Acme", city: "", idealCustomer: false, employees: 3 });
        expect(initialValues(made, ["name", "city", "idealCustomer", "employees"])).toEqual([
            { key: "name", before: null, after: "Acme" },
            { key: "employees", before: null, after: 3 }
        ]);
    });

    it("bounds how many changes one event keeps", () => {
        const keys = Array.from({ length: MAX_CHANGES + 10 }, (_, at) => `k${at}`);
        const after = record(Object.fromEntries(keys.map((key) => [key, 1])));
        expect(changesBetween(record({}), after, keys)).toHaveLength(MAX_CHANGES);
    });

    it("reads back only entries shaped like a change", () => {
        const stored = JSON.stringify([
            { key: "city", before: "Madrid", after: "Lisbon" },
            { key: "company", before: null, after: { id: "c1", name: "Acme" } },
            { key: "", before: 1, after: 2 },
            { key: "x", before: { evil: true }, after: 1 },
            "nonsense"
        ]);
        expect(readChanges(stored)).toEqual([
            { key: "city", before: "Madrid", after: "Lisbon" },
            { key: "company", before: null, after: { id: "c1", name: "Acme" } }
        ]);
        expect(readChanges("not json")).toEqual([]);
        expect(readChanges("{}")).toEqual([]);
    });
});
