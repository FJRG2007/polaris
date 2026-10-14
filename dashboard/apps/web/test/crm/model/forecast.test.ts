/**
 * The forecast's arithmetic: periods from today, open deals weighed by their
 * stage's odds, won ones in full, past-due and undated open deals apart, and
 * currencies never added together.
 */

import { describe, expect, it } from "vitest";
import * as model from "@polaris-app/crm/src/model/forecast";

const day = (text: string) => new Date(`${text}T00:00:00Z`);
const row = (
    closeDate: string | null,
    stage: string,
    amount: number | null,
    currency = "EUR",
    deals = 1
): model.ForecastRow => ({
    closeDate: closeDate ? day(closeDate) : null,
    stage,
    currency: amount === null ? "" : currency,
    deals,
    amount
});

describe("forecastRange", () => {
    it("starts at the current month and runs the asked number of periods", () => {
        expect(model.forecastRange(day("2026-10-13"), "month", 3)).toEqual({
            starts: ["2026-10-01", "2026-11-01", "2026-12-01"],
            end: "2027-01-01"
        });
    });

    it("starts at the current quarter", () => {
        expect(model.forecastRange(day("2026-11-30"), "quarter", 2)).toEqual({
            starts: ["2026-10-01", "2027-01-01"],
            end: "2027-04-01"
        });
    });
});

describe("readOdds", () => {
    it("fills what is missing or unreadable with the defaults", () => {
        expect(model.readOdds({ new: 5, proposal: 140, meeting: "x" })).toEqual({
            ...model.DEFAULT_ODDS,
            new: 5
        });
        expect(model.readOdds(null)).toEqual(model.DEFAULT_ODDS);
    });

    it("takes no odds for the won stage", () => {
        expect(model.oddsSchema.safeParse({ ...model.DEFAULT_ODDS, customer: 100 }).success).toBe(
            false
        );
        expect(model.oddsSchema.safeParse(model.DEFAULT_ODDS).success).toBe(true);
        expect(model.oddsSchema.safeParse({ ...model.DEFAULT_ODDS, new: 1.5 }).success).toBe(false);
    });

    it("keeps odds saved before deals could be lost, and takes none for the lost stage", () => {
        const saved = { new: 15, screening: 25, meeting: 45, proposal: 70 };
        expect(model.readOdds(saved)).toEqual(saved);
        expect(model.oddsSchema.safeParse(saved).success).toBe(true);
        expect(model.oddsSchema.safeParse({ ...saved, lost: 0 }).success).toBe(false);
    });
});

describe("buildForecast", () => {
    const range = model.forecastRange(day("2026-10-13"), "month", 2);
    const odds = model.DEFAULT_ODDS;

    it("weighs open deals by their stage and counts won ones in full", () => {
        const result = model.buildForecast(
            [
                row("2026-10-20", "proposal", 1000),
                row("2026-10-25", "customer", 500),
                row("2026-11-02", "new", 2000, "EUR", 3)
            ],
            odds,
            range,
            "month"
        );
        expect(result.periods.map((period) => period.key)).toEqual(["2026-10-01", "2026-11-01"]);
        expect(result.periods[0]).toEqual({
            key: "2026-10-01",
            deals: 2,
            wonDeals: 1,
            money: { EUR: { won: 500, open: 1000, expected: 1100 } }
        });
        expect(result.periods[1]!.money.EUR).toEqual({ won: 0, open: 2000, expected: 200 });
        expect(model.totalOf(result.periods, "EUR")).toEqual({
            won: 500,
            open: 3000,
            expected: 1300
        });
    });

    it("keeps past-due and undated open deals apart, and drops won ones outside the range", () => {
        const result = model.buildForecast(
            [
                row("2026-09-30", "meeting", 100),
                row("2026-09-30", "customer", 900),
                row(null, "screening", 50),
                row(null, "customer", 70),
                row("2027-01-01", "customer", 1)
            ],
            odds,
            range,
            "month"
        );
        expect(result.pastDue).toMatchObject({
            deals: 1,
            money: { EUR: { open: 100, expected: 40 } }
        });
        expect(result.undated).toMatchObject({
            deals: 1,
            money: { EUR: { open: 50, expected: 10 } }
        });
        expect(result.periods.every((period) => period.deals === 0)).toBe(true);
    });

    it("never adds currencies together and lists the most used first", () => {
        const result = model.buildForecast(
            [
                row("2026-10-02", "proposal", 100, "USD"),
                row("2026-10-03", "proposal", 100, "EUR", 2),
                row("2026-10-04", "new", null)
            ],
            odds,
            range,
            "month"
        );
        expect(result.currencies).toEqual(["EUR", "USD"]);
        expect(result.periods[0]!.deals).toBe(4);
        expect(result.periods[0]!.money).toEqual({
            EUR: { won: 0, open: 100, expected: 60 },
            USD: { won: 0, open: 100, expected: 60 }
        });
    });
});
