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
import { createDisplayFormat, DISPLAY_DEFAULTS, type DisplayFormat } from "@polaris/core";

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
        const allDay = layout.taskEntry(task({ dueDate: new Date(2026, 7, 5, 0, 0).toISOString(), timed: false }));
        const timed = layout.taskEntry(task({ dueDate: new Date(2026, 7, 5, 14, 0).toISOString(), timed: true }));
        expect(allDay?.allDay).toBe(true);
        expect(timed?.allDay).toBe(false);
        expect(layout.minutesInto(timed?.start as Date)).toBe(14 * 60);
    });

    it("falls back to the start date when a task has no deadline", () => {
        const entry = layout.taskEntry(task({ startDate: new Date(2026, 7, 3, 9, 0).toISOString() }));
        expect(entry?.start.getDate()).toBe(3);
    });

    it("keeps an all-day event on the day it says, whatever the reader's timezone", () => {
        const entry = layout.googleEntry(event({ start: "2026-08-05", end: "2026-08-06", allDay: true }));
        expect(entry.start.getDate()).toBe(5);
        expect(layout.coversDay(entry, new Date(2026, 7, 5))).toBe(true);
        // Google's end is the morning after; a one-day event must not spill.
        expect(layout.coversDay(entry, new Date(2026, 7, 6))).toBe(false);
    });

    it("puts a multi-day event on every day it covers", () => {
        const entry = layout.googleEntry(event({ start: "2026-08-05", end: "2026-08-08", allDay: true }));
        expect([5, 6, 7].every((day) => layout.coversDay(entry, new Date(2026, 7, day)))).toBe(true);
        expect(layout.coversDay(entry, new Date(2026, 7, 9))).toBe(false);
    });

    it("lists a day with the all-day items first and the rest in clock order", () => {
        const entries = [
            layout.googleEntry(event({ id: "late", start: new Date(2026, 7, 5, 16, 0).toISOString() })),
            layout.googleEntry(event({ id: "early", start: new Date(2026, 7, 5, 9, 0).toISOString() })),
            layout.googleEntry(event({ id: "whole", start: "2026-08-05", end: "2026-08-06", allDay: true }))
        ];
        expect(layout.entriesOnDay(entries, new Date(2026, 7, 5)).map((entry) => entry.key)).toEqual([
            "google:whole",
            "google:early",
            "google:late"
        ]);
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
