import { describe, expect, it } from "vitest";
import {
    createDisplayFormat,
    DISPLAY_DEFAULTS,
    isTimeZone,
    parseDisplayPreferences,
    resolveDisplayPreferences,
    stringifyDisplayPreferences,
    toDisplayTemperature,
    userDisplayPreferencesSchema,
    wallClock,
    weekdayOrder,
    zonedInstant
} from "../src/schemas/display.js";

/** A day past the 12th and an afternoon hour, so every choice reads differently. */
const AT = new Date(2026, 6, 31, 14, 5, 9);

describe("preference layering", () => {
    it("takes the user's choice over the platform's, and the platform's over the built-in", () => {
        const resolved = resolveDisplayPreferences({ dateOrder: "dmy", clock: "12h" }, { clock: "24h" });
        expect(resolved.clock).toBe("24h");
        expect(resolved.dateOrder).toBe("dmy");
        expect(resolved.currency).toBe(DISPLAY_DEFAULTS.currency);
    });

    it("ignores fields that were never chosen instead of pinning them to undefined", () => {
        expect(resolveDisplayPreferences({ clock: undefined }, {})).toEqual(DISPLAY_DEFAULTS);
    });

    it("stores only what was chosen", () => {
        expect(stringifyDisplayPreferences({ temperature: "f", clock: undefined })).toBe('{"temperature":"f"}');
    });

    it("degrades an unreadable or outdated blob to no choice at all", () => {
        expect(parseDisplayPreferences("{not json")).toEqual({});
        expect(parseDisplayPreferences('{"clock":"37h"}')).toEqual({});
        expect(parseDisplayPreferences(null)).toEqual({});
        expect(parseDisplayPreferences('{"clock":"12h"}')).toEqual({ clock: "12h" });
    });

    it("starts the week on Sunday until somebody chooses otherwise", () => {
        expect(DISPLAY_DEFAULTS.weekStart).toBe("sun");
        expect(createDisplayFormat(DISPLAY_DEFAULTS).weekStartsOn).toBe(0);
        expect(createDisplayFormat({ ...DISPLAY_DEFAULTS, weekStart: "mon" }).weekStartsOn).toBe(1);
        expect(createDisplayFormat({ ...DISPLAY_DEFAULTS, weekStart: "sat" }).weekStartsOn).toBe(6);
    });

    it("orders the weekday columns from the chosen first day", () => {
        expect(weekdayOrder("sun")).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(weekdayOrder("mon")).toEqual([1, 2, 3, 4, 5, 6, 0]);
        expect(weekdayOrder("sat")).toEqual([6, 0, 1, 2, 3, 4, 5]);
    });

    it("rejects a unit nothing knows how to render", () => {
        expect(userDisplayPreferencesSchema.safeParse({ temperature: "k" }).success).toBe(false);
        expect(userDisplayPreferencesSchema.safeParse({ currency: "XYZ" }).success).toBe(false);
    });
});

describe("formatting", () => {
    it("writes the date in the chosen order and year width", () => {
        expect(createDisplayFormat({ ...DISPLAY_DEFAULTS, dateOrder: "mdy" }).date(AT)).toBe("07/31/2026");
        expect(createDisplayFormat({ ...DISPLAY_DEFAULTS, dateOrder: "dmy" }).date(AT)).toBe("31/07/2026");
        expect(
            createDisplayFormat({ ...DISPLAY_DEFAULTS, dateOrder: "dmy", yearFormat: "yy" }).date(AT)
        ).toBe("31/07/26");
    });

    it("writes the clock in the chosen format, including the hours that wrap", () => {
        const twelve = createDisplayFormat({ ...DISPLAY_DEFAULTS, clock: "12h" });
        expect(createDisplayFormat(DISPLAY_DEFAULTS).time(AT)).toBe("14:05");
        expect(twelve.time(AT)).toBe("2:05 PM");
        expect(twelve.time(new Date(2026, 6, 31, 0, 7))).toBe("12:07 AM");
        expect(twelve.time(new Date(2026, 6, 31, 12, 0))).toBe("12:00 PM");
        expect(createDisplayFormat(DISPLAY_DEFAULTS).time(AT, { seconds: true })).toBe("14:05:09");
    });

    it("converts readings to the chosen unit", () => {
        expect(toDisplayTemperature(100, "f")).toBe(212);
        expect(createDisplayFormat({ ...DISPLAY_DEFAULTS, temperature: "f" }).temperature(21.4)).toBe("71 F");
        expect(createDisplayFormat(DISPLAY_DEFAULTS).temperature(21.4)).toBe("21 C");
    });

    it("has something to show for a value it cannot format", () => {
        const format = createDisplayFormat(DISPLAY_DEFAULTS);
        expect(format.date("not a date")).toBe("-");
        expect(format.dateTime(null)).toBe("-");
        expect(format.temperature(null)).toBe("-");
        expect(format.currency(undefined)).toBe("-");
    });
});

describe("time zone", () => {
    /** A moment chosen for the two things a zone can change: a clock reading and,
     *  with it, the date. Late evening in London on the last day of a month is
     *  already the next day in Tokyo. */
    const INSTANT = new Date("2026-07-31T22:30:00Z");

    it("follows the device it is drawn on until a zone is chosen", () => {
        expect(DISPLAY_DEFAULTS.timeZone).toBe("auto");
        const format = createDisplayFormat(DISPLAY_DEFAULTS);
        const local = new Date(2026, 6, 31, 14, 5, 9);
        expect(format.time(local)).toBe("14:05");
    });

    it("writes the clock in the chosen zone", () => {
        const zoned = createDisplayFormat({ ...DISPLAY_DEFAULTS, timeZone: "Europe/Madrid" });
        expect(zoned.time(INSTANT)).toBe("00:30");
        const tokyo = createDisplayFormat({ ...DISPLAY_DEFAULTS, timeZone: "Asia/Tokyo" });
        expect(tokyo.time(INSTANT)).toBe("07:30");
    });

    it("carries the date with it, since a zone can put the two on different days", () => {
        const utc = createDisplayFormat({ ...DISPLAY_DEFAULTS, timeZone: "UTC", dateOrder: "dmy" });
        expect(utc.date(INSTANT)).toBe("31/07/2026");
        const tokyo = createDisplayFormat({ ...DISPLAY_DEFAULTS, timeZone: "Asia/Tokyo", dateOrder: "dmy" });
        expect(tokyo.date(INSTANT)).toBe("01/08/2026");
    });

    it("writes midnight as 00 rather than 24, in both clock formats", () => {
        const midnight = new Date("2026-07-31T22:00:00Z");
        const zoned = createDisplayFormat({ ...DISPLAY_DEFAULTS, timeZone: "Europe/Madrid" });
        expect(zoned.time(midnight)).toBe("00:00");
        const twelve = createDisplayFormat({
            ...DISPLAY_DEFAULTS,
            timeZone: "Europe/Madrid",
            clock: "12h"
        });
        expect(twelve.time(midnight)).toBe("12:00 AM");
    });

    it("refuses a zone this runtime does not know, and accepts the ones it does", () => {
        expect(isTimeZone("Europe/Madrid")).toBe(true);
        expect(isTimeZone("auto")).toBe(true);
        expect(isTimeZone("Mars/Olympus")).toBe(false);
        expect(userDisplayPreferencesSchema.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(false);
        expect(userDisplayPreferencesSchema.safeParse({ timeZone: "UTC" }).success).toBe(true);
    });

    it("keeps drawing a time when the stored zone has gone, rather than nothing", () => {
        // Reached past the schema on purpose: a zone stored years ago and dropped
        // by a runtime since must degrade to this device's clock.
        const gone = createDisplayFormat({ ...DISPLAY_DEFAULTS, timeZone: "Mars/Olympus" });
        expect(gone.time(new Date(2026, 6, 31, 14, 5, 9))).toBe("14:05");
    });
});

describe("the moment a reading names", () => {
    /** The inverse of the clock above: what a picker hands back when somebody
     *  chooses a day and a time. */
    it("reads a wall clock in the zone the account works to", () => {
        const at = zonedInstant({ year: 2026, month: 9, day: 8, hours: 9, minutes: 0 }, "UTC");
        expect(at.toISOString()).toBe("2026-09-08T09:00:00.000Z");

        const madrid = zonedInstant({ year: 2026, month: 9, day: 8, hours: 9, minutes: 0 }, "Europe/Madrid");
        // Summer time: two hours ahead of UTC.
        expect(madrid.toISOString()).toBe("2026-09-08T07:00:00.000Z");

        const tokyo = zonedInstant({ year: 2026, month: 9, day: 8, hours: 9, minutes: 0 }, "Asia/Tokyo");
        expect(tokyo.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    });

    it("holds across a daylight saving change, on both sides of it", () => {
        // Madrid goes back on the last Sunday of October 2026 (the 25th).
        const before = zonedInstant({ year: 2026, month: 10, day: 24, hours: 12, minutes: 0 }, "Europe/Madrid");
        expect(before.toISOString()).toBe("2026-10-24T10:00:00.000Z");
        const after = zonedInstant({ year: 2026, month: 10, day: 26, hours: 12, minutes: 0 }, "Europe/Madrid");
        expect(after.toISOString()).toBe("2026-10-26T11:00:00.000Z");
    });

    it("is the inverse of the clock it reads", () => {
        // Whatever else it does, a reading turned into a moment and read back has
        // to be the same reading - that is the whole contract a picker rests on.
        for (const zone of ["UTC", "Europe/Madrid", "Asia/Tokyo", "America/New_York"]) {
            const reading = { year: 2026, month: 3, day: 14, hours: 23, minutes: 45 };
            const wall = wallClock(zonedInstant(reading, zone), zone);
            expect({ ...wall, seconds: 0 }).toEqual({ ...reading, seconds: 0 });
        }
    });

    it("falls back to this device for a zone that is not one", () => {
        const local = new Date(2026, 8, 8, 9, 0, 0, 0);
        expect(
            zonedInstant({ year: 2026, month: 9, day: 8, hours: 9, minutes: 0 }, "Mars/Olympus").getTime()
        ).toBe(local.getTime());
    });
});
