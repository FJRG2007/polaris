/**
 * Which season a Minecraft server dresses for, and the line its jar is told.
 *
 * Pinned: the dates are Polaris's own, read on the server's wall clock in its
 * time zone (so the evening of 6 October in one zone is already Halloween in
 * another), winter runs over New Year into January, and the operator's switch,
 * the server's own switch and a running event each take everything down.
 */

import { describe, expect, it } from "vitest";
import * as seasonal from "@polaris-app/game-servers/src/lib/minecraft/seasonal";

const on = (iso: string, timeZone = "UTC") =>
    seasonal.decorationNow({
        now: new Date(iso),
        timeZone,
        allowed: true,
        serverOn: true,
        eventRunning: false
    });

describe("the season a server dresses for", () => {
    it("is Halloween from 7 October to 2 November, inclusive", () => {
        expect(on("2026-10-06T12:00:00Z")).toBeNull();
        expect(on("2026-10-07T00:00:00Z")).toBe("halloween");
        expect(on("2026-10-31T23:59:00Z")).toBe("halloween");
        expect(on("2026-11-02T23:59:00Z")).toBe("halloween");
        expect(on("2026-11-03T00:00:00Z")).toBeNull();
    });

    it("is winter from 1 December through New Year to 9 January", () => {
        expect(on("2026-11-30T23:59:00Z")).toBeNull();
        expect(on("2026-12-01T00:00:00Z")).toBe("winter");
        expect(on("2026-12-31T12:00:00Z")).toBe("winter");
        expect(on("2027-01-01T12:00:00Z")).toBe("winter");
        expect(on("2027-01-09T23:59:00Z")).toBe("winter");
        expect(on("2027-01-10T00:00:00Z")).toBeNull();
    });

    it("reads the day on the server's own clock", () => {
        // 22:30 on 6 October in UTC is already 7 October in Madrid.
        expect(on("2026-10-06T22:30:00Z", "UTC")).toBeNull();
        expect(on("2026-10-06T22:30:00Z", "Europe/Madrid")).toBe("halloween");
        // And 03:00 on 10 January in UTC is still 9 January in New York.
        expect(on("2027-01-10T03:00:00Z", "America/New_York")).toBe("winter");
        expect(on("2027-01-10T03:00:00Z", "UTC")).toBeNull();
    });

    it("treats an unknown or automatic zone as UTC rather than the dashboard's clock", () => {
        expect(seasonal.seasonInZone(new Date("2026-10-06T22:30:00Z"), "Not/AZone")).toBeNull();
        expect(seasonal.seasonInZone(new Date("2026-10-06T22:30:00Z"), "auto")).toBeNull();
    });

    it("has nothing for the Lunar New Year", () => {
        expect(seasonal.decorationFor("lunarNewYear")).toBeNull();
        expect(seasonal.decorationFor("newYear")).toBe("winter");
    });
});

describe("what takes it down", () => {
    const base = {
        now: new Date("2026-10-20T12:00:00Z"),
        timeZone: "UTC",
        allowed: true,
        serverOn: true,
        eventRunning: false
    };

    it("shows in season with every switch on", () => {
        expect(seasonal.decorationNow(base)).toBe("halloween");
    });

    it("shows nothing with the operator's switch off", () => {
        expect(seasonal.decorationNow({ ...base, allowed: false })).toBeNull();
    });

    it("shows nothing with the server's own switch off", () => {
        expect(seasonal.decorationNow({ ...base, serverOn: false })).toBeNull();
    });

    it("waits while an event runs", () => {
        expect(seasonal.decorationNow({ ...base, eventRunning: true })).toBeNull();
    });

    it("reads a server's switch as on until it is turned off", () => {
        expect(seasonal.seasonalOn({})).toBe(true);
        expect(seasonal.seasonalOn({ [seasonal.SEASONAL_KEY]: null })).toBe(true);
        expect(seasonal.seasonalOn({ [seasonal.SEASONAL_KEY]: false })).toBe(false);
    });
});

describe("the line the jar is told", () => {
    it("names the season and how long to hold it", () => {
        expect(seasonal.seasonCommand("halloween")).toBe(
            `polaris season set halloween ${seasonal.SEASON_HOLD_SECONDS}`
        );
        expect(seasonal.seasonCommand("winter")).toBe(
            `polaris season set winter ${seasonal.SEASON_HOLD_SECONDS}`
        );
    });

    it("clears when there is nothing to show", () => {
        expect(seasonal.seasonCommand(null)).toBe("polaris season clear");
    });

    it("holds for longer than the sweep's gap, so a pass never lets it lapse", () => {
        expect(seasonal.SEASON_HOLD_SECONDS).toBeGreaterThan(10 * 60);
    });
});
