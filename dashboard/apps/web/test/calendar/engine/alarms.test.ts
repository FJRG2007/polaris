/**
 * U12: alarms - fire times per occurrence, overrides' own alarms, all-day
 * "9:00 on the day", the next alarm per key, presets and trigger words.
 */

import { describe, expect, it } from "vitest";
import { createTranslator } from "@polaris/core";
import * as engine from "@polaris-app/calendar/src/engine";
import enRule from "@polaris-app/calendar/messages/en-US/rule.json";
import esRule from "@polaris-app/calendar/messages/es-ES/rule.json";

const en = createTranslator("en-US", enRule, {
    namespace: "calendarRule"
}) as unknown as engine.RuleTranslator;
const es = createTranslator("es-ES", esRule, {
    namespace: "calendarRule"
}) as unknown as engine.RuleTranslator;

function item(...lines: string[]): engine.CalendarItem {
    const [found] = engine.parseCalendarText(
        ["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n")
    ).items;
    if (!found) throw new Error("no item");
    return found;
}

const alarm = (trigger: string, action = "DISPLAY") => [
    "BEGIN:VALARM",
    `ACTION:${action}`,
    `TRIGGER${trigger}`,
    "DESCRIPTION:Reminder",
    "END:VALARM"
];

const weekly = item(
    "BEGIN:VEVENT",
    "UID:weekly",
    "DTSTART;TZID=Europe/Madrid:20260323T090000",
    "DTEND;TZID=Europe/Madrid:20260323T100000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    ...alarm(":-PT15M"),
    ...alarm(";RELATED=END:-PT5M", "EMAIL"),
    ...alarm(";VALUE=DATE-TIME:20260320T120000Z"),
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly",
    "RECURRENCE-ID;TZID=Europe/Madrid:20260406T090000",
    "DTSTART;TZID=Europe/Madrid:20260406T090000",
    "DTEND;TZID=Europe/Madrid:20260406T100000",
    ...alarm(":-PT1H"),
    "END:VEVENT"
);

describe("alarmsFor", () => {
    it("plans every alarm of every occurrence in the range, across a clock change", () => {
        const found = engine.alarmsFor(
            weekly,
            { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-10T00:00:00Z") },
            "UTC"
        );
        expect(
            found.map((entry) => [entry.fireAt.toISOString(), entry.action, entry.recurrenceKey])
        ).toEqual([
            ["2026-03-20T12:00:00.000Z", "DISPLAY", "2026-03-23T08:00:00.000Z"],
            ["2026-03-23T07:45:00.000Z", "DISPLAY", "2026-03-23T08:00:00.000Z"],
            ["2026-03-23T08:55:00.000Z", "EMAIL", "2026-03-23T08:00:00.000Z"],
            // After the change to summer time: still 08:45 local.
            ["2026-03-30T06:45:00.000Z", "DISPLAY", "2026-03-30T07:00:00.000Z"],
            ["2026-03-30T07:55:00.000Z", "EMAIL", "2026-03-30T07:00:00.000Z"],
            // The override's own alarm replaces the series' ones.
            ["2026-04-06T06:00:00.000Z", "DISPLAY", "2026-04-06T07:00:00.000Z"]
        ]);
    });

    it("only returns alarms whose fire time is in the range", () => {
        const found = engine.alarmsFor(
            weekly,
            { from: new Date("2026-03-23T07:50:00Z"), to: new Date("2026-03-23T09:00:00Z") },
            "UTC"
        );
        expect(found.map((entry) => entry.fireAt.toISOString())).toEqual([
            "2026-03-23T08:55:00.000Z"
        ]);
    });

    it("fires an all-day reminder at 9:00 on the day in the reader's zone", () => {
        const allDay = item(
            "BEGIN:VEVENT",
            "UID:day",
            "DTSTART;VALUE=DATE:20260601",
            "DTEND;VALUE=DATE:20260602",
            ...alarm(":PT9H"),
            ...alarm(":-PT15H"),
            "END:VEVENT"
        );
        const found = engine.alarmsFor(
            allDay,
            { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z") },
            "Europe/Madrid"
        );
        expect(found.map((entry) => entry.fireAt.toISOString())).toEqual([
            "2026-05-31T07:00:00.000Z",
            "2026-06-01T07:00:00.000Z"
        ]);
    });

    it("skips cancelled occurrences", () => {
        const cancelled = item(
            "BEGIN:VEVENT",
            "UID:c",
            "DTSTART:20260601T100000Z",
            "STATUS:CANCELLED",
            ...alarm(":-PT15M"),
            "END:VEVENT"
        );
        expect(
            engine.alarmsFor(
                cancelled,
                { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z") },
                "UTC"
            )
        ).toEqual([]);
    });

    it("plans a task's reminders from its due date", () => {
        const todo = item(
            "BEGIN:VTODO",
            "UID:t",
            "DUE:20260601T100000Z",
            ...alarm(";RELATED=END:-PT30M"),
            "END:VTODO"
        );
        const [found] = engine.alarmsFor(
            todo,
            { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z") },
            "UTC"
        );
        expect(found?.fireAt.toISOString()).toBe("2026-06-01T09:30:00.000Z");
    });
});

describe("nextAlarm", () => {
    it("gives the next fire time of each alarm", () => {
        const next = engine.nextAlarm(weekly, new Date("2026-03-23T08:00:00Z"), "UTC");
        expect(next.map((entry) => [entry.key, entry.fireAt.toISOString()])).toEqual([
            ["1:EMAIL:rel:-5:END", "2026-03-23T08:55:00.000Z"],
            ["0:DISPLAY:rel:-15:START", "2026-03-30T06:45:00.000Z"],
            ["0:DISPLAY:rel:-60:START", "2026-04-06T06:00:00.000Z"]
        ]);
    });

    it("changes an alarm's key when the alarm changes", () => {
        const a: engine.Alarm = {
            action: "DISPLAY",
            trigger: { kind: "relative", minutes: -15, related: "START" },
            description: ""
        };
        const b: engine.Alarm = {
            ...a,
            trigger: { kind: "relative", minutes: -30, related: "START" }
        };
        expect(engine.alarmKey(a, 0)).not.toBe(engine.alarmKey(b, 0));
        expect(engine.alarmKey(a, 0)).toBe(
            engine.alarmKey({ ...a, description: "Other words" }, 0)
        );
    });
});

/** ICU puts a narrow no-break space before AM/PM; the words are what is tested. */
const plain = (text: string) => text.replace(/ /g, " ");

describe("presets and words", () => {
    it("offers Nextcloud's presets", () => {
        expect(
            engine
                .defaultAlarmPresets(false)
                .map((trigger) => trigger.kind === "relative" && trigger.minutes)
        ).toEqual([0, -5, -10, -15, -30, -45, -60, -120, -180, -1440, -2880]);
        expect(
            engine
                .defaultAlarmPresets(true)
                .map((trigger) => trigger.kind === "relative" && trigger.minutes)
        ).toEqual([540, -900, -2340, -3780, -9540]);
    });

    it("describes triggers in English and Spanish", () => {
        const rel = (minutes: number, related: "START" | "END" = "START"): engine.AlarmTrigger => ({
            kind: "relative",
            minutes,
            related
        });
        expect(plain(engine.describeTrigger(rel(0), false, en))).toBe("At the start");
        expect(plain(engine.describeTrigger(rel(-15), false, en))).toBe("15 minutes before");
        expect(plain(engine.describeTrigger(rel(-120), false, en))).toBe("2 hours before");
        expect(plain(engine.describeTrigger(rel(-1440), false, en))).toBe("1 day before");
        expect(plain(engine.describeTrigger(rel(-5, "END"), false, en))).toBe(
            "5 minutes before the end"
        );
        expect(plain(engine.describeTrigger(rel(10), false, en))).toBe("10 minutes after");
        expect(plain(engine.describeTrigger(rel(540), true, en))).toBe("On the day at 9:00 AM");
        expect(plain(engine.describeTrigger(rel(-900), true, en))).toBe("1 day before at 9:00 AM");
        expect(plain(engine.describeTrigger(rel(-9540), true, en))).toBe(
            "1 week before at 9:00 AM"
        );
        expect(plain(engine.describeTrigger(rel(-15), false, es, { locale: "es-ES" }))).toBe(
            "15 minutos antes"
        );
        expect(plain(engine.describeTrigger(rel(0), false, es, { locale: "es-ES" }))).toBe(
            "Al empezar"
        );
        expect(plain(engine.describeTrigger(rel(540), true, es, { locale: "es-ES" }))).toBe(
            "El mismo día a las 9:00"
        );
        expect(plain(engine.describeTrigger(rel(-2340), true, es, { locale: "es-ES" }))).toBe(
            "2 días antes a las 9:00"
        );
        expect(plain(engine.describeTrigger(rel(-1380), true, es, { locale: "es-ES" }))).toBe(
            "1 día antes a la 1:00"
        );
        expect(
            plain(
                engine.describeTrigger(
                    { kind: "absolute", at: "2026-06-01T10:00:00Z" },
                    false,
                    en,
                    { timeZone: "Europe/Madrid" }
                )
            )
        ).toBe("On Jun 1, 2026, 12:00 PM");
    });
});
