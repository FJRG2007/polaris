/**
 * U13: free/busy - what blocks time, merging, and "find a time" suggestions
 * inside working hours.
 */

import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

function occurrence(start: string, end: string, change: Partial<engine.CalendarEvent> = {}): engine.Occurrence {
    const event = engine.newEvent({ start: { dateTime: start.slice(0, 19), tzid: "UTC" }, end: { dateTime: end.slice(0, 19), tzid: "UTC" }, ...change });
    return { uid: event.uid, recurrenceKey: start, start: new Date(start), end: new Date(end), allDay: false, startDate: null, endDate: null, overridden: false, recurring: false, event };
}

const busy = (start: string, end: string, type: engine.BusyInterval["type"] = "BUSY"): engine.BusyInterval => ({ start: new Date(start), end: new Date(end), type });
const iso = (intervals: { start: Date; end: Date }[]) => intervals.map((interval) => `${interval.start.toISOString().slice(11, 16)}-${interval.end.toISOString().slice(11, 16)}`);

describe("busyFromOccurrences", () => {
    it("blocks only what really blocks", () => {
        const me = "me@example.com";
        const declined: engine.Attendee = { email: me, name: "", role: "REQ-PARTICIPANT", partstat: "DECLINED", rsvp: false, type: "INDIVIDUAL" };
        const found = engine.busyFromOccurrences(
            [
                occurrence("2026-06-01T09:00:00Z", "2026-06-01T10:00:00Z"),
                occurrence("2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z", { transparency: "TRANSPARENT" }),
                occurrence("2026-06-01T11:00:00Z", "2026-06-01T12:00:00Z", { status: "CANCELLED" }),
                occurrence("2026-06-01T12:00:00Z", "2026-06-01T13:00:00Z", { attendees: [declined] }),
                occurrence("2026-06-01T13:00:00Z", "2026-06-01T14:00:00Z", { status: "TENTATIVE" }),
                occurrence("2026-06-01T14:00:00Z", "2026-06-01T18:00:00Z", { kind: "outOfOffice" })
            ],
            { selfEmail: "Me@Example.com" }
        );
        expect(found.map((interval) => interval.type)).toEqual(["BUSY", "BUSY-TENTATIVE", "BUSY-UNAVAILABLE"]);
        expect(iso(found)).toEqual(["09:00-10:00", "13:00-14:00", "14:00-18:00"]);
    });
});

describe("mergeBusy", () => {
    it("joins overlapping and touching intervals, the strongest kind winning", () => {
        const merged = engine.mergeBusy([
            busy("2026-06-01T11:00:00Z", "2026-06-01T12:00:00Z"),
            busy("2026-06-01T09:00:00Z", "2026-06-01T10:00:00Z"),
            busy("2026-06-01T09:30:00Z", "2026-06-01T11:00:00Z"),
            busy("2026-06-01T13:00:00Z", "2026-06-01T15:00:00Z", "BUSY-TENTATIVE"),
            busy("2026-06-01T14:00:00Z", "2026-06-01T14:30:00Z", "BUSY-UNAVAILABLE")
        ]);
        expect(merged.map((interval) => `${iso([interval])[0]} ${interval.type}`)).toEqual(["09:00-12:00 BUSY", "13:00-14:00 BUSY-TENTATIVE", "14:00-14:30 BUSY-UNAVAILABLE", "14:30-15:00 BUSY-TENTATIVE"]);
        expect(engine.mergeBusy([])).toEqual([]);
    });

    it("gives what comparing every interval with every stretch gives, for many intervals", () => {
        const types: engine.BusyInterval["type"][] = ["BUSY-TENTATIVE", "BUSY", "BUSY-UNAVAILABLE"];
        const rank = (type: engine.BusyInterval["type"]) => types.indexOf(type);
        // Every interval against every stretch between two boundaries.
        const reference = (intervals: engine.BusyInterval[]) => {
            const points = [...new Set(intervals.flatMap((interval) => [interval.start.getTime(), interval.end.getTime()]))].sort((a, b) => a - b);
            const pieces: engine.BusyInterval[] = [];
            for (let index = 0; index + 1 < points.length; index++) {
                const from = points[index] ?? 0;
                const to = points[index + 1] ?? 0;
                let type: engine.BusyInterval["type"] | null = null;
                for (const interval of intervals) if (interval.start.getTime() <= from && interval.end.getTime() >= to && (type === null || rank(interval.type) > rank(type))) type = interval.type;
                if (!type) continue;
                const last = pieces[pieces.length - 1];
                if (last && last.type === type && last.end.getTime() === from) pieces[pieces.length - 1] = { ...last, end: new Date(to) };
                else pieces.push({ start: new Date(from), end: new Date(to), type });
            }
            return pieces;
        };
        let seed = 7;
        const random = (max: number) => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed % max;
        };
        const base = new Date("2026-06-01T00:00:00Z").getTime();
        for (let round = 0; round < 20; round++) {
            const intervals = Array.from({ length: 60 }, () => {
                const start = base + random(96) * 900_000;
                return { start: new Date(start), end: new Date(start + random(12) * 900_000), type: types[random(3)] ?? "BUSY" };
            });
            expect(engine.mergeBusy(intervals)).toEqual(reference(intervals));
        }
        const many = Array.from({ length: 50_000 }, (_, index) => busy(new Date(base + index * 60_000).toISOString(), new Date(base + index * 60_000 + 90_000).toISOString()));
        expect(engine.mergeBusy(many)).toEqual([{ start: new Date(base), end: new Date(base + 49_999 * 60_000 + 90_000), type: "BUSY" }]);
    });
});

describe("suggestTimes", () => {
    const workingHours: engine.WorkingHours = {
        "0": [],
        "1": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "17:00" }],
        "2": [{ from: "09:00", to: "17:00" }],
        "3": [{ from: "09:00", to: "17:00" }],
        "4": [{ from: "09:00", to: "17:00" }],
        "5": [{ from: "09:00", to: "15:00" }],
        "6": []
    };

    it("finds times everybody is free inside working hours in the zone", () => {
        // Monday 2026-06-01, Madrid is UTC+2.
        const found = engine.suggestTimes({
            busy: [[busy("2026-06-01T07:00:00Z", "2026-06-01T08:00:00Z")], [busy("2026-06-01T08:30:00Z", "2026-06-01T10:30:00Z")]],
            durationMinutes: 60,
            from: new Date("2026-06-01T00:00:00Z"),
            to: new Date("2026-06-02T00:00:00Z"),
            zone: "Europe/Madrid",
            workingHours,
            stepMinutes: 30,
            limit: 10,
            now: new Date("2026-05-01T00:00:00Z")
        });
        // Local: 09-10 and 10:30-12:30 busy, so nothing fits the morning
        // window (09-13); the afternoon one (14-17) is free.
        expect(found.map((slot) => engine.formatWall(engine.instantToWall(slot.start, "Europe/Madrid")).slice(11, 16))).toEqual(["14:00", "14:30", "15:00", "15:30", "16:00"]);
    });

    it("never suggests the past, a weekend or past the limit", () => {
        const found = engine.suggestTimes({
            busy: [],
            durationMinutes: 30,
            from: new Date("2026-06-05T00:00:00Z"),
            to: new Date("2026-06-09T00:00:00Z"),
            zone: "Europe/Madrid",
            workingHours,
            stepMinutes: 60,
            limit: 4,
            now: new Date("2026-06-05T10:10:00Z")
        });
        // Friday from 13:00 local (now is 12:10), until 15:00; then Monday.
        expect(found.map((slot) => engine.formatWall(engine.instantToWall(slot.start, "Europe/Madrid")).slice(0, 16))).toEqual(["2026-06-05T13:00", "2026-06-05T14:00", "2026-06-08T09:00", "2026-06-08T10:00"]);
    });

    it("uses the whole day when there are no working hours", () => {
        const found = engine.suggestTimes({ busy: [], durationMinutes: 60, from: new Date("2026-06-06T00:00:00Z"), to: new Date("2026-06-06T03:00:00Z"), zone: "UTC", workingHours: null, stepMinutes: 60, limit: 10, now: new Date(0) });
        expect(iso(found)).toEqual(["00:00-01:00", "01:00-02:00", "02:00-03:00"]);
    });
});
