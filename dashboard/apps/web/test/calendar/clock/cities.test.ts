/**
 * The world clock's cities: every IANA zone, found by city, by country in the
 * reader's language, by an older name or an offset; and how a city's time
 * compares - the day, the hours apart, the coming clock change, the working
 * hours, and a planner day with a clock change in it.
 */

import { describe, expect, it } from "vitest";
import * as cities from "@polaris-app/calendar/src/lib/clock/cities";

const NOW = new Date("2026-10-02T10:00:00Z");

const zonesFor = (query: string, locale = "en-US") =>
    cities.searchCities(cities.cityOptions(locale, NOW), query, 20).map((option) => option.zone);

describe("finding a city", () => {
    it("lists every zone the runtime knows, not a short list", () => {
        expect(cities.cityOptions("en-US", NOW).length).toBeGreaterThan(300);
    });

    it("finds a zone by its city", () => {
        expect(zonesFor("new york")[0]).toBe("America/New_York");
        // Whichever name this runtime lists it under, it is found and named by
        // the current one.
        const saigon = cities
            .cityOptions("en-US", NOW)
            .find((option) => /Asia\/(Ho_Chi_Minh|Saigon)/.test(option.zone));
        expect(zonesFor("ho chi minh")).toContain(saigon?.zone);
        expect(zonesFor("saigon")).toContain(saigon?.zone);
        expect(saigon?.city).toBe("Ho Chi Minh");
    });

    it("finds a zone by its country, in the reader's language", () => {
        expect(zonesFor("spain")).toContain("Europe/Madrid");
        expect(zonesFor("españa", "es-ES")).toContain("Europe/Madrid");
        expect(zonesFor("japan")).toContain("Asia/Tokyo");
    });

    it("finds a zone by the older name of its city", () => {
        expect(zonesFor("calcutta")).toEqual(expect.arrayContaining([expect.stringMatching(/Asia\/(Kolkata|Calcutta)/)]));
        expect(zonesFor("kolkata")).toEqual(expect.arrayContaining([expect.stringMatching(/Asia\/(Kolkata|Calcutta)/)]));
    });

    it("finds a zone by its offset", () => {
        expect(zonesFor("GMT+09:00")).toContain("Asia/Tokyo");
    });

    it("names a city after its zone", () => {
        expect(cities.cityOf("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
        expect(cities.cityOf("UTC")).toBe("UTC");
        expect(cities.cityOf("Asia/Calcutta")).toBe("Kolkata");
    });
});

describe("comparing a city with the reader's", () => {
    it("says the day and the hours apart, both ways", () => {
        // 23:30 in Madrid, 06:30 the next day in Tokyo, 14:30 in Los Angeles.
        const late = new Date("2026-10-02T21:30:00Z");
        expect(cities.dayDifference("Asia/Tokyo", "Europe/Madrid", late)).toBe(1);
        expect(cities.dayDifference("America/Los_Angeles", "Asia/Tokyo", late)).toBe(-1);
        expect(cities.offsetBetween("Asia/Tokyo", "Europe/Madrid", NOW)).toBe(7 * 60);
        expect(cities.offsetBetween("Asia/Kolkata", "Europe/Madrid", NOW)).toBe(3 * 60 + 30);
    });

    it("sees the next clock change coming, to the minute", () => {
        const change = cities.nextClockChange("Europe/Madrid", NOW, 30);
        expect(change?.toISOString()).toBe("2026-10-25T01:00:00.000Z");
        expect(cities.nextClockChange("Asia/Tokyo", NOW, 30)).toBeNull();
    });

    it("reads an hour as work, awake or off, timeanddate's way", () => {
        expect(cities.hourKind(3, 10 * 60)).toBe("work");
        expect(cities.hourKind(3, 8 * 60)).toBe("edge");
        expect(cities.hourKind(3, 23 * 60)).toBe("off");
        expect(cities.hourKind(6, 12 * 60)).toBe("off");
    });

    it("reads the reader's own city by their own working hours", () => {
        const hours = { "3": [{ from: "07:00", to: "15:00" }] };
        expect(cities.hourKind(3, 7 * 60, hours)).toBe("work");
        expect(cities.hourKind(3, 16 * 60, hours)).toBe("edge");
        expect(cities.hourKind(4, 10 * 60, hours)).toBe("off");
    });

    it("gives the planner 23 hours on the spring change, 25 on the autumn one", () => {
        expect(cities.hoursOfDay("2026-03-29", "Europe/Madrid")).toHaveLength(23);
        expect(cities.hoursOfDay("2026-10-25", "Europe/Madrid")).toHaveLength(25);
        expect(cities.hoursOfDay("2026-10-02", "Europe/Madrid")).toHaveLength(24);
        expect(cities.hoursOfDay("2026-10-02", "Europe/Madrid")[0]?.toISOString()).toBe("2026-10-01T22:00:00.000Z");
    });

    it("hands the planner's time to the calendar as a path it reads back", () => {
        expect(cities.newEventPath(new Date("2026-10-02T14:00:00Z"))).toBe("/calendar/new/2026-10-02T14:00Z");
    });
});
