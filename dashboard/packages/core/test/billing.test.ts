import * as billing from "../src/billing.js";
import { describe, expect, it } from "vitest";
import * as schemas from "../src/schemas/billing.js";

const GB = 1024 ** 3;
const CADENCE = { appSampleMinutes: 1, volumeSampleMinutes: 5 };

/** One hour of a service, with the fields a test does not care about empty. */
function appHour(partial: Partial<billing.UsageHour>): billing.UsageHour {
    return {
        subjectType: "app",
        subjectId: "a1",
        cpuPercentAvg: null,
        memUsedBytesAvg: null,
        diskUsedBytesAvg: null,
        netTxBytesSum: null,
        samples: 60,
        ...partial
    };
}

const RATES: schemas.BillingRates = {
    currency: "EUR",
    cpuHour: 0.02,
    memoryGbHour: 0.005,
    storageGbMonth: 0.1,
    egressGb: 0.05
};

describe("months", () => {
    it("runs a month from its first UTC instant to the next month's", () => {
        const range = billing.billingMonthRange("2026-02");
        expect(range?.from.toISOString()).toBe("2026-02-01T00:00:00.000Z");
        expect(range?.to.toISOString()).toBe("2026-03-01T00:00:00.000Z");
        expect(billing.hoursInMonth("2026-02")).toBe(28 * 24);
        expect(billing.hoursInMonth("2024-02")).toBe(29 * 24);
    });

    it("crosses a year", () => {
        expect(billing.billingMonthRange("2026-12")?.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
        expect(billing.billingMonthOf(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
    });

    it("refuses what is not a month", () => {
        expect(billing.billingMonthRange("2026-13")).toBeNull();
        expect(billing.billingMonthRange("2026-9")).toBeNull();
        expect(billing.hoursInMonth("soon")).toBe(0);
    });

    it("names a month without the runtime's locale", () => {
        expect(billing.billingMonthLabel("2026-09")).toBe("September 2026");
    });

    it("offers only the months that still have figures kept", () => {
        const now = new Date("2026-09-10T12:00:00Z");
        const ninetyDays = 90 * 24 * 3_600_000;
        // The oldest kept hour is 2026-06-12, so June still has some and May none.
        expect(billing.billingMonthsOffered(now, ninetyDays)).toEqual(["2026-09", "2026-08", "2026-07", "2026-06"]);
        expect(billing.billingMonthsOffered(now, 0)).toEqual(["2026-09"]);
    });
});

describe("metering an hour", () => {
    it("turns a share of the machine into cores", () => {
        // A quarter of an eight-core machine for the whole hour is two vCPU-hours.
        const usage = billing.meterHour(appHour({ cpuPercentAvg: 25 }), 8, CADENCE);
        expect(usage.cpuHours).toBeCloseTo(2);
        expect(usage.cpuUnmeasuredHours).toBe(0);
    });

    it("counts only the part of the hour the service was running", () => {
        const usage = billing.meterHour(
            appHour({ cpuPercentAvg: 50, memUsedBytesAvg: 2 * GB, samples: 15 }),
            4,
            CADENCE
        );
        // Fifteen readings a minute apart is a quarter of an hour.
        expect(usage.cpuHours).toBeCloseTo(0.5);
        expect(usage.memoryGbHours).toBeCloseTo(0.5);
    });

    it("never counts more than the hour", () => {
        const usage = billing.meterHour(appHour({ memUsedBytesAvg: GB, samples: 75 }), 1, CADENCE);
        expect(usage.memoryGbHours).toBeCloseTo(1);
    });

    it("leaves CPU unmeasured, not guessed, when the machine's cores are unknown", () => {
        const usage = billing.meterHour(appHour({ cpuPercentAvg: 30, samples: 30 }), null, CADENCE);
        expect(usage.cpuHours).toBe(0);
        expect(usage.cpuUnmeasuredHours).toBeCloseTo(0.5);
    });

    it("takes network out as the bytes the hour sent", () => {
        const usage = billing.meterHour(appHour({ netTxBytesSum: 3 * GB, samples: 10 }), 2, CADENCE);
        expect(usage.egressGb).toBeCloseTo(3);
    });

    it("reads a volume on its own, slower cadence", () => {
        const volume = appHour({ subjectType: "volume", diskUsedBytesAvg: 10 * GB, samples: 12 });
        const usage = billing.meterHour(volume, null, CADENCE);
        expect(usage.storageGbHours).toBeCloseTo(10);
        expect(usage.cpuHours).toBe(0);
        expect(usage.memoryGbHours).toBe(0);
    });

    it("ignores a reading that is not a real amount", () => {
        const usage = billing.meterHour(appHour({ cpuPercentAvg: -5, memUsedBytesAvg: Number.NaN }), 4, CADENCE);
        expect(usage).toEqual(billing.EMPTY_USAGE);
    });
});

describe("pricing", () => {
    it("multiplies each measure by its price, and a GB-month by the month's hours", () => {
        const usage: billing.BillingUsage = {
            cpuHours: 100,
            memoryGbHours: 1000,
            // 10 GB held for the whole of a 30-day month is 10 GB-months.
            storageGbHours: 10 * 720,
            egressGb: 20,
            cpuUnmeasuredHours: 0
        };
        const cost = billing.priceUsage(usage, RATES, "2026-09");
        expect(cost).toEqual({ cpu: 2, memory: 5, storage: 1, egress: 1, total: 9 });
    });

    it("charges nothing for a measure that has no price, and says so", () => {
        const cost = billing.priceUsage(
            { ...billing.EMPTY_USAGE, cpuHours: 10, egressGb: 5 },
            { ...RATES, egressGb: null },
            "2026-09"
        );
        expect(cost.egress).toBeNull();
        expect(cost.total).toBe(0.2);
    });

    it("rounds each part to the currency, and totals the rounded parts", () => {
        const cost = billing.priceUsage(
            { ...billing.EMPTY_USAGE, cpuHours: 0.25, memoryGbHours: 0.25 },
            { ...RATES, cpuHour: 0.018, memoryGbHour: 0.018 },
            "2026-09"
        );
        // 0.0045 each rounds to 0.00; the total is the sum of what is shown.
        expect(cost.cpu).toBe(0);
        expect(cost.total).toBe(0);
        expect(billing.roundMoney(1.005, "EUR")).toBe(1.01);
    });

    it("writes the yen with no minor unit", () => {
        expect(billing.currencyDigits("JPY")).toBe(0);
        expect(billing.currencyDigits("EUR")).toBe(2);
        expect(billing.roundMoney(12.6, "JPY")).toBe(13);
    });
});

describe("a statement", () => {
    const org: billing.BillingOwner = { kind: "org", id: "o1", name: "Acme", handle: "acme" };
    const person: billing.BillingOwner = { kind: "user", id: "u1", name: "Ana", handle: "ana" };
    const projects: billing.MeteredProject[] = [
        { projectId: "p1", projectName: "Site", owner: org, usage: { ...billing.EMPTY_USAGE, cpuHours: 50 } },
        { projectId: "p2", projectName: "Api", owner: org, usage: { ...billing.EMPTY_USAGE, cpuHours: 150 } },
        { projectId: "p3", projectName: "Blog", owner: person, usage: { ...billing.EMPTY_USAGE, cpuHours: 25 } }
    ];

    it("prices each project, heaviest first, and totals them per owner and overall", () => {
        const statement = billing.buildStatement("2026-09", projects, RATES);
        expect(statement.lines.map((line) => line.projectId)).toEqual(["p2", "p1", "p3"]);
        expect(statement.lines[0]?.cost?.total).toBe(3);
        expect(statement.owners.map((entry) => [entry.owner.name, entry.projects, entry.cost?.total])).toEqual([
            ["Acme", 2, 4],
            ["Ana", 1, 0.5]
        ]);
        expect(statement.cost?.total).toBe(4.5);
        expect(statement.usage.cpuHours).toBe(225);
    });

    it("is usage without money when no prices are set", () => {
        const statement = billing.buildStatement("2026-09", projects, null);
        expect(statement.cost).toBeNull();
        expect(statement.lines.every((line) => line.cost === null)).toBe(true);
        expect(statement.owners.every((entry) => entry.cost === null)).toBe(true);
        expect(statement.lines[0]?.projectId).toBe("p2");
    });

    it("totals zero, not nothing, when there are prices and no projects", () => {
        const statement = billing.buildStatement("2026-09", [], RATES);
        expect(statement.cost?.total).toBe(0);
        expect(statement.lines).toEqual([]);
    });
});

describe("budgets", () => {
    it("reads the highest threshold a spend has reached", () => {
        expect(billing.budgetLevel(79.99, 100)).toBe(0);
        expect(billing.budgetLevel(80, 100)).toBe(80);
        expect(billing.budgetLevel(100, 100)).toBe(100);
        expect(billing.budgetLevel(250, 100)).toBe(100);
        expect(billing.budgetLevel(50, 0)).toBe(0);
    });

    it("announces each threshold once a month", () => {
        const month = "2026-09";
        expect(billing.budgetAlertDue({ spent: 85, budget: 100, month, alertedMonth: null, alertedLevel: 0 })).toBe(80);
        expect(billing.budgetAlertDue({ spent: 90, budget: 100, month, alertedMonth: month, alertedLevel: 80 })).toBeNull();
        expect(billing.budgetAlertDue({ spent: 101, budget: 100, month, alertedMonth: month, alertedLevel: 80 })).toBe(100);
        expect(
            billing.budgetAlertDue({ spent: 150, budget: 100, month, alertedMonth: month, alertedLevel: 100 })
        ).toBeNull();
    });

    it("tells a spend that jumps past both only the higher one", () => {
        expect(billing.budgetAlertDue({ spent: 120, budget: 100, month: "2026-09", alertedMonth: null, alertedLevel: 0 })).toBe(
            100
        );
    });

    it("starts every month with nothing announced", () => {
        expect(
            billing.budgetAlertDue({ spent: 85, budget: 100, month: "2026-10", alertedMonth: "2026-09", alertedLevel: 100 })
        ).toBe(80);
    });

    it("says nothing below the first threshold", () => {
        expect(billing.budgetAlertDue({ spent: 10, budget: 100, month: "2026-09", alertedMonth: null, alertedLevel: 0 })).toBeNull();
    });
});

describe("what people type", () => {
    it("normalizes an amount once, the same way on both sides", () => {
        expect(schemas.normalizeAmount(" 0,012 ")).toBe("0.012");
        expect(schemas.normalizeAmount("1,250.50")).toBe("1250.50");
        expect(schemas.normalizeAmount("1 000")).toBe("1000");
        expect(schemas.normalizeAmount("")).toBe("");
    });

    it("leaves a comma after the point as typed, so the amount is refused", () => {
        expect(schemas.normalizeAmount("1.250,00")).toBe("1.250,00");
        expect(schemas.orgBudgetInputSchema.safeParse({ amount: "1.250,00" }).success).toBe(false);
        expect(schemas.orgBudgetInputSchema.parse({ amount: "1,250.00" })).toEqual({ amount: 1250 });
    });

    it("takes a price card with blanks for what is not charged", () => {
        const parsed = schemas.billingRatesInputSchema.parse({
            currency: "USD",
            cpuHour: "0,02",
            memoryGbHour: "",
            storageGbMonth: "0.1",
            egressGb: "  "
        });
        expect(parsed).toEqual({ currency: "USD", cpuHour: 0.02, memoryGbHour: null, storageGbMonth: 0.1, egressGb: null });
    });

    it("refuses a card that charges for nothing, a currency off the list, and a word", () => {
        const blank = { currency: "EUR", cpuHour: "", memoryGbHour: "", storageGbMonth: "", egressGb: "" };
        expect(schemas.billingRatesInputSchema.safeParse(blank).success).toBe(false);
        expect(schemas.billingRatesInputSchema.safeParse({ ...blank, currency: "XYZ", cpuHour: "1" }).success).toBe(false);
        expect(schemas.billingRatesInputSchema.safeParse({ ...blank, cpuHour: "cheap" }).success).toBe(false);
        expect(schemas.billingRatesInputSchema.safeParse({ ...blank, cpuHour: "-1" }).success).toBe(false);
    });

    it("takes a budget above zero and nothing else", () => {
        expect(schemas.orgBudgetInputSchema.parse({ amount: "1500,5" })).toEqual({ amount: 1500.5 });
        expect(schemas.orgBudgetInputSchema.safeParse({ amount: "0" }).success).toBe(false);
        expect(schemas.orgBudgetInputSchema.safeParse({ amount: "" }).success).toBe(false);
        expect(schemas.orgBudgetInputSchema.safeParse({ amount: "2e9" }).success).toBe(false);
    });

    it("reads stored prices back, and anything unreadable as none", () => {
        expect(schemas.storedBillingRates(JSON.stringify(RATES))).toEqual(RATES);
        expect(schemas.storedBillingRates(null)).toBeNull();
        expect(schemas.storedBillingRates("{not json")).toBeNull();
        expect(schemas.storedBillingRates(JSON.stringify({ ...RATES, currency: "XYZ" }))).toBeNull();
        expect(
            schemas.storedBillingRates(
                JSON.stringify({ currency: "EUR", cpuHour: null, memoryGbHour: null, storageGbMonth: null, egressGb: null })
            )
        ).toBeNull();
    });

    it("reads a month and an export format from a query", () => {
        expect(schemas.billingExportQuerySchema.parse({ month: "2026-09" })).toEqual({ month: "2026-09", format: "csv" });
        expect(schemas.billingExportQuerySchema.safeParse({ month: "2026-9", format: "csv" }).success).toBe(false);
        expect(schemas.billingExportQuerySchema.safeParse({ format: "xlsx" }).success).toBe(false);
    });
});
