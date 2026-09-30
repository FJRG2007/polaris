/**
 * U10: editing and deleting recurring events - this, this and following, all -
 * plus drag/resize, duplicating and answering.
 */

import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

const MADRID = "Europe/Madrid";

function series(rule = "FREQ=WEEKLY;COUNT=10", extra: string[] = []): engine.CalendarItem {
    const text = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:series@example.com",
        "DTSTAMP:20260101T000000Z",
        "SEQUENCE:1",
        "SUMMARY:Planning",
        `DTSTART;TZID=${MADRID}:20260302T090000`,
        `DTEND;TZID=${MADRID}:20260302T100000`,
        `RRULE:${rule}`,
        `EXDATE;TZID=${MADRID}:20260323T090000`,
        "ORGANIZER:mailto:owner@example.com",
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.com",
        "X-KEEP-ME:yes",
        ...extra,
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:series@example.com",
        "DTSTAMP:20260101T000000Z",
        "SEQUENCE:1",
        "SUMMARY:Planning (late)",
        `RECURRENCE-ID;TZID=${MADRID}:20260316T090000`,
        `DTSTART;TZID=${MADRID}:20260316T110000`,
        `DTEND;TZID=${MADRID}:20260316T120000`,
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.com",
        "END:VEVENT",
        "END:VCALENDAR"
    ].join("\r\n");
    const [item] = engine.parseCalendarText(text).items;
    if (!item) throw new Error("no item");
    return item;
}

const range = { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-06-01T00:00:00Z") };
const local = (item: engine.CalendarItem) =>
    engine.expandItem(item, range, { floatingZone: "UTC" }).map((occurrence) => `${engine.formatWall(engine.instantToWall(occurrence.start, MADRID)).slice(0, 16)} ${occurrence.event.summary}`);
const master = (item: engine.CalendarItem | null) => {
    if (!item || item.component !== "VEVENT" || !item.master) throw new Error("no master");
    return item.master;
};
const overrides = (item: engine.CalendarItem | null) => (item && item.component === "VEVENT" ? item.overrides : []);
const occurrence = (item: engine.CalendarItem, key: string) => {
    const found = engine.occurrenceFor(item, key, "UTC");
    if (!found) throw new Error(`no occurrence ${key}`);
    return found;
};

const MAR_9 = "2026-03-09T08:00:00.000Z";
const MAR_16 = "2026-03-16T08:00:00.000Z";
const MAR_30 = "2026-03-30T07:00:00.000Z";

describe("applyEdit - this occurrence", () => {
    it("writes an override and leaves the series alone", () => {
        const item = series();
        const next = { ...occurrence(item, MAR_9).event, summary: "Planning (special)" };
        const edited = engine.applyEdit(item, MAR_9, { ...next, start: { dateTime: "2026-03-09T09:00:00", tzid: MADRID }, end: { dateTime: "2026-03-09T10:00:00", tzid: MADRID } }, "this");
        expect(edited.split).toBeNull();
        expect(master(edited.item)).toEqual(master(item));
        const added = overrides(edited.item).find((event) => event.summary === "Planning (special)");
        expect(added?.recurrenceId).toEqual({ dateTime: "2026-03-09T09:00:00", tzid: MADRID });
        expect(added?.rule).toBeNull();
        // Not moved: SEQUENCE stays.
        expect(added?.sequence).toBe(1);
        expect(local(edited.item)).toContain("2026-03-09T09:00 Planning (special)");
    });

    it("replaces the override an occurrence already has, and bumps SEQUENCE when it moves", () => {
        const item = series();
        const current = occurrence(item, MAR_16).event;
        const edited = engine.applyEdit(item, MAR_16, { ...current, start: { dateTime: "2026-03-17T08:00:00", tzid: MADRID }, end: { dateTime: "2026-03-17T08:30:00", tzid: MADRID } }, "this");
        expect(overrides(edited.item)).toHaveLength(1);
        expect(overrides(edited.item)[0]?.sequence).toBe(2);
        expect(local(edited.item)).toContain("2026-03-17T08:00 Planning (late)");
        expect(local(edited.item).some((line) => line.startsWith("2026-03-16"))).toBe(false);
    });
});

describe("applyEdit - all occurrences", () => {
    it("moves the series by the occurrence's change and keeps overrides and EXDATEs matching", () => {
        const item = series();
        const current = occurrence(item, MAR_9).event;
        const next = { ...current, summary: "Planning v2", start: { dateTime: "2026-03-09T10:00:00", tzid: MADRID }, end: { dateTime: "2026-03-09T11:30:00", tzid: MADRID } };
        const edited = engine.applyEdit(item, MAR_9, next, "all");
        const updated = master(edited.item);
        expect(updated.start).toEqual({ dateTime: "2026-03-02T10:00:00", tzid: MADRID });
        expect(updated.end).toEqual({ dateTime: "2026-03-02T11:30:00", tzid: MADRID });
        expect(updated.sequence).toBe(2);
        expect(updated.exdates).toEqual([{ dateTime: "2026-03-23T10:00:00", tzid: MADRID }]);
        expect(updated.extra.map((entry) => entry.line)).toContain("X-KEEP-ME:yes");
        expect(overrides(edited.item)[0]?.recurrenceId).toEqual({ dateTime: "2026-03-16T10:00:00", tzid: MADRID });
        expect(local(edited.item)).toEqual([
            "2026-03-02T10:00 Planning v2",
            "2026-03-09T10:00 Planning v2",
            "2026-03-16T11:00 Planning (late)",
            "2026-03-30T10:00 Planning v2",
            "2026-04-06T10:00 Planning v2",
            "2026-04-13T10:00 Planning v2",
            "2026-04-20T10:00 Planning v2",
            "2026-04-27T10:00 Planning v2",
            "2026-05-04T10:00 Planning v2"
        ]);
    });

    it("changes only the details when the time stays, without bumping SEQUENCE", () => {
        const item = series();
        const edited = engine.applyEdit(item, null, { ...master(item), location: "Room 2" }, "all");
        expect(master(edited.item).location).toBe("Room 2");
        expect(master(edited.item).sequence).toBe(1);
        expect(overrides(edited.item)).toEqual(overrides(item));
    });
});

describe("applyEdit - this and following", () => {
    it("ends a counted series before the occurrence and starts a new one with what was left", () => {
        const item = series();
        const current = occurrence(item, MAR_30).event;
        const next = { ...current, summary: "Evening planning", start: { dateTime: "2026-03-30T18:00:00", tzid: MADRID }, end: { dateTime: "2026-03-30T19:00:00", tzid: MADRID } };
        const edited = engine.applyEdit(item, MAR_30, next, "following");
        expect(master(edited.item).rule?.raw).toBe("FREQ=WEEKLY;COUNT=4");
        expect(master(edited.item).sequence).toBe(2);
        const split = edited.split;
        expect(split?.uid).not.toBe(item.uid);
        expect(master(split).rule?.raw).toBe("FREQ=WEEKLY;COUNT=6");
        expect(master(split).sequence).toBe(0);
        expect(local(edited.item)).toEqual(["2026-03-02T09:00 Planning", "2026-03-09T09:00 Planning", "2026-03-16T11:00 Planning (late)"]);
        expect(local(split as engine.CalendarItem)).toEqual(["2026-03-30T18:00 Evening planning", "2026-04-06T18:00 Evening planning", "2026-04-13T18:00 Evening planning", "2026-04-20T18:00 Evening planning", "2026-04-27T18:00 Evening planning", "2026-05-04T18:00 Evening planning"]);
    });

    it("ends an open series with UNTIL in UTC and moves later overrides and EXDATEs over", () => {
        const item = series("FREQ=WEEKLY");
        const current = occurrence(item, MAR_9).event;
        const edited = engine.applyEdit(item, MAR_9, { ...current, summary: "New", start: { dateTime: "2026-03-09T09:00:00", tzid: MADRID }, end: { dateTime: "2026-03-09T10:00:00", tzid: MADRID } }, "following");
        expect(master(edited.item).rule?.until).toEqual({ dateTime: "2026-03-09T07:59:59", tzid: "UTC" });
        expect(master(edited.item).exdates).toEqual([]);
        expect(overrides(edited.item)).toEqual([]);
        const split = edited.split as engine.CalendarItem;
        expect(master(split).exdates).toEqual([{ dateTime: "2026-03-23T09:00:00", tzid: MADRID }]);
        expect(overrides(split)[0]?.uid).toBe(split.uid);
        expect(local(edited.item)).toEqual(["2026-03-02T09:00 Planning"]);
        expect(local(split).slice(0, 4)).toEqual(["2026-03-09T09:00 New", "2026-03-16T11:00 Planning (late)", "2026-03-30T09:00 New", "2026-04-06T09:00 New"]);
    });

    it("is an edit of everything from the first occurrence", () => {
        const item = series();
        const first = "2026-03-02T08:00:00.000Z";
        const edited = engine.applyEdit(item, first, { ...occurrence(item, first).event, summary: "Renamed" }, "following");
        expect(edited.split).toBeNull();
        expect(master(edited.item).summary).toBe("Renamed");
    });
});

describe("deleteOccurrences", () => {
    it("deletes one occurrence with an EXDATE, and its override with it", () => {
        const one = engine.deleteOccurrences(series(), MAR_9, "this");
        expect(master(one).exdates).toContainEqual({ dateTime: "2026-03-09T09:00:00", tzid: MADRID });
        expect(local(one as engine.CalendarItem).some((line) => line.startsWith("2026-03-09"))).toBe(false);
        const moved = engine.deleteOccurrences(series(), MAR_16, "this");
        expect(overrides(moved)).toEqual([]);
        expect(local(moved as engine.CalendarItem).some((line) => line.includes("late"))).toBe(false);
    });

    it("deletes this and the following ones", () => {
        const left = engine.deleteOccurrences(series(), MAR_16, "following");
        expect(master(left).rule?.raw).toBe("FREQ=WEEKLY;COUNT=2");
        expect(overrides(left)).toEqual([]);
        expect(local(left as engine.CalendarItem)).toEqual(["2026-03-02T09:00 Planning", "2026-03-09T09:00 Planning"]);
    });

    it("deletes the whole object for 'all', for 'following' from the first, and for the last one left", () => {
        expect(engine.deleteOccurrences(series(), MAR_9, "all")).toBeNull();
        expect(engine.deleteOccurrences(series(), null, "this")).toBeNull();
        expect(engine.deleteOccurrences(series(), "2026-03-02T08:00:00.000Z", "following")).toBeNull();
        const single = series("FREQ=DAILY;COUNT=1");
        expect(engine.deleteOccurrences(single, "2026-03-02T08:00:00.000Z", "this")).toBeNull();
    });
});

describe("shiftOccurrence", () => {
    it("drags one occurrence an hour later", () => {
        const moved = engine.shiftOccurrence(series(), MAR_9, 3_600_000, 3_600_000, "this");
        const override = overrides(moved.item).find((event) => event.recurrenceId && "dateTime" in event.recurrenceId && event.recurrenceId.dateTime === "2026-03-09T09:00:00");
        expect(override?.start).toEqual({ dateTime: "2026-03-09T10:00:00", tzid: MADRID });
        expect(override?.end).toEqual({ dateTime: "2026-03-09T11:00:00", tzid: MADRID });
    });

    it("resizes the whole series by its end", () => {
        const resized = engine.shiftOccurrence(series(), MAR_9, 0, 30 * 60_000, "all");
        expect(master(resized.item).start).toEqual({ dateTime: "2026-03-02T09:00:00", tzid: MADRID });
        expect(master(resized.item).end).toEqual({ dateTime: "2026-03-02T10:30:00", tzid: MADRID });
    });

    it("moves all-day events in whole days", () => {
        const allDay = engine.eventItem(engine.newEvent({ uid: "day", start: { date: "2026-03-10" }, end: { date: "2026-03-11" } }));
        const moved = engine.shiftOccurrence(allDay, null, 2 * 86_400_000 - 3_600_000, 2 * 86_400_000 - 3_600_000, "all");
        expect(master(moved.item).start).toEqual({ date: "2026-03-12" });
        expect(master(moved.item).end).toEqual({ date: "2026-03-13" });
    });
});

describe("duplicateItem and answers", () => {
    it("copies an item under a new UID with everything else", () => {
        const item = series();
        const copy = engine.duplicateItem(item);
        expect(copy.uid).not.toBe(item.uid);
        expect(master(copy).uid).toBe(copy.uid);
        expect(overrides(copy).every((event) => event.uid === copy.uid)).toBe(true);
        expect(master(copy).extra).toEqual(master(item).extra);
        expect({ ...master(copy), uid: "" }).toEqual({ ...master(item), uid: "" });
    });

    it("answers the whole series or one occurrence", () => {
        const all = engine.setAttendeeStatus(series(), "Guest@Example.com", "ACCEPTED", null);
        expect(master(all).attendees[0]?.partstat).toBe("ACCEPTED");
        expect(overrides(all)[0]?.attendees[0]?.partstat).toBe("ACCEPTED");
        expect(master(all).sequence).toBe(1);
        const one = engine.setAttendeeStatus(series(), "guest@example.com", "DECLINED", MAR_9);
        expect(master(one).attendees[0]?.partstat).toBe("NEEDS-ACTION");
        const override = overrides(one).find((event) => event.recurrenceId && "dateTime" in event.recurrenceId && event.recurrenceId.dateTime === "2026-03-09T09:00:00");
        expect(override?.attendees[0]?.partstat).toBe("DECLINED");
        expect(override?.start).toEqual({ dateTime: "2026-03-09T09:00:00", tzid: MADRID });
    });
});
