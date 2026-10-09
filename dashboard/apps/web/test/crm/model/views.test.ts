/**
 * A stored view is read whole for today's fields, whatever was written: an
 * older layout, a field that has gone, a total a field cannot have.
 */

import { describe, expect, it } from "vitest";
import { FIELDS } from "@polaris-app/crm/src/model/objects";
import { aggregatesFor, defaultConfig, readConfig } from "@polaris-app/crm/src/model/views";

describe("readConfig", () => {
    it("answers the default for anything unreadable", () => {
        expect(readConfig("companies", null)).toEqual(defaultConfig("companies"));
        expect(readConfig("companies", "nonsense")).toEqual(defaultConfig("companies"));
        expect(readConfig("companies", { columns: [] })).toEqual(defaultConfig("companies"));
    });

    it("keeps stored order and widths, and adds new fields hidden at the end", () => {
        const config = readConfig("companies", {
            columns: [
                { key: "name", width: 300, hidden: false, aggregate: "countAll" },
                { key: "city", width: 120, hidden: false, aggregate: null }
            ],
            sorts: []
        });
        expect(config.columns.slice(0, 2)).toEqual([
            { key: "name", width: 300, hidden: false, aggregate: "countAll" },
            { key: "city", width: 120, hidden: false, aggregate: null }
        ]);
        expect(config.columns).toHaveLength(FIELDS.companies.length);
        expect(config.columns.slice(2).every((column) => column.hidden)).toBe(true);
    });

    it("drops gone fields, duplicates, impossible totals and unsortable sorts", () => {
        const config = readConfig("companies", {
            columns: [
                { key: "city", width: 120, hidden: false, aggregate: "sum" },
                { key: "gone", width: 120, hidden: false, aggregate: null },
                { key: "city", width: 200, hidden: true, aggregate: null },
                { key: "name", width: 200, hidden: true, aggregate: null }
            ],
            sorts: [
                { key: "accountOwner", direction: "asc" },
                { key: "name", direction: "desc" },
                { key: "name", direction: "asc" },
                { key: "gone", direction: "asc" }
            ]
        });
        // The name leads and cannot be hidden.
        expect(config.columns[0]).toMatchObject({ key: "name", hidden: false });
        expect(config.columns.filter((column) => column.key === "city")).toEqual([
            { key: "city", width: 120, hidden: false, aggregate: null }
        ]);
        expect(config.columns.some((column) => column.key === "gone")).toBe(false);
        expect(config.sorts).toEqual([{ key: "name", direction: "desc" }]);
    });

    it("refuses a width out of bounds", () => {
        const config = readConfig("people", {
            columns: [{ key: "name", width: 5000, hidden: false, aggregate: null }],
            sorts: []
        });
        expect(config).toEqual(defaultConfig("people"));
    });
});

describe("aggregatesFor", () => {
    it("offers sums for amounts, dates for days, and only counts elsewhere", () => {
        expect(aggregatesFor("currency")).toContain("sum");
        expect(aggregatesFor("text")).not.toContain("sum");
        expect(aggregatesFor("date")).toContain("earliest");
        expect(aggregatesFor("boolean")).toEqual(["countAll"]);
        expect(aggregatesFor("dateTime")).not.toContain("countEmpty");
    });
});
