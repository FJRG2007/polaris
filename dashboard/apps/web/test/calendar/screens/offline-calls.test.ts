/**
 * Calendar changes kept on this device are drawn on the grid as they will be:
 * a delete gone, a drag moved, a new or saved event where the form put it -
 * and a change that was not made drawn as the server has it.
 */

import { describe, expect, it } from "vitest";
import * as model from "../../../../calendar/src/screens/editor-model";
import type { OccurrenceView, RangeView } from "../../../../calendar/src/lib/wire";
import { keptOccurrence, overwriteArgs, withKeptCalls, type KeptCall } from "../../../../calendar/src/screens/offline-calls";

const occurrence = (objectId: string, start: string, end: string, key = start): OccurrenceView =>
    ({
        objectId,
        calendarId: "c1",
        uid: objectId,
        recurrenceKey: key,
        start,
        end,
        allDay: false,
        startDate: null,
        endDate: null,
        summary: objectId,
        location: "",
        color: null,
        status: null,
        transparent: false,
        recurring: false,
        overridden: false,
        kind: "event",
        attendeeCount: 0,
        myPartstat: null,
        hasAlarms: false,
        busyOnly: false,
        editable: true,
        conference: "",
        categories: []
    }) as unknown as OccurrenceView;

const range = (occurrences: OccurrenceView[]): RangeView => ({
    from: "2026-11-23T00:00:00.000Z",
    to: "2026-11-30T00:00:00.000Z",
    occurrences,
    tasks: [],
    unreadable: 0,
    truncated: false
});

const call = (meta: unknown, state: KeptCall["state"] = "pending", extra: Partial<KeptCall> = {}): KeptCall => ({
    key: Math.random().toString(36),
    target: "t",
    name: "x",
    meta,
    args: [],
    state,
    createdAt: "2026-11-24T00:00:00.000Z",
    ...extra
});

describe("withKeptCalls", () => {
    const a = occurrence("a", "2026-11-24T10:00:00.000Z", "2026-11-24T11:00:00.000Z");
    const b1 = occurrence("b", "2026-11-24T09:00:00.000Z", "2026-11-24T09:30:00.000Z");
    const b2 = occurrence("b", "2026-11-25T09:00:00.000Z", "2026-11-25T09:30:00.000Z");

    it("leaves the window alone with nothing waiting", () => {
        const window = range([a]);
        expect(withKeptCalls(window, [])).toBe(window);
    });

    it("draws deletes, drags and saves, in order, and skips what was not made", () => {
        const shown = withKeptCalls(range([a, b1, b2]), [
            call({ op: "shift", objectId: "a", recurrenceKey: a.recurrenceKey, scope: "all", start: a.start, startDeltaMs: 3_600_000, endDeltaMs: 3_600_000, summary: "a" }),
            call({ op: "delete", objectId: "b", recurrenceKey: b2.recurrenceKey, scope: "following", start: b2.start, summary: "b" }),
            call({ op: "delete", objectId: "a", recurrenceKey: "", scope: "all", start: "", summary: "a" }, "failed")
        ]);
        expect(shown.occurrences.map((entry) => [entry.objectId, entry.start])).toEqual([
            ["a", "2026-11-24T11:00:00.000Z"],
            ["b", "2026-11-24T09:00:00.000Z"]
        ]);
    });

    it("puts a saved event where its form says, and a new one in the window", () => {
        const moved = { ...a, start: "2026-11-26T10:00:00.000Z", end: "2026-11-26T11:00:00.000Z", summary: "Lunch" };
        const fresh = occurrence("new:u1", "2026-11-27T10:00:00.000Z", "2026-11-27T11:00:00.000Z");
        const outside = occurrence("new:u2", "2026-12-27T10:00:00.000Z", "2026-12-27T11:00:00.000Z");
        const shown = withKeptCalls(range([a]), [
            call({ op: "save", objectId: "a", summary: "Lunch", occurrence: moved }),
            call({ op: "save", objectId: null, summary: "", occurrence: fresh }),
            call({ op: "save", objectId: null, summary: "", occurrence: outside })
        ]);
        expect(shown.occurrences.map((entry) => [entry.objectId, entry.summary, entry.start])).toEqual([
            ["a", "Lunch", "2026-11-26T10:00:00.000Z"],
            ["new:u1", "new:u1", "2026-11-27T10:00:00.000Z"]
        ]);
    });
});

describe("keptOccurrence", () => {
    it("draws a timed and an all-day form, and not a repeating one", () => {
        const timed = model.newForm({
            calendarId: "c1",
            zone: "UTC",
            allDay: false,
            start: new Date("2026-11-24T10:00:00.000Z"),
            end: new Date("2026-11-24T11:30:00.000Z"),
            summary: "Standup",
            alarms: []
        });
        const drawn = keptOccurrence("new:u1", timed, "UTC");
        expect([drawn?.start, drawn?.end, drawn?.summary, drawn?.editable]).toEqual([
            "2026-11-24T10:00:00.000Z",
            "2026-11-24T11:30:00.000Z",
            "Standup",
            false
        ]);
        const day = model.newForm({ calendarId: "c1", zone: "UTC", allDay: true, start: "2026-11-24", end: "2026-11-26", alarms: [] });
        const allDay = keptOccurrence("new:u2", day, "UTC");
        expect([allDay?.startDate, allDay?.endDate, allDay?.start]).toEqual(["2026-11-24", "2026-11-26", "2026-11-24T00:00:00.000Z"]);
        const weekly = { ...timed, repeat: { ...timed.repeat, frequency: "WEEKLY" } } as model.EditorForm;
        expect(keptOccurrence("new:u3", weekly, "UTC")).toBeNull();
    });
});

describe("overwriteArgs", () => {
    it("sends a refused save again with no version, and offers nothing else", () => {
        expect(overwriteArgs(call(null, "failed", { name: "saveEventAction", args: [{ version: "v1", objectId: "a" }] }))).toEqual([
            { version: null, objectId: "a" }
        ]);
        expect(overwriteArgs(call(null, "failed", { name: "saveEventAction", args: [{ version: null }] }))).toBeNull();
        expect(overwriteArgs(call(null, "failed", { name: "deleteEventAction", args: [{ version: "v1" }] }))).toBeNull();
    });
});
