/**
 * The amount kind a field somebody adds can be: a number in one currency the
 * field is made with - what it takes, how it reads, filters, totals, imports
 * and exports.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: { Decimal: class {} } }));

import { csvValue } from "@polaris-app/crm/src/model/csv";
import { cellInput } from "@polaris-app/crm/src/model/import";
import { filterWhere } from "@polaris-app/crm/src/lib/filters";
import { plainText } from "@polaris-app/crm/src/screens/format";
import { aggregatesFor } from "@polaris-app/crm/src/model/views";
import { operatorsFor } from "@polaris-app/crm/src/model/filters";
import { normalizeInput } from "@polaris-app/crm/src/model/values";
import { totalText } from "@polaris-app/crm/src/screens/totals-row";
import { createDisplayFormat, DISPLAY_DEFAULTS } from "@polaris/core";
import { slotFamily, type FieldDef } from "@polaris-app/crm/src/model/objects";
import { measurable, readWidget } from "@polaris-app/crm/src/model/dashboards";
import { customDef, fieldInputSchema } from "@polaris-app/crm/src/model/fields";

const budget: FieldDef = customDef({
    id: "f1",
    slot: "cNum1",
    label: "Budget",
    kind: "money",
    options: ["USD"]
});
const format = createDisplayFormat(DISPLAY_DEFAULTS);

describe("an amount field", () => {
    it("is made with one known currency, kept as its only option", () => {
        const parse = (options: string[]) =>
            fieldInputSchema.safeParse({ label: "Budget", kind: "money", options });
        expect(parse(["USD"]).data?.options).toEqual(["USD"]);
        for (const wrong of [[], ["XYZ"], ["usd"], ["USD", "EUR"]]) {
            expect(parse(wrong).success).toBe(false);
        }
        expect(budget.options).toEqual(["USD"]);
        expect(slotFamily("money")).toBe("cNum");
    });

    it("keeps an amount to the cent, or nothing", () => {
        expect(normalizeInput(budget, 1200.456)).toEqual({ ok: true, value: 1200.46 });
        expect(normalizeInput(budget, " -3.5 ")).toEqual({ ok: true, value: -3.5 });
        expect(normalizeInput(budget, null)).toEqual({ ok: true, value: null });
        expect(normalizeInput(budget, "")).toEqual({ ok: true, value: null });
        for (const wrong of ["lots", true, Number.NaN, 1e15]) {
            expect(normalizeInput(budget, wrong)).toEqual({ ok: false, reason: "number" });
        }
    });

    it("reads in its currency, in the reader's language", () => {
        expect(plainText(budget, 1200.5, format, "en-US")).toBe("$1,200.50");
        // Intl separates the symbol with a no-break space.
        expect(plainText(budget, 1200.5, format, "es-ES").replace(/\s/g, " ")).toBe("1200,50 US$");
        expect(plainText(budget, null, format, "en-US")).toBe("");
    });

    it("filters and totals as a number", () => {
        expect(operatorsFor("money")).toContain("greaterThan");
        expect(aggregatesFor("money")).toEqual(expect.arrayContaining(["sum", "avg"]));
        expect(
            filterWhere(
                "companies",
                {
                    conjunction: "and",
                    rules: [{ id: "r", key: "cNum1", operator: "lessThan", value: 99.5 }]
                },
                [budget]
            )
        ).toEqual({ cNum1: { lt: 99.5 } });
        expect(
            totalText(budget, { key: "cNum1", aggregate: "sum", value: 2400 }, format, "en-US")
        ).toBe("$2,400.00");
        // A count is a count, not dollars.
        expect(
            totalText(budget, { key: "cNum1", aggregate: "countAll", value: 3 }, format, "en-US")
        ).toBe("3");
    });

    it("is measured by a dashboard without a currency of its own", () => {
        expect(measurable(budget)).toBe(true);
        const widget = {
            id: "w1",
            title: "",
            object: "companies",
            chart: "number",
            field: "cNum1",
            measure: "sum",
            currency: null,
            groupBy: null,
            granularity: null
        } as const;
        expect(readWidget(widget as never, [budget])).not.toBeNull();
        expect(readWidget({ ...widget, currency: "USD" } as never, [budget])).toBeNull();
    });

    it("exports with its code and imports it back, refusing another currency", () => {
        expect(csvValue(budget, 1200.5)).toBe("1200.5 USD");
        expect(cellInput(budget, "1200.5 USD")).toBe(1200.5);
        expect(cellInput(budget, "usd 1,200.50")).toBe(1200.5);
        expect(cellInput(budget, "1200.5")).toBe(1200.5);
        expect(cellInput(budget, "")).toBeNull();
        expect(cellInput(budget, "1200.5 EUR")).toBe("1200.5 EUR");
        expect(normalizeInput(budget, cellInput(budget, "1200.5 EUR")).ok).toBe(false);
    });
});
