/**
 * A dashboard widget's shape: what it may count and split by, and how dates
 * fall into periods and running totals merge - the arithmetic a chart is only
 * as right as.
 */

import { describe, expect, it } from "vitest";
import * as model from "@polaris-app/crm/src/model/dashboards";

const base: model.Widget = {
    id: "0193b0f0-0000-7000-8000-000000000001",
    title: "",
    object: "opportunities",
    chart: "number",
    measure: "count",
    field: null,
    currency: null,
    groupBy: null,
    granularity: null,
    viewId: null,
    wide: false
};

describe("a widget's shape", () => {
    it("takes a count, or a sum of a number, split or not", () => {
        expect(model.widgetSchema.safeParse(base).success).toBe(true);
        expect(
            model.readWidget(
                {
                    ...base,
                    chart: "bar",
                    groupBy: "stage",
                    measure: "sum",
                    field: "amount",
                    currency: "EUR"
                },
                []
            )
        ).not.toBeNull();
    });

    it("refuses a figure without its number, or a chart without its split", () => {
        expect(model.widgetSchema.safeParse({ ...base, measure: "sum" }).success).toBe(false);
        expect(model.widgetSchema.safeParse({ ...base, field: "amount" }).success).toBe(false);
        expect(model.widgetSchema.safeParse({ ...base, chart: "bar" }).success).toBe(false);
        expect(model.widgetSchema.safeParse({ ...base, groupBy: "stage" }).success).toBe(false);
    });

    it("refuses a field that cannot be used that way", () => {
        // A name is not a number, a line needs a date, an amount needs its currency.
        expect(model.readWidget({ ...base, measure: "sum", field: "name" }, [])).toBeNull();
        expect(model.readWidget({ ...base, chart: "line", groupBy: "stage" }, [])).toBeNull();
        expect(model.readWidget({ ...base, measure: "sum", field: "amount" }, [])).toBeNull();
        expect(
            model.readWidget(
                { ...base, chart: "line", groupBy: "closeDate", granularity: null },
                []
            )
        ).toBeNull();
        expect(
            model.readWidget(
                { ...base, chart: "line", groupBy: "closeDate", granularity: "month" },
                []
            )
        ).not.toBeNull();
    });
});

describe("a weighted amount", () => {
    const weighted = { ...base, measure: "weighted" as const, field: "amount", currency: "EUR" };

    it("is offered on deals only, over an amount", () => {
        expect(model.measuresOf("opportunities")).toContain("weighted");
        expect(model.measuresOf("companies")).not.toContain("weighted");
        expect(model.readWidget(weighted, [])).not.toBeNull();
        expect(
            model.readWidget(
                { ...base, object: "companies", measure: "weighted", field: "employees" },
                []
            )
        ).toBeNull();
        const score = {
            key: "cNum1",
            kind: "rating" as const,
            width: 120,
            custom: true,
            label: "Score"
        };
        expect(
            model.readWidget({ ...base, measure: "weighted", field: "cNum1" }, [score])
        ).toBeNull();
        expect(model.measureFields("opportunities", [score], "weighted").map((f) => f.key)).toEqual(
            ["amount"]
        );
    });

    it("reads the sum it was handed, which was weighed where it was counted", () => {
        const tally = { count: 3, counted: 2, sum: 1200.004, min: null, max: null };
        expect(model.measureOf(tally, "weighted")).toBe(1200);
        expect(model.measureOf({ ...tally, counted: 0, sum: 0 }, "weighted")).toBeNull();
    });
});

describe("periods", () => {
    const day = new Date("2026-05-14T22:30:00Z");

    it("puts a day in the period it starts", () => {
        expect(model.bucketOf(day, "day")).toBe("2026-05-14");
        // Weeks start on Monday: the 14th is a Thursday.
        expect(model.bucketOf(day, "week")).toBe("2026-05-11");
        expect(model.bucketOf(day, "month")).toBe("2026-05-01");
        expect(model.bucketOf(day, "quarter")).toBe("2026-04-01");
        expect(model.bucketOf(day, "year")).toBe("2026-01-01");
    });

    it("fills the periods between, and gives up on a range too fine to draw", () => {
        expect(model.bucketRange("2026-11-01", "2027-02-01", "month")).toEqual([
            "2026-11-01",
            "2026-12-01",
            "2027-01-01",
            "2027-02-01"
        ]);
        expect(model.bucketRange("2020-01-01", "2026-01-01", "day")).toBeNull();
    });
});

describe("running totals", () => {
    it("merges into the right sum, average and extremes", () => {
        const a = { count: 3, counted: 2, sum: 10, min: 2, max: 8 };
        const b = { count: 2, counted: 2, sum: 30, min: 5, max: 25 };
        const both = model.addTally(a, b);
        expect(model.measureOf(both, "count")).toBe(5);
        expect(model.measureOf(both, "sum")).toBe(40);
        // The average of the numbers, not of the two averages.
        expect(model.measureOf(both, "avg")).toBe(10);
        expect(model.measureOf(both, "min")).toBe(2);
        expect(model.measureOf(both, "max")).toBe(25);
        expect(model.measureOf(model.EMPTY_TALLY, "avg")).toBeNull();
    });
});
