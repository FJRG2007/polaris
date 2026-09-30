/**
 * U09: recurrence expansion - the RFC 5545 section 3.8.5.3 examples with the
 * RFC's own dates in America/New_York, DST, overrides, EXDATE, RDATE and
 * RANGE=THISANDFUTURE.
 */

import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

const NY = "America/New_York";

function calendar(...lines: string[]): string {
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR"].join("\r\n");
}

function event(...lines: string[]): string[] {
    return ["BEGIN:VEVENT", "UID:rfc@example.com", "DTSTAMP:19970901T130000Z", ...lines, "END:VEVENT"];
}

function onlyItem(text: string): engine.CalendarItem {
    const parsed = engine.parseCalendarText(text);
    expect(parsed.errors).toEqual([]);
    const [item] = parsed.items;
    if (!item) throw new Error("no item");
    return item;
}

/** Local New York starts, as `YYYY-MM-DD HH:mm`, of every occurrence in range. */
function series(start: string, rule: string, extra: string[] = [], range = { from: "1996-01-01", to: "2005-01-01" }): string[] {
    const item = onlyItem(calendar(...event(`DTSTART;TZID=${NY}:${start}`, "DURATION:PT1H", `RRULE:${rule}`, ...extra)));
    return engine
        .expandItem(item, { from: new Date(`${range.from}T00:00:00Z`), to: new Date(`${range.to}T00:00:00Z`) }, { floatingZone: "UTC", limit: 10_000 })
        .map((occurrence) => engine.formatWall(engine.instantToWall(occurrence.start, NY)).slice(0, 16).replace("T", " "));
}

const at9 = (...dates: string[]) => dates.map((date) => `${date} 09:00`);

describe("RFC 5545 3.8.5.3 examples", () => {
    it("daily for 10 occurrences", () => {
        expect(series("19970902T090000", "FREQ=DAILY;COUNT=10")).toEqual(at9("1997-09-02", "1997-09-03", "1997-09-04", "1997-09-05", "1997-09-06", "1997-09-07", "1997-09-08", "1997-09-09", "1997-09-10", "1997-09-11"));
    });

    it("daily until December 24, 1997", () => {
        const found = series("19970902T090000", "FREQ=DAILY;UNTIL=19971224T000000Z");
        expect(found).toHaveLength(113);
        expect(found[0]).toBe("1997-09-02 09:00");
        expect(found.at(-1)).toBe("1997-12-23 09:00");
        // The clocks went back on 1997-10-26: still 09:00 local after it.
        expect(found).toContain("1997-10-27 09:00");
    });

    it("every other day, forever (bounded by the range)", () => {
        const found = series("19970902T090000", "FREQ=DAILY;INTERVAL=2", [], { from: "1997-09-01", to: "1997-09-15" });
        expect(found).toEqual(at9("1997-09-02", "1997-09-04", "1997-09-06", "1997-09-08", "1997-09-10", "1997-09-12", "1997-09-14"));
    });

    it("every 10 days, 5 occurrences", () => {
        expect(series("19970902T090000", "FREQ=DAILY;INTERVAL=10;COUNT=5")).toEqual(at9("1997-09-02", "1997-09-12", "1997-09-22", "1997-10-02", "1997-10-12"));
    });

    it("every day in January, for 3 years - both forms", () => {
        const yearly = series("19980101T090000", "FREQ=YEARLY;UNTIL=20000131T140000Z;BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA");
        const daily = series("19980101T090000", "FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1");
        expect(yearly).toHaveLength(93);
        expect(daily).toEqual(yearly);
        expect(yearly.every((start) => start.slice(5, 7) === "01")).toBe(true);
        expect(yearly[0]).toBe("1998-01-01 09:00");
        expect(yearly.at(-1)).toBe("2000-01-31 09:00");
    });

    it("weekly for 10 occurrences", () => {
        expect(series("19970902T090000", "FREQ=WEEKLY;COUNT=10")).toEqual(at9("1997-09-02", "1997-09-09", "1997-09-16", "1997-09-23", "1997-09-30", "1997-10-07", "1997-10-14", "1997-10-21", "1997-10-28", "1997-11-04"));
    });

    it("every other week on Monday, Wednesday and Friday until December 24, 1997", () => {
        expect(series("19970901T090000", "FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR")).toEqual(
            at9(
                "1997-09-01", "1997-09-03", "1997-09-05", "1997-09-15", "1997-09-17", "1997-09-19", "1997-09-29",
                "1997-10-01", "1997-10-03", "1997-10-13", "1997-10-15", "1997-10-17", "1997-10-27", "1997-10-29", "1997-10-31",
                "1997-11-10", "1997-11-12", "1997-11-14", "1997-11-24", "1997-11-26", "1997-11-28",
                "1997-12-08", "1997-12-10", "1997-12-12", "1997-12-22"
            )
        );
    });

    it("monthly on the first Friday for 10 occurrences", () => {
        expect(series("19970905T090000", "FREQ=MONTHLY;COUNT=10;BYDAY=1FR")).toEqual(at9("1997-09-05", "1997-10-03", "1997-11-07", "1997-12-05", "1998-01-02", "1998-02-06", "1998-03-06", "1998-04-03", "1998-05-01", "1998-06-05"));
    });

    it("every other month on the first and last Sunday, 10 occurrences", () => {
        expect(series("19970907T090000", "FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU")).toEqual(at9("1997-09-07", "1997-09-28", "1997-11-02", "1997-11-30", "1998-01-04", "1998-01-25", "1998-03-01", "1998-03-29", "1998-05-03", "1998-05-31"));
    });

    it("monthly on the second-to-last Monday for 6 months", () => {
        expect(series("19970922T090000", "FREQ=MONTHLY;COUNT=6;BYDAY=-2MO")).toEqual(at9("1997-09-22", "1997-10-20", "1997-11-17", "1997-12-22", "1998-01-19", "1998-02-16"));
    });

    it("monthly on the third-to-last day of the month", () => {
        expect(series("19970928T090000", "FREQ=MONTHLY;BYMONTHDAY=-3", [], { from: "1997-09-01", to: "1998-03-01" })).toEqual(at9("1997-09-28", "1997-10-29", "1997-11-28", "1997-12-29", "1998-01-29", "1998-02-26"));
    });

    it("monthly on the 2nd and 15th for 10 occurrences", () => {
        expect(series("19970902T090000", "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15")).toEqual(at9("1997-09-02", "1997-09-15", "1997-10-02", "1997-10-15", "1997-11-02", "1997-11-15", "1997-12-02", "1997-12-15", "1998-01-02", "1998-01-15"));
    });

    it("every Tuesday, every other month", () => {
        expect(series("19970902T090000", "FREQ=MONTHLY;INTERVAL=2;BYDAY=TU", [], { from: "1997-09-01", to: "1998-04-01" })).toEqual(
            at9("1997-09-02", "1997-09-09", "1997-09-16", "1997-09-23", "1997-09-30", "1997-11-04", "1997-11-11", "1997-11-18", "1997-11-25", "1998-01-06", "1998-01-13", "1998-01-20", "1998-01-27", "1998-03-03", "1998-03-10", "1998-03-17", "1998-03-24", "1998-03-31")
        );
    });

    it("yearly in June and July for 10 occurrences", () => {
        expect(series("19970610T090000", "FREQ=YEARLY;COUNT=10;BYMONTH=6,7")).toEqual(at9("1997-06-10", "1997-07-10", "1998-06-10", "1998-07-10", "1999-06-10", "1999-07-10", "2000-06-10", "2000-07-10", "2001-06-10", "2001-07-10"));
    });

    it("every Friday the 13th, DTSTART excluded by EXDATE", () => {
        expect(series("19970902T090000", "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13", [`EXDATE;TZID=${NY}:19970902T090000`], { from: "1997-01-01", to: "2001-01-01" })).toEqual(at9("1998-02-13", "1998-03-13", "1998-11-13", "1999-08-13", "2000-10-13"));
    });

    it("the last work day of the month (BYSETPOS=-1)", () => {
        expect(series("19970930T090000", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", [], { from: "1997-09-01", to: "1998-07-01" })).toEqual(at9("1997-09-30", "1997-10-31", "1997-11-28", "1997-12-31", "1998-01-30", "1998-02-27", "1998-03-31", "1998-04-30", "1998-05-29", "1998-06-30"));
    });

    it("US presidential election day", () => {
        expect(series("19961105T090000", "FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8", [], { from: "1996-01-01", to: "2005-01-01" })).toEqual(at9("1996-11-05", "2000-11-07", "2004-11-02"));
    });

    it("every 15 minutes for 6 occurrences: expanded although the editor cannot show it", () => {
        expect(series("19970902T090000", "FREQ=MINUTELY;INTERVAL=15;COUNT=6")).toEqual(["1997-09-02 09:00", "1997-09-02 09:15", "1997-09-02 09:30", "1997-09-02 09:45", "1997-09-02 10:00", "1997-09-02 10:15"]);
        expect(engine.parseRule("FREQ=MINUTELY;INTERVAL=15;COUNT=6").supported).toBe(false);
    });
});

describe("daylight saving time", () => {
    it("keeps a weekly 09:00 Madrid meeting at 09:00 local across both transitions", () => {
        const item = onlyItem(calendar(...event("DTSTART;TZID=Europe/Madrid:20260316T090000", "DTEND;TZID=Europe/Madrid:20260316T100000", "RRULE:FREQ=WEEKLY")));
        const march = engine.expandItem(item, { from: new Date("2026-03-15T00:00:00Z"), to: new Date("2026-04-07T00:00:00Z") }, { floatingZone: "UTC" });
        expect(march.map((occurrence) => occurrence.start.toISOString())).toEqual(["2026-03-16T08:00:00.000Z", "2026-03-23T08:00:00.000Z", "2026-03-30T07:00:00.000Z", "2026-04-06T07:00:00.000Z"]);
        const october = engine.expandItem(item, { from: new Date("2026-10-18T00:00:00Z"), to: new Date("2026-11-03T00:00:00Z") }, { floatingZone: "UTC" });
        expect(october.map((occurrence) => occurrence.start.toISOString())).toEqual(["2026-10-19T07:00:00.000Z", "2026-10-26T08:00:00.000Z", "2026-11-02T08:00:00.000Z"]);
        for (const occurrence of [...march, ...october]) {
            expect(engine.formatWall(engine.instantToWall(occurrence.start, "Europe/Madrid")).slice(11)).toBe("09:00:00");
            expect(occurrence.end.getTime() - occurrence.start.getTime()).toBe(3_600_000);
        }
    });

    it("moves a daily 02:30 New York event to 03:30 on the night that has no 02:30", () => {
        const item = onlyItem(calendar(...event(`DTSTART;TZID=${NY}:20260306T023000`, "DURATION:PT30M", "RRULE:FREQ=DAILY;COUNT=4")));
        const found = engine.expandItem(item, { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-15T00:00:00Z") }, { floatingZone: "UTC" });
        expect(found.map((occurrence) => engine.formatWall(engine.instantToWall(occurrence.start, NY)))).toEqual(["2026-03-06T02:30:00", "2026-03-07T02:30:00", "2026-03-08T03:30:00", "2026-03-09T02:30:00"]);
    });

    it("keeps an all-day event on its dates in the reader's zone", () => {
        const item = onlyItem(calendar(...event("DTSTART;VALUE=DATE:20260328", "DTEND;VALUE=DATE:20260329", "RRULE:FREQ=DAILY;COUNT=3")));
        const found = engine.expandItem(item, { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") }, { floatingZone: "Europe/Madrid" });
        expect(found.map((occurrence) => [occurrence.startDate, occurrence.endDate, occurrence.recurrenceKey])).toEqual([
            ["2026-03-28", "2026-03-29", "2026-03-28"],
            ["2026-03-29", "2026-03-30", "2026-03-29"],
            ["2026-03-30", "2026-03-31", "2026-03-30"]
        ]);
        // The day the clocks change is 23 hours long.
        const [, short] = found;
        expect(short && short.end.getTime() - short.start.getTime()).toBe(23 * 3_600_000);
        expect(found.every((occurrence) => occurrence.allDay)).toBe(true);
    });
});

describe("overrides and extra dates", () => {
    const weekly = (...more: string[]) => [
        ...event("DTSTART;TZID=Europe/Berlin:20260105T100000", "DTEND;TZID=Europe/Berlin:20260105T110000", "RRULE:FREQ=WEEKLY;COUNT=6", "SUMMARY:Stand-up", ...more.filter((line) => !line.startsWith("OVERRIDE"))),
        ...more.filter((line) => line.startsWith("OVERRIDE")).flatMap((line) => event(...line.slice("OVERRIDE ".length).split("|")))
    ];
    const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-03-01T00:00:00Z") };
    const starts = (occurrences: engine.Occurrence[]) => occurrences.map((occurrence) => engine.formatWall(engine.instantToWall(occurrence.start, "Europe/Berlin")).slice(0, 16));

    it("draws a moved occurrence where it moved to, keyed by where it was", () => {
        const item = onlyItem(calendar(...weekly("OVERRIDE RECURRENCE-ID;TZID=Europe/Berlin:20260112T100000|DTSTART;TZID=Europe/Berlin:20260113T150000|DTEND;TZID=Europe/Berlin:20260113T160000|SUMMARY:Moved")));
        const found = engine.expandItem(item, range, { floatingZone: "UTC" });
        expect(starts(found)).toEqual(["2026-01-05T10:00", "2026-01-13T15:00", "2026-01-19T10:00", "2026-01-26T10:00", "2026-02-02T10:00", "2026-02-09T10:00"]);
        const moved = found[1];
        expect(moved?.overridden).toBe(true);
        expect(moved?.event.summary).toBe("Moved");
        expect(moved?.recurrenceKey).toBe("2026-01-12T09:00:00.000Z");
    });

    it("draws an occurrence moved into the range from outside it", () => {
        const item = onlyItem(calendar(...weekly("OVERRIDE RECURRENCE-ID;TZID=Europe/Berlin:20260209T100000|DTSTART;TZID=Europe/Berlin:20260102T090000|DTEND;TZID=Europe/Berlin:20260102T093000")));
        const found = engine.expandItem(item, { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-04T00:00:00Z") }, { floatingZone: "UTC" });
        expect(starts(found)).toEqual(["2026-01-02T09:00"]);
    });

    it("keeps a cancelled occurrence, marked cancelled", () => {
        const item = onlyItem(calendar(...weekly("OVERRIDE RECURRENCE-ID;TZID=Europe/Berlin:20260119T100000|DTSTART;TZID=Europe/Berlin:20260119T100000|DTEND;TZID=Europe/Berlin:20260119T110000|STATUS:CANCELLED")));
        const found = engine.expandItem(item, range, { floatingZone: "UTC" });
        expect(found.find((occurrence) => occurrence.recurrenceKey === "2026-01-19T09:00:00.000Z")?.event.status).toBe("CANCELLED");
    });

    it("removes EXDATEs and adds RDATEs", () => {
        const item = onlyItem(calendar(...weekly("EXDATE;TZID=Europe/Berlin:20260112T100000,20260126T100000", "RDATE;TZID=Europe/Berlin:20260107T180000")));
        expect(starts(engine.expandItem(item, range, { floatingZone: "UTC" }))).toEqual(["2026-01-05T10:00", "2026-01-07T18:00", "2026-01-19T10:00", "2026-02-02T10:00", "2026-02-09T10:00"]);
    });

    it("matches an EXDATE written in UTC against the local occurrence", () => {
        const item = onlyItem(calendar(...weekly("EXDATE:20260112T090000Z")));
        expect(starts(engine.expandItem(item, range, { floatingZone: "UTC" }))).not.toContain("2026-01-12T10:00");
    });

    it("moves every later occurrence with RANGE=THISANDFUTURE", () => {
        const item = onlyItem(calendar(...weekly("OVERRIDE RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20260119T100000|DTSTART;TZID=Europe/Berlin:20260119T143000|DTEND;TZID=Europe/Berlin:20260119T153000|SUMMARY:Afternoon")));
        const found = engine.expandItem(item, range, { floatingZone: "UTC" });
        expect(starts(found)).toEqual(["2026-01-05T10:00", "2026-01-12T10:00", "2026-01-19T14:30", "2026-01-26T14:30", "2026-02-02T14:30", "2026-02-09T14:30"]);
        expect(found.slice(2).every((occurrence) => occurrence.event.summary === "Afternoon")).toBe(true);
    });

    it("ignores an override for an occurrence the rule never makes", () => {
        const item = onlyItem(calendar(...weekly("OVERRIDE RECURRENCE-ID;TZID=Europe/Berlin:20260106T100000|DTSTART;TZID=Europe/Berlin:20260106T100000|DTEND;TZID=Europe/Berlin:20260106T110000")));
        expect(engine.expandItem(item, range, { floatingZone: "UTC" })).toHaveLength(6);
    });

    it("sorts, limits and returns only overlapping occurrences", () => {
        const item = onlyItem(calendar(...event("DTSTART:20260101T100000Z", "DTEND:20260101T110000Z", "RRULE:FREQ=DAILY")));
        const found = engine.expandItem(item, { from: new Date("2026-01-10T10:30:00Z"), to: new Date("2026-02-10T00:00:00Z") }, { floatingZone: "UTC", limit: 5 });
        expect(found).toHaveLength(5);
        expect(found[0]?.start.toISOString()).toBe("2026-01-10T10:00:00.000Z");
        expect(engine.expandItem(item, { from: new Date("2026-01-10T11:00:00Z"), to: new Date("2026-01-11T00:00:00Z") }, { floatingZone: "UTC" })).toHaveLength(0);
    });
});

describe("expandTodo", () => {
    it("places a task's due date and start", () => {
        const parsed = engine.parseCalendarText(calendar("BEGIN:VTODO", "UID:t1", "DTSTAMP:20260101T000000Z", "DUE;VALUE=DATE:20260113", "DTSTART;TZID=Europe/Madrid:20260110T090000", "END:VTODO"));
        const [item] = parsed.items;
        if (!item) throw new Error("no task");
        const times = engine.expandTodo(item, "Europe/Madrid");
        expect(times.allDay).toBe(true);
        expect(times.due?.toISOString()).toBe("2026-01-12T23:00:00.000Z");
        expect(times.start?.toISOString()).toBe("2026-01-10T08:00:00.000Z");
    });
});
