/**
 * The calendar an admin edits: the shipped windows as the fallback, overrides
 * read season by season, switched-off seasons, windows across the year end,
 * the shared schema and the overlap rule.
 */

import { describe, expect, it } from "vitest";
import * as seasons from "../src/seasons.js";

const on = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12);

const md = (month: number, day: number) => ({ month, day });

function withRule(
    season: seasons.Season,
    rule: Partial<seasons.SeasonRule>
): seasons.SeasonCalendar {
    return {
        ...seasons.DEFAULT_SEASON_CALENDAR,
        [season]: { ...seasons.DEFAULT_SEASON_CALENDAR[season], ...rule }
    };
}

describe("resolving the calendar", () => {
    it("is the shipped calendar when nothing is stored", () => {
        expect(seasons.resolveSeasonCalendar(seasons.parseSeasonOverrides(null))).toEqual(
            seasons.DEFAULT_SEASON_CALENDAR
        );
        expect(seasons.resolveSeasonCalendar(seasons.parseSeasonOverrides("not json"))).toEqual(
            seasons.DEFAULT_SEASON_CALENDAR
        );
    });

    it("takes an override over the default and leaves the other seasons alone", () => {
        const stored = {
            halloween: { from: md(10, 20), to: md(11, 1) },
            winter: { enabled: false }
        };
        const calendar = seasons.resolveSeasonCalendar(
            seasons.parseSeasonOverrides(JSON.stringify(stored))
        );
        expect(calendar.halloween).toEqual({
            enabled: true,
            window: { from: md(10, 20), to: md(11, 1) }
        });
        expect(calendar.winter.enabled).toBe(false);
        expect(calendar.winter.window).toEqual(seasons.DEFAULT_SEASON_CALENDAR.winter.window);
        expect(calendar.newYear).toEqual(seasons.DEFAULT_SEASON_CALENDAR.newYear);
    });

    it("drops a broken season's override without losing the others", () => {
        const overrides = seasons.parseSeasonOverrides(
            JSON.stringify({
                halloween: { from: md(2, 30), to: md(3, 1) },
                winter: { from: md(12, 5) },
                newYear: "nonsense",
                lunarNewYear: { enabled: false }
            })
        );
        const calendar = seasons.resolveSeasonCalendar(overrides);
        expect(calendar.halloween).toEqual(seasons.DEFAULT_SEASON_CALENDAR.halloween);
        expect(calendar.winter).toEqual(seasons.DEFAULT_SEASON_CALENDAR.winter);
        expect(calendar.newYear).toEqual(seasons.DEFAULT_SEASON_CALENDAR.newYear);
        expect(calendar.lunarNewYear.enabled).toBe(false);
    });

    it("stores only what differs from the defaults", () => {
        expect(
            seasons.overrideOf("halloween", seasons.DEFAULT_SEASON_CALENDAR.halloween)
        ).toBeNull();
        expect(
            seasons.overrideOf("winter", {
                ...seasons.DEFAULT_SEASON_CALENDAR.winter,
                enabled: false
            })
        ).toEqual({
            enabled: false
        });
        expect(
            seasons.overrideOf("halloween", {
                enabled: true,
                window: { from: md(10, 1), to: md(10, 31) }
            })
        ).toEqual({ from: md(10, 1), to: md(10, 31) });
    });
});

describe("deciding the season by a calendar", () => {
    it("follows a moved window", () => {
        const calendar = withRule("halloween", { window: { from: md(10, 25), to: md(11, 5) } });
        expect(seasons.seasonOn(on(2026, 10, 7), calendar)).toBeNull();
        expect(seasons.seasonOn(on(2026, 10, 25), calendar)).toBe("halloween");
        expect(seasons.seasonOn(on(2026, 11, 5), calendar)).toBe("halloween");
        expect(seasons.seasonOn(on(2026, 11, 6), calendar)).toBeNull();
        expect(seasons.seasonLastDay(on(2026, 10, 30), calendar)?.getDate()).toBe(5);
    });

    it("never shows a season that is switched off", () => {
        const calendar = withRule("halloween", { enabled: false });
        expect(seasons.seasonOn(on(2026, 10, 31), calendar)).toBeNull();
        expect(seasons.packOn(on(2026, 10, 31), calendar)).toBeNull();
        expect(seasons.nextSeason(on(2026, 10, 1), calendar)?.season).toBe("winter");
    });

    it("keeps New Year when winter is off, and winter when New Year is", () => {
        const noWinter = withRule("winter", { enabled: false });
        expect(seasons.seasonOn(on(2026, 12, 20), noWinter)).toBeNull();
        expect(seasons.seasonOn(on(2026, 12, 31), noWinter)).toBe("newYear");
        const noNewYear = withRule("newYear", { enabled: false });
        expect(seasons.seasonOn(on(2026, 12, 31), noNewYear)).toBe("winter");
        expect(seasons.seasonOn(on(2027, 1, 1), noNewYear)).toBe("winter");
    });

    it("runs a window across the year end, naming the run after the year it began", () => {
        const calendar = withRule("winter", { window: { from: md(11, 20), to: md(1, 20) } });
        expect(seasons.seasonOn(on(2026, 11, 20), calendar)).toBe("winter");
        expect(seasons.seasonOn(on(2027, 1, 20), calendar)).toBe("winter");
        expect(seasons.seasonOn(on(2027, 1, 21), calendar)).toBeNull();
        expect(seasons.packOn(on(2026, 11, 25), calendar)).toBe("winter-2026");
        expect(seasons.packOn(on(2027, 1, 15), calendar)).toBe("winter-2026");
        // New Year's days inside it belong to the same run.
        expect(seasons.packOn(on(2027, 1, 1), calendar)).toBe("winter-2026");
        const last = seasons.packLastDay(on(2026, 12, 1), calendar);
        expect([last?.getFullYear(), last?.getMonth(), last?.getDate()]).toEqual([2027, 0, 20]);
    });

    it("reads a moved lunar window in lunar months", () => {
        // 2026's first lunar month starts on 17 February: days 1-3 are 17-19 February.
        const calendar = withRule("lunarNewYear", { window: { from: md(1, 1), to: md(1, 3) } });
        expect(seasons.seasonOn(on(2026, 2, 17), calendar)).toBe("lunarNewYear");
        expect(seasons.seasonOn(on(2026, 2, 19), calendar)).toBe("lunarNewYear");
        expect(seasons.seasonOn(on(2026, 2, 20), calendar)).toBeNull();
    });
});

describe("the rule an admin sends", () => {
    it("accepts a real window and refuses a day its month does not have", () => {
        const halloween = seasons.seasonRuleSchema("halloween");
        expect(halloween.safeParse({ enabled: true, from: md(2, 29), to: md(3, 1) }).success).toBe(
            true
        );
        const bad = halloween.safeParse({ enabled: true, from: md(4, 31), to: md(5, 1) });
        expect(bad.success).toBe(false);
        expect(bad.error?.issues[0]).toMatchObject({
            path: ["from", "day"],
            message: "dayOutOfMonth"
        });
        // A lunar month has 30 days, whichever it is.
        const lunar = seasons.seasonRuleSchema("lunarNewYear");
        expect(lunar.safeParse({ enabled: true, from: md(2, 30), to: md(3, 1) }).success).toBe(
            true
        );
    });

    it("refuses anything else", () => {
        const schema = seasons.seasonRuleSchema("winter");
        expect(schema.safeParse({ enabled: true, from: md(13, 1), to: md(1, 1) }).success).toBe(
            false
        );
        expect(schema.safeParse({ enabled: "yes", from: md(1, 1), to: md(1, 2) }).success).toBe(
            false
        );
        expect(
            schema.safeParse({ enabled: true, from: md(1, 1), to: md(1, 2), extra: 1 }).success
        ).toBe(false);
    });
});

describe("overlaps", () => {
    it("has none in the shipped calendar: New Year sits inside winter by design", () => {
        for (const season of seasons.SEASONS)
            expect(seasons.seasonOverlaps(seasons.DEFAULT_SEASON_CALENDAR, season)).toEqual([]);
    });

    it("names the season a moved window runs into", () => {
        const into = withRule("halloween", { window: { from: md(10, 7), to: md(12, 3) } });
        expect(seasons.seasonOverlaps(into, "halloween")).toEqual(["winter"]);
        const newYear = withRule("newYear", { window: { from: md(11, 1), to: md(11, 2) } });
        expect(seasons.seasonOverlaps(newYear, "newYear")).toEqual(["halloween"]);
    });

    it("ignores a season that is switched off", () => {
        const calendar = {
            ...withRule("halloween", { window: { from: md(10, 7), to: md(12, 3) } }),
            winter: { ...seasons.DEFAULT_SEASON_CALENDAR.winter, enabled: false }
        };
        expect(seasons.seasonOverlaps(calendar, "halloween")).toEqual([]);
    });
});
