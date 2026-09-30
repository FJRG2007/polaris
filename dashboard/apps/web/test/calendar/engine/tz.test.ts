/**
 * U07: time zones on Intl - names, wall time to instant and back, and the two
 * readings a clock change makes awkward (RFC 5545 3.3.5).
 */

import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

const wall = (text: string) => engine.parseWall(text);

describe("resolveZone", () => {
    it("accepts IANA names Intl knows and refuses the rest", () => {
        expect(engine.resolveZone("Europe/Madrid")).toBe("Europe/Madrid");
        expect(engine.resolveZone("America/New_York")).toBe("America/New_York");
        expect(engine.resolveZone("Mars/Olympus_Mons")).toBeNull();
        expect(engine.resolveZone("")).toBeNull();
        expect(engine.resolveZone(null)).toBeNull();
    });

    it("reads UTC spellings as UTC", () => {
        for (const name of ["UTC", "utc", "GMT", "Etc/UTC", "Z"]) expect(engine.resolveZone(name)).toBe("UTC");
    });

    it("strips vendor prefixes", () => {
        expect(engine.resolveZone("/mozilla.org/20050126_1/Europe/Madrid")).toBe("Europe/Madrid");
        expect(engine.resolveZone("/freeassociation.sourceforge.net/Tzfile/Europe/Madrid")).toBe("Europe/Madrid");
        expect(engine.resolveZone("/freeassociation.sourceforge.net/America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
        expect(engine.resolveZone("/softwarestudio.org/Olson_20011030_5/America/New_York")).toBe("America/New_York");
    });

    it("maps Windows zone names through the CLDR primary mapping", () => {
        const expected: Record<string, string> = {
            "Romance Standard Time": "Europe/Paris",
            "Pacific Standard Time": "America/Los_Angeles",
            "W. Europe Standard Time": "Europe/Berlin",
            "Eastern Standard Time": "America/New_York",
            "Central Standard Time": "America/Chicago",
            "Mountain Standard Time": "America/Denver",
            "GMT Standard Time": "Europe/London",
            "Tokyo Standard Time": "Asia/Tokyo",
            "China Standard Time": "Asia/Shanghai",
            "AUS Eastern Standard Time": "Australia/Sydney",
            "E. South America Standard Time": "America/Sao_Paulo",
            "Central European Standard Time": "Europe/Warsaw",
            "Russian Standard Time": "Europe/Moscow",
            "SA Pacific Standard Time": "America/Bogota",
            "Central Standard Time (Mexico)": "America/Mexico_City"
        };
        for (const [windows, iana] of Object.entries(expected)) expect(engine.resolveZone(windows)).toBe(iana);
        expect(engine.resolveZone("India Standard Time")).toMatch(/^Asia\/(Calcutta|Kolkata)$/);
    });

    it("maps every Windows name to a zone this runtime can use", () => {
        const names = ["Dateline Standard Time", "UTC-11", "Hawaiian Standard Time", "Alaskan Standard Time", "US Mountain Standard Time", "Atlantic Standard Time", "Newfoundland Standard Time", "Argentina Standard Time", "Greenland Standard Time", "Cape Verde Standard Time", "Morocco Standard Time", "Egypt Standard Time", "FLE Standard Time", "Israel Standard Time", "Iran Standard Time", "Nepal Standard Time", "Korea Standard Time", "New Zealand Standard Time", "UTC+12", "Tonga Standard Time"];
        for (const name of names) {
            const zone = engine.resolveZone(name);
            expect(zone, name).not.toBeNull();
            expect(() => engine.instantToWall(new Date(0), zone ?? "")).not.toThrow();
        }
    });
});

describe("wall time and instants", () => {
    it("converts both ways in a zone with DST", () => {
        const summer = engine.wallToInstant(wall("2026-07-01T09:00:00"), "Europe/Madrid");
        expect(summer.toISOString()).toBe("2026-07-01T07:00:00.000Z");
        const winter = engine.wallToInstant(wall("2026-01-15T09:00:00"), "Europe/Madrid");
        expect(winter.toISOString()).toBe("2026-01-15T08:00:00.000Z");
        expect(engine.formatWall(engine.instantToWall(summer, "Europe/Madrid"))).toBe("2026-07-01T09:00:00");
        expect(engine.zoneOffsetMinutes(summer, "Europe/Madrid")).toBe(120);
        expect(engine.zoneOffsetMinutes(winter, "America/New_York")).toBe(-300);
    });

    it("reads a time skipped in spring with the offset from before the gap", () => {
        // 2026-03-08 02:30 does not exist in New York: EST (-5) is used, which
        // is 03:30 EDT.
        const instant = engine.wallToInstant(wall("2026-03-08T02:30:00"), "America/New_York");
        expect(instant.toISOString()).toBe("2026-03-08T07:30:00.000Z");
        expect(engine.formatWall(engine.instantToWall(instant, "America/New_York"))).toBe("2026-03-08T03:30:00");
        const madrid = engine.wallToInstant(wall("2026-03-29T02:30:00"), "Europe/Madrid");
        expect(engine.formatWall(engine.instantToWall(madrid, "Europe/Madrid"))).toBe("2026-03-29T03:30:00");
    });

    it("reads a time repeated in autumn as the first of the two", () => {
        const instant = engine.wallToInstant(wall("2026-11-01T01:30:00"), "America/New_York");
        expect(instant.toISOString()).toBe("2026-11-01T05:30:00.000Z");
        const madrid = engine.wallToInstant(wall("2026-10-25T02:30:00"), "Europe/Madrid");
        expect(madrid.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    });

    it("parses and formats wall times", () => {
        expect(engine.parseWall("2026-02-03T04:05:06")).toEqual({ year: 2026, month: 2, day: 3, hour: 4, minute: 5, second: 6 });
        expect(engine.parseWall("2026-02-03")).toEqual({ year: 2026, month: 2, day: 3, hour: 0, minute: 0, second: 0 });
        expect(engine.formatWall(engine.parseWall("2026-02-03T04:05"))).toBe("2026-02-03T04:05:00");
        expect(() => engine.parseWall("yesterday")).toThrow();
    });
});

describe("zone lists and labels", () => {
    it("lists the runtime's zones with UTC", () => {
        const zones = engine.listZones();
        expect(zones).toContain("UTC");
        expect(zones).toContain("Europe/Madrid");
        expect([...zones].sort()).toEqual(zones);
    });

    it("labels a zone with its offset at that instant", () => {
        expect(engine.zoneLabel("Europe/Madrid", new Date("2026-07-01T00:00:00Z"), "en-US")).toBe("GMT+02:00 Europe/Madrid");
        expect(engine.zoneLabel("America/New_York", new Date("2026-01-01T00:00:00Z"), "es-ES")).toBe("GMT-05:00 America/New York");
        expect(engine.zoneLabel("Asia/Kathmandu", new Date("2026-01-01T00:00:00Z"), "en-US")).toBe("GMT+05:45 Asia/Kathmandu");
    });
});

describe("VTIMEZONE fallback", () => {
    it("reads a zone Intl does not know through the file's own VTIMEZONE", () => {
        const block = ["BEGIN:VTIMEZONE", "TZID:Custom Zone", "BEGIN:STANDARD", "DTSTART:16010101T000000", "TZOFFSETFROM:+0330", "TZOFFSETTO:+0330", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
        const instant = engine.valueToInstant({ dateTime: "2026-05-01T12:00:00", tzid: "Custom Zone" }, "UTC", [block]);
        expect(instant.toISOString()).toBe("2026-05-01T08:30:00.000Z");
        const clock = engine.clockFor("Custom Zone", "UTC", [block]);
        expect(engine.formatWall(clock.toWall(instant))).toBe("2026-05-01T12:00:00");
    });
});
