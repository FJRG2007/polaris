/**
 * What the calendar draws.
 *
 * The rules being protected here are the ones a rendered grid hides: a month
 * always runs in whole weeks from whichever day the account starts its week on,
 * an all-day event lands on the day it says regardless of the reader's timezone,
 * and two things happening at once end up beside each other rather than one on
 * top of the other.
 */

import { describe, expect, it } from "vitest";
import type { TaskRow } from "@/lib/tasks/facts";
import * as layout from "@/app/(app)/tasks/views/calendar-layout";
import type { GoogleEvent } from "@/lib/google-calendar/events-client";
import {
    createDisplayFormat,
    DISPLAY_DEFAULTS,
    keysOf,
    resolveShortcuts,
    type DisplayFormat
} from "@polaris/core";

const FORMAT: DisplayFormat = createDisplayFormat(DISPLAY_DEFAULTS);

/** A Wednesday, so a week has days on both sides of it. */
const NOW = new Date(2026, 7, 5, 12, 0, 0);

function task(overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        id: "task-1",
        reference: "ENG-1",
        name: "Ship it",
        description: "",
        spaceId: "space-1",
        spaceName: "Engineering",
        listId: "list-1",
        listName: "Backlog",
        folderName: null,
        parentId: null,
        statusId: "status-1",
        statusName: "Open",
        statusColor: "#2563eb",
        statusType: "open",
        priority: "none",
        assignees: [],
        tags: [],
        createdById: null,
        startDate: null,
        dueDate: null,
        timed: false,
        timeEstimate: null,
        points: null,
        milestone: false,
        archived: false,
        order: 1,
        sprintId: null,
        completedAt: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        subtaskCount: 0,
        commentCount: 0,
        trackedSeconds: 0,
        blocked: false,
        blockedUntil: null,
        blockedNote: "",
        recurring: false,
        customValues: {},
        ...overrides
    };
}

function event(overrides: Partial<GoogleEvent> = {}): GoogleEvent {
    return {
        id: "event-1",
        title: "Standup",
        start: new Date(2026, 7, 5, 9, 0, 0).toISOString(),
        end: new Date(2026, 7, 5, 9, 30, 0).toISOString(),
        allDay: false,
        location: null,
        url: null,
        ...overrides
    };
}

describe("the range a scope covers", () => {
    it("gives a month whole weeks, beginning on the day the account chose", () => {
        for (const weekStartsOn of [0, 1, 6]) {
            const range = layout.buildRange("month", 0, weekStartsOn, FORMAT, NOW);
            expect(range.days.length % 7).toBe(0);
            expect(range.days[0]?.getDay()).toBe(weekStartsOn);
            expect(range.label).toBe("August 2026");
            // The whole month is covered, spill days included.
            expect(range.days[0]?.getTime()).toBeLessThanOrEqual(new Date(2026, 7, 1).getTime());
            expect(range.days[range.days.length - 1]?.getTime()).toBeGreaterThanOrEqual(
                new Date(2026, 7, 31).getTime()
            );
        }
    });

    it("gives a week seven days from that same first day", () => {
        const range = layout.buildRange("week", 0, 0, FORMAT, NOW);
        expect(range.days).toHaveLength(7);
        expect(range.days[0]?.getDay()).toBe(0);
        expect(range.days[0]?.getTime()).toBeLessThanOrEqual(NOW.getTime());
    });

    it("moves by whole scopes, so paging never lands mid-week or mid-month", () => {
        expect(layout.buildRange("day", 1, 1, FORMAT, NOW).days[0]?.getDate()).toBe(6);
        expect(layout.buildRange("week", -1, 1, FORMAT, NOW).days[0]?.getDate()).toBe(27);
        expect(layout.buildRange("month", 1, 1, FORMAT, NOW).label).toBe("September 2026");
    });
});

describe("what lands on a day", () => {
    it("draws an undated task nowhere", () => {
        expect(layout.taskEntry(task())).toBeNull();
    });

    it("treats a task with no time of day as all-day, and one with a time as timed", () => {
        const allDay = layout.taskEntry(
            task({ dueDate: new Date(2026, 7, 5, 0, 0).toISOString(), timed: false })
        );
        const timed = layout.taskEntry(
            task({ dueDate: new Date(2026, 7, 5, 14, 0).toISOString(), timed: true })
        );
        expect(allDay?.allDay).toBe(true);
        expect(timed?.allDay).toBe(false);
        expect(layout.minutesInto(timed?.start as Date)).toBe(14 * 60);
    });

    it("falls back to the start date when a task has no deadline", () => {
        const entry = layout.taskEntry(
            task({ startDate: new Date(2026, 7, 3, 9, 0).toISOString() })
        );
        expect(entry?.start.getDate()).toBe(3);
    });

    it("keeps an all-day event on the day it says, whatever the reader's timezone", () => {
        const entry = layout.googleEntry(
            event({ start: "2026-08-05", end: "2026-08-06", allDay: true })
        );
        expect(entry.start.getDate()).toBe(5);
        expect(layout.coversDay(entry, new Date(2026, 7, 5))).toBe(true);
        // Google's end is the morning after; a one-day event must not spill.
        expect(layout.coversDay(entry, new Date(2026, 7, 6))).toBe(false);
    });

    it("puts a multi-day event on every day it covers", () => {
        const entry = layout.googleEntry(
            event({ start: "2026-08-05", end: "2026-08-08", allDay: true })
        );
        expect([5, 6, 7].every((day) => layout.coversDay(entry, new Date(2026, 7, day)))).toBe(
            true
        );
        expect(layout.coversDay(entry, new Date(2026, 7, 9))).toBe(false);
    });

    it("counts a day in the year on the same days the other views place an entry", () => {
        const entries = [
            layout.googleEntry(
                event({ id: "one", start: "2026-08-05", end: "2026-08-06", allDay: true })
            ),
            layout.googleEntry(
                event({ id: "three", start: "2026-08-05", end: "2026-08-08", allDay: true })
            ),
            layout.googleEntry(
                event({
                    id: "midnight",
                    start: new Date(2026, 7, 9, 22, 0).toISOString(),
                    end: new Date(2026, 7, 10, 0, 0).toISOString()
                })
            )
        ];
        const counts = layout.countByDay(entries, new Date(2026, 0, 1), new Date(2026, 11, 31));
        for (const day of [4, 5, 6, 7, 8, 9, 10]) {
            const date = new Date(2026, 7, day);
            const placed = entries.filter((entry) => layout.coversDay(entry, date)).length;
            expect(counts.get(date.toDateString()) ?? 0, `Aug ${day}`).toBe(placed);
        }
        expect(counts.get(new Date(2026, 7, 8).toDateString())).toBeUndefined();
        expect(counts.get(new Date(2026, 7, 10).toDateString())).toBeUndefined();
    });

    it("lists a day with the all-day items first and the rest in clock order", () => {
        const entries = [
            layout.googleEntry(
                event({ id: "late", start: new Date(2026, 7, 5, 16, 0).toISOString() })
            ),
            layout.googleEntry(
                event({ id: "early", start: new Date(2026, 7, 5, 9, 0).toISOString() })
            ),
            layout.googleEntry(
                event({ id: "whole", start: "2026-08-05", end: "2026-08-06", allDay: true })
            )
        ];
        expect(
            layout.entriesOnDay(entries, new Date(2026, 7, 5)).map((entry) => entry.key)
        ).toEqual(["google:whole", "google:early", "google:late"]);
    });
});

describe("things happening at the same time", () => {
    const at = (hour: number, minute: number, minutes: number) =>
        layout.googleEntry(
            event({
                id: `${hour}:${minute}`,
                start: new Date(2026, 7, 5, hour, minute).toISOString(),
                end: new Date(2026, 7, 5, hour, minute + minutes).toISOString()
            })
        );

    it("puts overlapping entries in their own lanes, at the width of the busiest moment", () => {
        const placed = layout.laneOut([at(9, 0, 60), at(9, 30, 60), at(9, 45, 30)]);
        expect(placed.map((item) => item.lane)).toEqual([0, 1, 2]);
        expect(placed.every((item) => item.lanes === 3)).toBe(true);
    });

    it("gives a run its own width, so a busy morning does not narrow the afternoon", () => {
        const placed = layout.laneOut([at(9, 0, 60), at(9, 30, 60), at(15, 0, 30)]);
        expect(placed[2]?.lanes).toBe(1);
        expect(placed[0]?.lanes).toBe(2);
    });

    it("reuses a lane once its occupant has finished", () => {
        const placed = layout.laneOut([at(9, 0, 30), at(9, 15, 60), at(9, 30, 30)]);
        expect(placed.map((item) => item.lane)).toEqual([0, 1, 0]);
    });
});

describe("the scopes Google offers beside these", () => {
    it("answers each of Google's keys with its scope, and nothing else", () => {
        const bindings = resolveShortcuts();
        const scopeOf = (key: string) =>
            layout.CALENDAR_SCOPES.find((scope) =>
                keysOf(bindings, layout.SCOPE_SHORTCUTS[scope]).includes(key)
            ) ?? null;
        expect(scopeOf("d")).toBe("day");
        expect(scopeOf("w")).toBe("week");
        expect(scopeOf("m")).toBe("month");
        expect(scopeOf("y")).toBe("year");
        expect(scopeOf("a")).toBe("schedule");
        expect(scopeOf("x")).toBe("fourDays");
        expect(scopeOf("q")).toBeNull();
        expect(scopeOf("Enter")).toBeNull();
    });

    it("gives four days from today, paging four at a time", () => {
        const range = layout.buildRange("fourDays", 0, 0, FORMAT, NOW);
        expect(range.days.map((day) => day.getDate())).toEqual([5, 6, 7, 8]);
        expect(layout.buildRange("fourDays", 1, 0, FORMAT, NOW).days[0]?.getDate()).toBe(9);
    });

    it("gives a whole calendar year, leap day included", () => {
        const range = layout.buildRange("year", 2, 0, FORMAT, NOW);
        expect(range.label).toBe("2028");
        expect(range.days).toHaveLength(366);
        expect(range.days[0]?.getMonth()).toBe(0);
        expect(range.days[365]?.getDate()).toBe(31);
    });

    it("gives a schedule four weeks from today", () => {
        const range = layout.buildRange("schedule", 1, 0, FORMAT, NOW);
        expect(range.days).toHaveLength(layout.SCHEDULE_DAYS);
        expect(range.days[0]?.getTime()).toBe(
            new Date(2026, 7, 5 + layout.SCHEDULE_DAYS).getTime()
        );
    });

    it("drops Saturday and Sunday from a week and a month when weekends are hidden", () => {
        const week = layout.buildRange("week", 0, 1, FORMAT, NOW, "en-US", false);
        expect(week.days.map((day) => day.getDay())).toEqual([1, 2, 3, 4, 5]);
        const month = layout.buildRange("month", 0, 0, FORMAT, NOW, "en-US", false);
        expect(month.days.length % 5).toBe(0);
        expect(month.days.some(layout.isWeekend)).toBe(false);
        // A single day is shown whatever it is.
        const saturday = layout.buildRange("day", 3, 0, FORMAT, NOW, "en-US", false);
        expect(saturday.days[0]?.getDay()).toBe(6);
    });

    it("pages four working days across a weekend without leaving a gap", () => {
        // Wednesday the 5th: Wed, Thu, Fri, Mon - then Tue, Wed, Thu, Fri.
        expect(layout.workdaysFrom(NOW, 0, 4).map((day) => day.getDate())).toEqual([5, 6, 7, 10]);
        expect(layout.workdaysFrom(NOW, 4, 4).map((day) => day.getDate())).toEqual([
            11, 12, 13, 14
        ]);
        expect(layout.workdaysFrom(NOW, -4, 4).map((day) => day.getDate())).toEqual([30, 31, 3, 4]);
        // Starting on a Saturday begins on the Monday after.
        expect(layout.workdaysFrom(new Date(2026, 7, 8), 0, 1)[0]?.getDate()).toBe(10);
    });

    it("lays a year's month out in whole weeks from the account's first day", () => {
        // August 2026 begins on a Saturday.
        const weeks = layout.monthWeeks(2026, 7, 0);
        expect(weeks[0]?.slice(0, 6).every((cell) => cell === null)).toBe(true);
        expect(weeks[0]?.[6]?.getDate()).toBe(1);
        expect(weeks.flat().filter(Boolean)).toHaveLength(31);
        expect(weeks.every((week) => week.length === 7)).toBe(true);
        expect(layout.monthWeeks(2026, 7, 6)[0]?.[0]?.getDate()).toBe(1);
    });
});

describe("how much a month cell shows", () => {
    const line = layout.CHIP_HEIGHT + layout.CHIP_GAP;

    it("shows everything that fits, with no '+N more' when nothing is left over", () => {
        expect(layout.chipsThatFit(line * 6, 6)).toBe(6);
        expect(layout.chipsThatFit(line * 10, 3)).toBe(3);
    });

    it("gives one line up to the count when the rest does not fit", () => {
        expect(layout.chipsThatFit(line * 3, 7)).toBe(2);
        expect(layout.chipsThatFit(layout.CHIP_HEIGHT, 2)).toBe(0);
    });

    it("draws a few before anything has measured the cell", () => {
        expect(layout.chipsThatFit(0, 2)).toBe(2);
        expect(layout.chipsThatFit(0, 9)).toBe(3);
    });
});

describe("ticking a task off from the calendar", () => {
    const statuses = [
        { id: "todo", type: "open" as const },
        { id: "doing", type: "active" as const },
        { id: "done", type: "done" as const },
        { id: "dropped", type: "closed" as const }
    ];

    it("moves unfinished work to done, and finished work back to where it starts", () => {
        expect(layout.completionTarget({ statusId: "doing", statusType: "active" }, statuses)).toBe(
            "done"
        );
        expect(layout.completionTarget({ statusId: "done", statusType: "done" }, statuses)).toBe(
            "todo"
        );
        expect(
            layout.completionTarget({ statusId: "dropped", statusType: "closed" }, statuses)
        ).toBe("todo");
    });

    it("offers nothing for a task from a space whose statuses the screen does not hold", () => {
        expect(
            layout.completionTarget({ statusId: "elsewhere", statusType: "open" }, statuses)
        ).toBeNull();
        expect(
            layout.completionTarget({ statusId: null, statusType: "open" }, statuses)
        ).toBeNull();
        expect(
            layout.completionTarget({ statusId: "todo", statusType: "open" }, statuses.slice(0, 1))
        ).toBeNull();
    });

    it("draws a finished task and a declined event struck through, and hides them on request", () => {
        const finished = layout.taskEntry(task({ dueDate: NOW.toISOString(), statusType: "done" }));
        const declined = layout.googleEntry(event({ declined: true }));
        const accepted = layout.googleEntry(event({ id: "other" }));
        expect(finished?.settled).toBe(true);
        expect(declined.settled).toBe(true);
        expect(accepted.settled).toBe(false);
        const hideAll = { showWeekends: true, showDeclined: false, showCompleted: false };
        expect(layout.isShown(finished as layout.CalendarEntry, hideAll)).toBe(false);
        expect(layout.isShown(declined, hideAll)).toBe(false);
        expect(layout.isShown(accepted, hideAll)).toBe(true);
        expect(layout.isShown(finished as layout.CalendarEntry, layout.DEFAULT_OPTIONS)).toBe(true);
    });
});
