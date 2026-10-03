/**
 * Where the reader is in time: whether a view already shows today (so "Today"
 * has nowhere to go), which days are the weekend, where a time grid opens, and
 * how far the dimmed past and the red line reach - in the display zone, not the
 * browser's.
 */

import { describe, expect, it } from "vitest";
import { elapsedToday } from "@polaris-app/calendar/src/screens/grid-events";
import {
    nowScrollTime,
    showsToday,
    todayIn,
    viewWindow,
    wallOf,
    weekendDays,
    zoneOffsetLabel
} from "@polaris-app/calendar/src/screens/time";
import type { CalendarViewName } from "@polaris-app/calendar/src/lib/preferences";

const TODAY = "2026-10-03";

function shows(view: CalendarViewName, anchor: string): boolean {
    return showsToday(view, anchor, viewWindow(view, anchor, 1, 4), TODAY);
}

describe("whether a view shows today", () => {
    it("is the week or the days drawn, for the time grids and the list", () => {
        expect(shows("week", "2026-09-29")).toBe(true);
        expect(shows("week", "2026-10-06")).toBe(false);
        expect(shows("day", TODAY)).toBe(true);
        expect(shows("day", "2026-10-04")).toBe(false);
        expect(shows("days", "2026-10-01")).toBe(true);
        expect(shows("days", "2026-10-04")).toBe(false);
        expect(shows("list", "2026-09-10")).toBe(true);
    });

    it("is the month in the heading, not the days of the next month it also draws", () => {
        expect(shows("month", "2026-10-20")).toBe(true);
        // September's grid runs into October 4th, but today is not September.
        expect(shows("month", "2026-09-15")).toBe(false);
        expect(shows("year", "2026-01-01")).toBe(true);
        expect(shows("year", "2025-10-03")).toBe(false);
    });
});

describe("the weekend", () => {
    it("is Saturday and Sunday where the locale says so", () => {
        expect(weekendDays("en-US").sort()).toEqual([0, 6]);
        expect(weekendDays("es-ES").sort()).toEqual([0, 6]);
    });

    it("follows a locale whose weekend is elsewhere, when Intl knows it", () => {
        const days = weekendDays("ar-SA").sort();
        // Friday and Saturday where the engine has week data; the usual pair where not.
        expect([
            [5, 6],
            [0, 6]
        ]).toContainEqual(days);
    });

    it("falls back for a locale Intl rejects", () => {
        expect(weekendDays("not a locale").sort()).toEqual([0, 6]);
    });
});

describe("now on a time grid", () => {
    const now = new Date("2026-10-03T08:42:00Z");

    it("opens an hour and a half before now, in the display zone", () => {
        expect(nowScrollTime(now, "UTC")).toBe("07:12:00");
        expect(nowScrollTime(now, "Europe/Madrid")).toBe("09:12:00");
        expect(nowScrollTime(now, "America/New_York")).toBe("03:12:00");
    });

    it("does not scroll before midnight early in the day", () => {
        expect(nowScrollTime(new Date("2026-10-03T00:30:00Z"), "UTC")).toBe("00:00:00");
    });

    it("dims today from midnight to the minute it is in the zone shown", () => {
        const zone = "Asia/Tokyo";
        const today = todayIn(zone, now);
        expect(today).toBe("2026-10-03");
        expect(elapsedToday(today, wallOf(now, zone))).toMatchObject({
            start: "2026-10-03T00:00:00",
            end: "2026-10-03T17:42:00",
            display: "background"
        });
    });

    it("puts the line on the zone's own day when that is not the browser's", () => {
        // 23:30 in New York is already the next day in UTC.
        const late = new Date("2026-10-04T03:30:00Z");
        expect(todayIn("America/New_York", late)).toBe("2026-10-03");
        expect(wallOf(late, "America/New_York").slice(11, 16)).toBe("23:30");
        expect(todayIn("UTC", late)).toBe("2026-10-04");
    });

    it("follows a change of clock: the hour after Madrid's clocks go back", () => {
        // 25 October 2026, 01:30 UTC is 02:30 in Madrid after the change.
        expect(wallOf(new Date("2026-10-25T01:30:00Z"), "Europe/Madrid").slice(11, 16)).toBe(
            "02:30"
        );
        expect(wallOf(new Date("2026-10-25T00:30:00Z"), "Europe/Madrid").slice(11, 16)).toBe(
            "02:30"
        );
    });
});

describe("the zone in a time grid's corner", () => {
    it("is the display zone's offset at that moment, summer or winter", () => {
        expect(zoneOffsetLabel("Europe/Madrid", new Date("2026-10-03T08:00:00Z"), "en-US")).toBe(
            "GMT+2"
        );
        expect(zoneOffsetLabel("Europe/Madrid", new Date("2026-11-03T08:00:00Z"), "en-US")).toBe(
            "GMT+1"
        );
        // Engines differ on how they name an offset of zero.
        expect(zoneOffsetLabel("UTC", new Date("2026-10-03T08:00:00Z"), "en-US")).toMatch(
            /^(GMT|UTC)(\+0)?$/
        );
    });

    it("is empty for a zone Intl does not know", () => {
        expect(zoneOffsetLabel("Not/AZone", new Date(), "en-US")).toBe("");
    });
});
