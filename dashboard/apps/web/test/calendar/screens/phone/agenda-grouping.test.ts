/**
 * The phone's schedule groups the grid's events by day.
 *
 * What is pinned:
 * - days come in order and empty days are left out, except today;
 * - all-day events lead a day, then timed ones by start;
 * - an event over several days is on each of them, marked first, middle and
 *   last; an all-day end and a timed end at midnight are exclusive;
 * - only the window's days are listed, and the grid's background shading is
 *   never an event;
 * - a month day's dots are its events' colours, capped.
 */

import { describe, expect, it } from "vitest";
import type { EventInput } from "@fullcalendar/core";
import { agendaDays, dayDots } from "@polaris-app/calendar/src/screens/agenda";

const WINDOW = { start: "2026-11-01", end: "2026-12-01" };

function event(id: string, start: string, end: string | undefined, allDay = false): EventInput {
    return { id, title: id, start, end, allDay, borderColor: `#${id.padEnd(6, "0").slice(0, 6)}` };
}

describe("agendaDays", () => {
    it("orders days, drops empty ones and keeps today", () => {
        const days = agendaDays(
            [
                event("b", "2026-11-20T09:00:00", "2026-11-20T10:00:00"),
                event("a", "2026-11-03T09:00:00", "2026-11-03T10:00:00")
            ],
            WINDOW,
            "2026-11-10"
        );
        expect(days.map((day) => day.day)).toEqual(["2026-11-03", "2026-11-10", "2026-11-20"]);
        expect(days[1]?.entries).toEqual([]);
    });

    it("leaves today out when it is not in the window", () => {
        expect(agendaDays([], WINDOW, "2026-12-05")).toEqual([]);
    });

    it("puts all-day events first, then timed ones by start", () => {
        const [day] = agendaDays(
            [
                event("late", "2026-11-05T15:00:00", "2026-11-05T16:00:00"),
                event("early", "2026-11-05T08:00:00", "2026-11-05T09:00:00"),
                event("whole", "2026-11-05", "2026-11-06", true)
            ],
            WINDOW,
            "2026-11-30"
        );
        expect(day?.entries.map((entry) => entry.event.id)).toEqual(["whole", "early", "late"]);
        expect(day?.entries[0]?.start).toBeNull();
        expect(day?.entries[1]?.start).toBe("2026-11-05T08:00:00");
    });

    it("spreads a multi-day event over its days, with an exclusive all-day end", () => {
        const days = agendaDays(
            [event("trip", "2026-11-05", "2026-11-08", true)],
            WINDOW,
            "2026-11-30"
        );
        expect(
            days.filter((day) => day.entries.length).map((day) => [day.day, day.entries[0]?.part])
        ).toEqual([
            ["2026-11-05", "first"],
            ["2026-11-06", "middle"],
            ["2026-11-07", "last"]
        ]);
    });

    it("does not carry a timed event ending at midnight into the next day", () => {
        const days = agendaDays(
            [event("party", "2026-11-05T20:00:00", "2026-11-06T00:00:00")],
            WINDOW,
            "2026-11-30"
        );
        expect(days.filter((day) => day.entries.length).map((day) => day.day)).toEqual([
            "2026-11-05"
        ]);
        expect(days[0]?.entries[0]?.part).toBeNull();
    });

    it("marks a timed event past midnight on both days", () => {
        const days = agendaDays(
            [event("night", "2026-11-05T22:00:00", "2026-11-06T02:00:00")],
            WINDOW,
            "2026-11-30"
        );
        expect(days.filter((day) => day.entries.length).map((day) => day.entries[0]?.part)).toEqual(
            ["first", "last"]
        );
    });

    it("lists only the window's days and treats a task with no end as one day", () => {
        const days = agendaDays(
            [
                event("long", "2026-10-30", "2026-11-03", true),
                event("task", "2026-11-30T09:00:00", undefined),
                event("after", "2026-12-02T09:00:00", "2026-12-02T10:00:00")
            ],
            WINDOW,
            "2026-11-30"
        );
        expect(days.map((day) => day.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-30"]);
        expect(days[0]?.entries[0]?.part).toBe("middle");
        expect(days[1]?.entries[0]?.part).toBe("last");
    });

    it("skips the grid's background shading", () => {
        const shade: EventInput = {
            start: "2026-11-05T00:00:00",
            end: "2026-11-05T10:00:00",
            display: "background"
        };
        expect(agendaDays([shade], WINDOW, "2026-12-30")).toEqual([]);
    });
});

describe("dayDots", () => {
    it("gives one colour per event, capped", () => {
        const [day] = agendaDays(
            ["a1", "b2", "c3", "d4"].map((id, index) =>
                event(id, `2026-11-05T0${index}:00:00`, `2026-11-05T0${index}:30:00`)
            ),
            WINDOW,
            "2026-12-30"
        );
        expect(dayDots(day, 3)).toEqual(["#a10000", "#b20000", "#c30000"]);
        expect(dayDots(undefined, 3)).toEqual([]);
    });
});
