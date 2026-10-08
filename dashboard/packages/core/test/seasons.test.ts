/**
 * The times of year Polaris dresses up for: the windows Discord published, New
 * Year carved out of winter, and the Lunar New Year from the lunar calendar.
 */

import { describe, expect, it } from "vitest";
import {
    nextSeason,
    parseSeasonalPrefs,
    SEASONAL_DEFAULTS,
    seasonLastDay,
    seasonOn
} from "../src/seasons.js";

const on = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12);

describe("seasonOn", () => {
    it("puts Halloween between 20 October and 3 November", () => {
        expect(seasonOn(on(2026, 10, 19))).toBeNull();
        expect(seasonOn(on(2026, 10, 20))).toBe("halloween");
        expect(seasonOn(on(2026, 10, 31))).toBe("halloween");
        expect(seasonOn(on(2026, 11, 3))).toBe("halloween");
        expect(seasonOn(on(2026, 11, 4))).toBeNull();
    });

    it("runs winter from 19 December to 3 January, with New Year's Eve and Day apart", () => {
        expect(seasonOn(on(2026, 12, 18))).toBeNull();
        expect(seasonOn(on(2026, 12, 19))).toBe("winter");
        expect(seasonOn(on(2026, 12, 25))).toBe("winter");
        expect(seasonOn(on(2026, 12, 31))).toBe("newYear");
        expect(seasonOn(on(2027, 1, 1))).toBe("newYear");
        expect(seasonOn(on(2027, 1, 2))).toBe("winter");
        expect(seasonOn(on(2027, 1, 3))).toBe("winter");
        expect(seasonOn(on(2027, 1, 4))).toBeNull();
    });

    it("finds the Lunar New Year from the lunar calendar, through the Lantern Festival", () => {
        // 2026's falls on 17 February, 2025's on 29 January.
        expect(seasonOn(on(2026, 2, 16))).toBeNull();
        expect(seasonOn(on(2026, 2, 17))).toBe("lunarNewYear");
        expect(seasonOn(on(2026, 3, 3))).toBe("lunarNewYear");
        expect(seasonOn(on(2026, 3, 4))).toBeNull();
        expect(seasonOn(on(2025, 1, 29))).toBe("lunarNewYear");
    });

    it("is nothing on an ordinary day", () => {
        expect(seasonOn(on(2026, 6, 15))).toBeNull();
    });
});

describe("nextSeason", () => {
    it("names the next one to begin and its first day", () => {
        const next = nextSeason(on(2026, 10, 8));
        expect(next?.season).toBe("halloween");
        expect(next?.from.getMonth()).toBe(9);
        expect(next?.from.getDate()).toBe(20);
    });

    it("skips the one in force", () => {
        expect(nextSeason(on(2026, 12, 20))?.season).toBe("newYear");
        expect(nextSeason(on(2026, 11, 1))?.season).toBe("winter");
    });
});

describe("seasonLastDay", () => {
    it("names the day the season in force ends on", () => {
        const last = seasonLastDay(on(2026, 10, 25));
        expect([last?.getMonth(), last?.getDate()]).toEqual([10, 3]);
        // Winter pauses for New Year's Eve, so its first stretch ends the day before.
        expect(seasonLastDay(on(2026, 12, 20))?.getDate()).toBe(30);
        expect(seasonLastDay(on(2026, 6, 1))).toBeNull();
    });
});

describe("parseSeasonalPrefs", () => {
    it("decorates by default and keeps the sounds off until asked for", () => {
        expect(parseSeasonalPrefs(null)).toEqual({ theme: true, sounds: false });
    });

    it("reads what was saved and drops what is not a choice", () => {
        expect(parseSeasonalPrefs('{"sounds":true}')).toEqual({ theme: true, sounds: true });
        expect(parseSeasonalPrefs("not json")).toEqual(SEASONAL_DEFAULTS);
        expect(parseSeasonalPrefs('{"theme":"yes"}')).toEqual(SEASONAL_DEFAULTS);
    });
});
