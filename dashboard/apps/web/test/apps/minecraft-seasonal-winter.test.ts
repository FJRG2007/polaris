/**
 * Christmas and New Year's Eve on a Minecraft server: the settings a server
 * keeps, the calendar its jar is handed, and the line that carries both.
 *
 * Pinned: every setting has a default an untouched server already gets,
 * anything stored that is not one of the choices reads as that default, the
 * days and both midnights are read on the server's clock in its own time zone,
 * and the jar is told amounts as whole percentages.
 */

import { describe, expect, it } from "vitest";
import * as winter from "@polaris-app/game-servers/src/lib/minecraft/seasonal-winter";

describe("a server's Christmas and New Year settings", () => {
    it("are all on at the usual amount until somebody changes them", () => {
        expect(winter.winterSettings({})).toEqual(winter.WINTER_DEFAULTS);
        for (const key of winter.WINTER_SWITCHES) expect(winter.WINTER_DEFAULTS[key]).toBe(true);
        for (const key of winter.WINTER_AMOUNTS) expect(winter.WINTER_DEFAULTS[key]).toBe(1);
    });

    it("keep what was stored, and read anything else as the default", () => {
        const settings = winter.winterSettings({
            [winter.WINTER_KEY]: { elves: 0, reindeer: 3, snowmen: 7, santa: false, lights: "no" }
        });
        expect(settings).toMatchObject({
            elves: 0,
            reindeer: 3,
            snowmen: 1,
            santa: false,
            lights: true
        });
        expect(winter.winterSettings({ [winter.WINTER_KEY]: "broken" })).toEqual(
            winter.WINTER_DEFAULTS
        );
        expect(winter.winterSettings({ [winter.WINTER_KEY]: [1, 2] })).toEqual(
            winter.WINTER_DEFAULTS
        );
    });

    it("take a patch on top of what is stored", () => {
        const config = { [winter.WINTER_KEY]: { elves: 0 } };
        expect(winter.patchWinter(config, { santa: false })).toMatchObject({
            elves: 0,
            santa: false,
            presents: true
        });
    });

    it("refuse a save that is not one of the choices, or names a setting there is not", () => {
        expect(winter.winterPatchSchema.safeParse({ elves: 2 }).success).toBe(true);
        expect(winter.winterPatchSchema.safeParse({ elves: 4 }).success).toBe(false);
        expect(winter.winterPatchSchema.safeParse({ santa: "yes" }).success).toBe(false);
        expect(winter.winterPatchSchema.safeParse({ dragons: true }).success).toBe(false);
    });
});

describe("the winter calendar", () => {
    it("is Christmas from 1 to 26 December on the server's clock", () => {
        expect(winter.winterCalendar(new Date("2026-11-30T12:00:00Z"), "UTC").christmas).toBe(
            false
        );
        expect(winter.winterCalendar(new Date("2026-12-01T00:00:00Z"), "UTC").christmas).toBe(true);
        expect(winter.winterCalendar(new Date("2026-12-26T23:59:00Z"), "UTC").christmas).toBe(true);
        expect(winter.winterCalendar(new Date("2026-12-27T00:00:00Z"), "UTC").christmas).toBe(
            false
        );
        // Still the 26th in New York when it is already the 27th in UTC.
        expect(
            winter.winterCalendar(new Date("2026-12-27T03:00:00Z"), "America/New_York").christmas
        ).toBe(true);
    });

    it("names the day as yyyymmdd in the server's zone", () => {
        expect(winter.winterCalendar(new Date("2026-12-24T23:30:00Z"), "UTC").day).toBe(20261224);
        expect(winter.winterCalendar(new Date("2026-12-24T23:30:00Z"), "Europe/Madrid").day).toBe(
            20261225
        );
    });

    it("hands over both midnights as instants in the server's zone", () => {
        const madrid = winter.winterCalendar(new Date("2026-12-20T12:00:00Z"), "Europe/Madrid");
        expect(madrid.eveAt).toBe(Date.parse("2026-12-24T23:00:00Z"));
        expect(madrid.newYearAt).toBe(Date.parse("2026-12-31T23:00:00Z"));
        const utc = winter.winterCalendar(new Date("2026-12-31T23:59:50Z"), "UTC");
        expect(utc.newYearAt).toBe(Date.parse("2027-01-01T00:00:00Z"));
    });

    it("has no midnights to count down to outside December", () => {
        const january = winter.winterCalendar(new Date("2027-01-01T00:00:30Z"), "UTC");
        expect(january).toMatchObject({ christmas: false, eveAt: 0, newYearAt: 0, day: 20270101 });
    });

    it("reads an automatic or unknown zone as UTC", () => {
        const at = new Date("2026-12-24T23:30:00Z");
        expect(winter.winterCalendar(at, "automatic")).toEqual(winter.winterCalendar(at, "UTC"));
        expect(winter.winterCalendar(at, "Mars/Olympus")).toEqual(winter.winterCalendar(at, "UTC"));
    });
});

describe("the winter line", () => {
    it("carries amounts as percentages, switches as 1 or 0, and the calendar", () => {
        const settings = { ...winter.WINTER_DEFAULTS, elves: 0.5, snowmen: 0, sparkles: false };
        const calendar = winter.winterCalendar(new Date("2026-12-24T12:00:00Z"), "UTC");
        const eveAt = Date.parse("2026-12-25T00:00:00Z");
        const newYearAt = Date.parse("2027-01-01T00:00:00Z");
        expect(winter.winterCommand(settings, calendar)).toBe(
            `polaris season winter golems=100 snow=100 reindeer=100 elves=50 snowmen=0 presents=1 santa=1 lights=1 eve=1 newyear=1 sparkles=0 christmas=1 day=20261224 eveat=${eveAt} nyat=${newYearAt}`
        );
    });

    it("stays within what one console command may carry", () => {
        const calendar = winter.winterCalendar(new Date("2026-12-24T12:00:00Z"), "UTC");
        const line = winter.winterCommand({ ...winter.WINTER_DEFAULTS, reindeer: 3 }, calendar);
        expect(line.length).toBeLessThan(256);
        expect(line).not.toMatch(/[\r\n\0]/);
    });
});
