/**
 * The times of year Polaris dresses up for: the windows Discord published, New
 * Year carved out of winter, and the Lunar New Year from the lunar calendar.
 */

import { describe, expect, it } from "vitest";
import {
    nextSeason,
    packLastDay,
    packOn,
    packPlays,
    parseSeasonalPrefs,
    SEASONAL_DEFAULTS,
    seasonalPrefsSchema,
    seasonLastDay,
    seasonOn
} from "../src/seasons.js";

const on = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12);

describe("seasonOn", () => {
    it("puts Halloween between 7 October and 2 November, Discord's dates", () => {
        expect(seasonOn(on(2026, 10, 6))).toBeNull();
        expect(seasonOn(on(2026, 10, 7))).toBe("halloween");
        expect(seasonOn(on(2026, 10, 31))).toBe("halloween");
        expect(seasonOn(on(2026, 11, 2))).toBe("halloween");
        expect(seasonOn(on(2026, 11, 3))).toBeNull();
    });

    it("runs winter from 19 December to 5 January, with New Year's Eve and Day apart", () => {
        expect(seasonOn(on(2026, 12, 18))).toBeNull();
        expect(seasonOn(on(2026, 12, 19))).toBe("winter");
        expect(seasonOn(on(2026, 12, 25))).toBe("winter");
        expect(seasonOn(on(2026, 12, 31))).toBe("newYear");
        expect(seasonOn(on(2027, 1, 1))).toBe("newYear");
        expect(seasonOn(on(2027, 1, 2))).toBe("winter");
        expect(seasonOn(on(2027, 1, 5))).toBe("winter");
        expect(seasonOn(on(2027, 1, 6))).toBeNull();
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
        const next = nextSeason(on(2026, 10, 1));
        expect(next?.season).toBe("halloween");
        expect(next?.from.getMonth()).toBe(9);
        expect(next?.from.getDate()).toBe(7);
    });

    it("skips the one in force", () => {
        expect(nextSeason(on(2026, 12, 20))?.season).toBe("newYear");
        expect(nextSeason(on(2026, 11, 1))?.season).toBe("winter");
    });
});

describe("seasonLastDay", () => {
    it("names the day the season in force ends on", () => {
        const last = seasonLastDay(on(2026, 10, 25));
        expect([last?.getMonth(), last?.getDate()]).toEqual([10, 2]);
        // Winter pauses for New Year's Eve, so its first stretch ends the day before.
        expect(seasonLastDay(on(2026, 12, 20))?.getDate()).toBe(30);
        expect(seasonLastDay(on(2026, 6, 1))).toBeNull();
    });
});

describe("the sound pack in force", () => {
    it("names one run of a pack, winter's carried across New Year", () => {
        expect(packOn(on(2026, 10, 9))).toBe("halloween-2026");
        expect(packOn(on(2026, 12, 20))).toBe("winter-2026");
        expect(packOn(on(2026, 12, 31))).toBe("winter-2026");
        expect(packOn(on(2027, 1, 5))).toBe("winter-2026");
        expect(packOn(on(2026, 6, 15))).toBeNull();
    });

    it("ends winter's on 5 January, through New Year", () => {
        const last = packLastDay(on(2026, 12, 20));
        expect([last?.getFullYear(), last?.getMonth(), last?.getDate()]).toEqual([2027, 0, 5]);
        expect(packLastDay(on(2026, 6, 15))).toBeNull();
    });

    it("plays unless this run was turned off, and comes back for the next", () => {
        expect(packPlays(on(2026, 10, 9), SEASONAL_DEFAULTS)).toBe(true);
        const off = { mutedPack: "halloween-2026" };
        expect(packPlays(on(2026, 10, 9), off)).toBe(false);
        expect(packPlays(on(2026, 12, 20), off)).toBe(true);
        expect(packPlays(on(2027, 10, 9), off)).toBe(true);
        expect(packPlays(on(2026, 6, 15), SEASONAL_DEFAULTS)).toBe(false);
    });
});

describe("parseSeasonalPrefs", () => {
    it("plays every pack by default", () => {
        expect(parseSeasonalPrefs(null)).toEqual({ mutedPack: null });
    });

    it("reads the pack turned off, and nothing from the switches kept before", () => {
        expect(parseSeasonalPrefs('{"mutedPack":"winter-2026"}')).toEqual({ mutedPack: "winter-2026" });
        expect(parseSeasonalPrefs('{"theme":false,"sounds":false}')).toEqual(SEASONAL_DEFAULTS);
        expect(parseSeasonalPrefs("not json")).toEqual(SEASONAL_DEFAULTS);
        expect(parseSeasonalPrefs('{"mutedPack":7}')).toEqual(SEASONAL_DEFAULTS);
    });

    it("accepts only a real pack from an account", () => {
        expect(seasonalPrefsSchema.safeParse({ mutedPack: "halloween-2026" }).success).toBe(true);
        expect(seasonalPrefsSchema.safeParse({ mutedPack: null }).success).toBe(true);
        expect(seasonalPrefsSchema.safeParse({ mutedPack: "newYear-2026" }).success).toBe(false);
        expect(seasonalPrefsSchema.safeParse({ mutedPack: "x".repeat(5000) }).success).toBe(false);
        expect(seasonalPrefsSchema.safeParse({ theme: false }).success).toBe(false);
    });
});
