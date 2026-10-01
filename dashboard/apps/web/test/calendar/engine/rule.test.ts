/**
 * U11: recurrence rules - RRULE text, the editor's model (Nextcloud's editor)
 * both ways, and the one-sentence summary in en-US and es-ES.
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

const start: engine.DateValue = { dateTime: "2026-03-16T09:00:00", tzid: "Europe/Madrid" };

describe("parseRule / formatRule", () => {
    it("reads every part the model carries", () => {
        const rule = engine.parseRule("FREQ=MONTHLY;INTERVAL=2;BYDAY=1SU,-1SU;COUNT=10;WKST=SU");
        expect(rule).toMatchObject({
            frequency: "MONTHLY",
            interval: 2,
            byDay: [
                { day: "SU", ordinal: 1 },
                { day: "SU", ordinal: -1 }
            ],
            count: 10,
            until: null,
            weekStart: "SU"
        });
        expect(engine.parseRule("FREQ=DAILY;UNTIL=20261231T225959Z").until).toEqual({
            dateTime: "2026-12-31T22:59:59",
            tzid: "UTC"
        });
        expect(engine.parseRule("FREQ=DAILY;UNTIL=20261231").until).toEqual({ date: "2026-12-31" });
        expect(engine.parseRule("RRULE:FREQ=YEARLY;BYMONTH=6,7").byMonth).toEqual([6, 7]);
    });

    it("refuses a rule with no frequency", () => {
        expect(() => engine.parseRule("INTERVAL=2")).toThrow();
        expect(() => engine.parseRule("FREQ=FORTNIGHTLY")).toThrow();
        expect(() => engine.parseRule("FREQ=DAILY;INTERVAL=0")).toThrow();
    });

    it("marks rules the editor cannot show", () => {
        for (const raw of [
            "FREQ=HOURLY",
            "FREQ=MINUTELY;INTERVAL=15",
            "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
            "FREQ=YEARLY;BYYEARDAY=1,100",
            "FREQ=DAILY;BYHOUR=9,17",
            "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13",
            "FREQ=DAILY;BYDAY=MO",
            "FREQ=MONTHLY;BYMONTHDAY=-3"
        ]) {
            expect(engine.parseRule(raw).supported, raw).toBe(false);
        }
        for (const raw of [
            "FREQ=DAILY;INTERVAL=3",
            "FREQ=WEEKLY;BYDAY=MO,WE",
            "FREQ=MONTHLY;BYMONTHDAY=1,15",
            "FREQ=MONTHLY;BYDAY=-1FR",
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            "FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
            "FREQ=YEARLY;BYMONTH=6,7;COUNT=10"
        ]) {
            expect(engine.parseRule(raw).supported, raw).toBe(true);
        }
    });

    it("writes a rule back, keeping parts the model does not carry", () => {
        expect(engine.formatRule(engine.parseRule("FREQ=DAILY;BYHOUR=9,17;COUNT=4"))).toBe(
            "FREQ=DAILY;COUNT=4;BYHOUR=9,17"
        );
        expect(
            engine.formatRule(
                engine.parseRule("FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T225959Z;BYDAY=MO,WE")
            )
        ).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T225959Z");
    });

    it("keeps RSCALE, SKIP and X- parts through a change, and leaves such a rule to its summary", () => {
        const rule = engine.parseRule(
            "RSCALE=HEBREW;FREQ=YEARLY;BYMONTH=5;SKIP=FORWARD;X-NAME=keep;COUNT=5"
        );
        expect(rule.supported).toBe(false);
        expect(engine.withRule(rule, { count: 2 }).raw).toBe(
            "FREQ=YEARLY;BYMONTH=5;COUNT=2;RSCALE=HEBREW;SKIP=FORWARD;X-NAME=keep"
        );
    });
});

describe("neverRecurs", () => {
    const monday = engine.parseWall("2026-01-05T09:00:00");

    it("names the rules ical.js would step through forever", () => {
        for (const raw of [
            "FREQ=DAILY;BYDAY=1MO",
            "FREQ=SECONDLY;BYDAY=-1FR",
            "FREQ=DAILY;BYMONTHDAY=-1",
            "FREQ=HOURLY;BYMONTHDAY=0",
            "FREQ=DAILY;INTERVAL=7;BYDAY=TU",
            "FREQ=DAILY;INTERVAL=14;BYDAY=WE,TH",
            "FREQ=HOURLY;INTERVAL=168;BYDAY=TU",
            "FREQ=HOURLY;INTERVAL=84;BYDAY=TU",
            "FREQ=MINUTELY;INTERVAL=120;BYHOUR=10",
            "FREQ=SECONDLY;INTERVAL=7200;BYMINUTE=30",
            "FREQ=SECONDLY;BYSECOND=60",
            "FREQ=WEEKLY;BYWEEKNO=-1",
            "FREQ=DAILY;BYMONTH=6;BYWEEKNO=1",
            "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30,-1",
            "FREQ=YEARLY;BYMONTH=4,6;BYMONTHDAY=31"
        ]) {
            expect(engine.neverRecurs(engine.parseRule(raw), monday), raw).toBe(true);
        }
    });

    it("leaves every rule that does repeat to ical.js", () => {
        for (const raw of [
            "FREQ=DAILY",
            "FREQ=DAILY;BYDAY=MO,1TU",
            "FREQ=DAILY;INTERVAL=7;BYDAY=MO",
            "FREQ=DAILY;INTERVAL=3;BYDAY=TU",
            "FREQ=DAILY;BYMONTHDAY=31,-1",
            "FREQ=DAILY;INTERVAL=7;BYMONTHDAY=6",
            "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29",
            "FREQ=DAILY;BYWEEKNO=1;BYMONTH=1",
            "FREQ=DAILY;BYWEEKNO=53;BYMONTH=12;BYDAY=TH",
            "FREQ=HOURLY;INTERVAL=5;BYHOUR=10",
            "FREQ=HOURLY;INTERVAL=5;BYDAY=SU,MO",
            "FREQ=HOURLY;INTERVAL=24;BYDAY=TU;BYHOUR=5",
            "FREQ=MINUTELY;INTERVAL=7;BYHOUR=9",
            "FREQ=SECONDLY;BYHOUR=8",
            "FREQ=WEEKLY;BYDAY=1MO",
            "FREQ=MONTHLY;BYMONTHDAY=-1",
            "FREQ=MONTHLY;INTERVAL=12;BYMONTH=2",
            "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO"
        ]) {
            expect(engine.neverRecurs(engine.parseRule(raw), monday), raw).toBe(false);
        }
    });
});

describe("the editor model", () => {
    const models: engine.RuleEditorModel[] = [
        {
            frequency: "DAILY",
            interval: 3,
            weekdays: ["MO"],
            monthlyMode: "day",
            monthDays: [16],
            ordinal: 3,
            ordinalDay: "MO",
            months: [3],
            end: { kind: "never" }
        },
        {
            frequency: "WEEKLY",
            interval: 2,
            weekdays: ["MO", "WE", "FR"],
            monthlyMode: "day",
            monthDays: [16],
            ordinal: 3,
            ordinalDay: "MO",
            months: [3],
            end: { kind: "count", count: 10 }
        },
        {
            frequency: "MONTHLY",
            interval: 1,
            weekdays: ["MO"],
            monthlyMode: "day",
            monthDays: [1, 15],
            ordinal: 3,
            ordinalDay: "MO",
            months: [3],
            end: { kind: "until", date: "2026-12-31" }
        },
        {
            frequency: "MONTHLY",
            interval: 1,
            weekdays: ["MO"],
            monthlyMode: "ordinal",
            monthDays: [16],
            ordinal: -2,
            ordinalDay: "MO",
            months: [3],
            end: { kind: "never" }
        },
        {
            frequency: "MONTHLY",
            interval: 1,
            weekdays: ["MO"],
            monthlyMode: "ordinal",
            monthDays: [16],
            ordinal: -1,
            ordinalDay: "weekday",
            months: [3],
            end: { kind: "never" }
        },
        {
            frequency: "MONTHLY",
            interval: 1,
            weekdays: ["MO"],
            monthlyMode: "ordinal",
            monthDays: [16],
            ordinal: 1,
            ordinalDay: "weekend",
            months: [3],
            end: { kind: "never" }
        },
        {
            frequency: "MONTHLY",
            interval: 1,
            weekdays: ["MO"],
            monthlyMode: "ordinal",
            monthDays: [16],
            ordinal: 5,
            ordinalDay: "day",
            months: [3],
            end: { kind: "never" }
        },
        {
            frequency: "YEARLY",
            interval: 1,
            weekdays: ["MO"],
            monthlyMode: "day",
            monthDays: [16],
            ordinal: 3,
            ordinalDay: "MO",
            months: [6, 7],
            end: { kind: "count", count: 10 }
        },
        {
            frequency: "YEARLY",
            interval: 1,
            weekdays: ["MO"],
            monthlyMode: "ordinal",
            monthDays: [16],
            ordinal: 2,
            ordinalDay: "SU",
            months: [3],
            end: { kind: "never" }
        }
    ];

    for (const model of models) {
        it(`round trips ${model.frequency} ${model.monthlyMode} ${String(model.ordinalDay)} through RRULE`, () => {
            const rule = engine.ruleFromEditor(model, start);
            expect(rule?.supported).toBe(true);
            expect(engine.editorFromRule(rule, start)).toEqual(model);
        });
    }

    it("writes Nextcloud's and Google's forms", () => {
        const model = models[3] as engine.RuleEditorModel;
        expect(engine.ruleFromEditor(model, start)?.raw).toBe("FREQ=MONTHLY;BYDAY=-2MO");
        expect(engine.ruleFromEditor(models[4] as engine.RuleEditorModel, start)?.raw).toBe(
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"
        );
    });

    it("ends an UNTIL at the last second of the chosen day in the start's zone", () => {
        const rule = engine.ruleFromEditor(models[2] as engine.RuleEditorModel, start);
        expect(rule?.until).toEqual({ dateTime: "2026-12-31T22:59:59", tzid: "UTC" });
        const allDay = engine.ruleFromEditor(models[2] as engine.RuleEditorModel, {
            date: "2026-03-16"
        });
        expect(allDay?.until).toEqual({ date: "2026-12-31" });
    });

    it("gives no rule for 'does not repeat' and pre-fills from the start", () => {
        const none = engine.editorFromRule(null, start);
        expect(engine.ruleFromEditor(none, start)).toBeNull();
        // 2026-03-16 is the third Monday of March.
        expect(none).toEqual({
            frequency: "NONE",
            interval: 1,
            weekdays: ["MO"],
            monthlyMode: "day",
            monthDays: [16],
            ordinal: 3,
            ordinalDay: "MO",
            months: [3],
            end: { kind: "never" }
        });
    });

    it("falls back to the start when a choice is left empty", () => {
        const rule = engine.ruleFromEditor(
            { ...(models[1] as engine.RuleEditorModel), weekdays: [] },
            start
        );
        expect(rule?.raw).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=10");
    });
});

describe("summarizeRule", () => {
    const cases: [string, string, string][] = [
        [
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10",
            "Every 2 weeks on Monday and Wednesday, 10 times",
            "Cada 2 semanas el lunes y el miércoles, 10 veces"
        ],
        ["FREQ=DAILY", "Daily", "Cada día"],
        ["FREQ=DAILY;INTERVAL=3;COUNT=1", "Every 3 days, 1 time", "Cada 3 días, 1 vez"],
        [
            "FREQ=MONTHLY;BYDAY=1FR;COUNT=10",
            "Monthly on the first Friday, 10 times",
            "Cada mes el primer viernes, 10 veces"
        ],
        [
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            "Monthly on the last weekday",
            "Cada mes el último día laborable"
        ],
        [
            "FREQ=MONTHLY;BYDAY=-2MO",
            "Monthly on the second-to-last Monday",
            "Cada mes el penúltimo lunes"
        ],
        ["FREQ=MONTHLY;BYMONTHDAY=1,15", "Monthly on day 1 and 15", "Cada mes el día 1 y 15"],
        [
            "FREQ=YEARLY;BYMONTH=6,7;COUNT=10",
            "Yearly in June and July, 10 times",
            "Cada año en junio y julio, 10 veces"
        ],
        [
            "FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
            "Yearly in March on the second Sunday",
            "Cada año en marzo el segundo domingo"
        ],
        ["FREQ=HOURLY;INTERVAL=3", "Every 3 hours", "Cada 3 horas"],
        [
            "FREQ=MONTHLY;BYDAY=1SU,-1SU;INTERVAL=2",
            "Every 2 months on the first Sunday and the last Sunday",
            "Cada 2 meses el primer domingo y el último domingo"
        ]
    ];

    for (const [raw, english, spanish] of cases) {
        it(`says ${raw}`, () => {
            const rule = engine.parseRule(raw);
            expect(engine.summarizeRule(rule, en, "en-US")).toBe(english);
            expect(engine.summarizeRule(rule, es, "es-ES")).toBe(spanish);
        });
    }

    it("says until when", () => {
        const rule = engine.parseRule("FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231");
        expect(engine.summarizeRule(rule, en, "en-US")).toBe(
            "Weekly on Tuesday, until Dec 31, 2026"
        );
        expect(engine.summarizeRule(rule, es, "es-ES")).toBe(
            "Cada semana el martes, hasta el 31 dic 2026"
        );
    });
});
