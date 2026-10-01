/**
 * U16: the input schemas the editor and the server share - what they accept,
 * how they normalise, and three wrong values refused for each rule.
 */

import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

const valid = {
    calendarId: "3f2b8c1e-5d4a-4b7e-9c2f-1a2b3c4d5e6f",
    summary: "  Budget review  ",
    description: "",
    location: "",
    start: { dateTime: "2026-06-01T10:00", tzid: "Europe/Madrid" },
    end: { dateTime: "2026-06-01T11:00", tzid: "Europe/Madrid" },
    allDay: false,
    rule: null,
    alarms: [{ action: "DISPLAY", trigger: { kind: "relative", minutes: -15, related: "START" } }],
    attendees: [{ email: "  MAILTO:Ana@Example.COM " }],
    categories: ["Work"],
    color: null,
    status: null,
    transparency: "OPAQUE",
    classification: "PUBLIC",
    url: "",
    conference: "",
    kind: "default"
};

const refuses = (change: Record<string, unknown>) => expect(engine.eventInputSchema.safeParse({ ...valid, ...change }).success).toBe(false);

describe("eventInputSchema", () => {
    it("accepts what the editor sends, normalised", () => {
        const parsed = engine.eventInputSchema.parse(valid);
        expect(parsed.summary).toBe("Budget review");
        expect(parsed.start).toEqual({ dateTime: "2026-06-01T10:00:00", tzid: "Europe/Madrid" });
        expect(parsed.attendees[0]).toEqual({ email: "ana@example.com", name: "", role: "REQ-PARTICIPANT", partstat: "NEEDS-ACTION", rsvp: true, type: "INDIVIDUAL" });
        expect(parsed.alarms[0]?.description).toBe("");
        expect(parsed.url).toBe("");
    });

    it("answers a malformed date as an issue rather than throwing", () => {
        const broken = engine.eventInputSchema.safeParse({ ...valid, start: { dateTime: "T10:00", tzid: "UTC" } });
        expect(broken.success).toBe(false);
        expect(engine.eventInputSchema.safeParse({ ...valid, end: "tomorrow" }).success).toBe(false);
    });

    it("keeps link attachments and the request to keep a rule", () => {
        const parsed = engine.eventInputSchema.parse({
            ...valid,
            keepRule: true,
            attachments: [{ uri: "https://example.com/agenda.pdf", name: "Agenda" }]
        });
        expect(parsed.keepRule).toBe(true);
        expect(parsed.attachments).toEqual([{ uri: "https://example.com/agenda.pdf", name: "Agenda", mime: "" }]);
        refuses({ attachments: [{ uri: "javascript:alert(1)" }] });
        refuses({ attachments: [{ uri: "" }] });
    });

    it("accepts empty optional strings and all-day events", () => {
        const parsed = engine.eventInputSchema.parse({ ...valid, allDay: true, start: { date: "2026-06-01" }, end: { date: "2026-06-02" }, url: undefined, conference: "" });
        expect(parsed.url).toBe("");
    });

    it("refuses a bad calendar id", () => {
        refuses({ calendarId: "" });
        refuses({ calendarId: "calendar-1" });
        refuses({ calendarId: 42 });
    });

    it("refuses a title, description or location too long", () => {
        refuses({ summary: "x".repeat(501) });
        refuses({ description: "x".repeat(20_001) });
        refuses({ location: "x".repeat(1001) });
    });

    it("refuses bad dates and zones", () => {
        refuses({ start: { dateTime: "2026-02-30T10:00", tzid: "Europe/Madrid" } });
        refuses({ start: { dateTime: "2026-06-01T25:00", tzid: "Europe/Madrid" } });
        refuses({ start: { dateTime: "2026-06-01T10:00", tzid: "Mars/Base" } });
    });

    it("refuses an end before the start, on the object", () => {
        const result = engine.eventInputSchema.safeParse({ ...valid, end: { dateTime: "2026-06-01T09:00", tzid: "Europe/Madrid" } });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]).toMatchObject({ path: ["end"], message: engine.SCHEMA_MESSAGES.endBeforeStart });
        refuses({ allDay: true, start: { date: "2026-06-02" }, end: { date: "2026-06-01" } });
        refuses({ start: { dateTime: "2026-06-01T10:00", tzid: "Europe/Madrid" }, end: { dateTime: "2026-06-01T07:30", tzid: "UTC" } });
    });

    it("refuses all-day flags that do not match the values", () => {
        refuses({ allDay: true });
        refuses({ allDay: false, start: { date: "2026-06-01" }, end: { date: "2026-06-02" } });
        refuses({ allDay: true, start: { date: "2026-06-01" } });
    });

    it("refuses bad alarms", () => {
        refuses({ alarms: [{ action: "SMS", trigger: { kind: "relative", minutes: -15, related: "START" } }] });
        refuses({ alarms: [{ action: "DISPLAY", trigger: { kind: "relative", minutes: 1.5, related: "START" } }] });
        refuses({ alarms: Array.from({ length: 11 }, () => valid.alarms[0]) });
    });

    it("refuses bad attendees", () => {
        refuses({ attendees: [{ email: "not-an-address" }] });
        refuses({ attendees: [{ email: "ana@example.com" }, { email: "ANA@example.com" }] });
        refuses({ attendees: Array.from({ length: 201 }, (_, index) => ({ email: `p${index}@example.com` })) });
    });

    it("refuses bad categories, colours and links", () => {
        refuses({ categories: Array.from({ length: 21 }, (_, index) => `c${index}`) });
        refuses({ categories: ["   "] });
        refuses({ color: "red" });
        refuses({ color: "#12345" });
        refuses({ url: "javascript:alert(1)" });
        refuses({ conference: "ftp://example.com/room" });
        refuses({ conference: "https://meet.example.com/room\r\nATTENDEE:mailto:someone@example.com" });
        refuses({ url: "https://example.com/\tpath" });
    });

    it("refuses unknown kinds, statuses and classes", () => {
        refuses({ kind: "party" });
        refuses({ status: "MAYBE" });
        refuses({ classification: "SECRET" });
    });
});

describe("ruleEditorSchema", () => {
    const rule = { frequency: "WEEKLY", interval: 1, weekdays: ["MO"], monthlyMode: "day", monthDays: [1], ordinal: 1, ordinalDay: "MO", months: [1], end: { kind: "never" } };
    const bad = (change: Record<string, unknown>) => expect(engine.ruleEditorSchema.safeParse({ ...rule, ...change }).success).toBe(false);

    it("accepts the editor's model and goes into an event", () => {
        expect(engine.ruleEditorSchema.parse(rule)).toEqual(rule);
        expect(engine.eventInputSchema.parse({ ...valid, rule }).rule).toEqual(rule);
    });

    it("refuses wrong values", () => {
        bad({ interval: 0 });
        bad({ interval: 1.5 });
        bad({ weekdays: ["MO", "MO"] });
        bad({ ordinal: 6 });
        bad({ monthDays: [32] });
        bad({ months: [13] });
        bad({ end: { kind: "count", count: 0 } });
        bad({ end: { kind: "until", date: "2026-13-01" } });
        bad({ frequency: "HOURLY" });
    });
});

describe("working hours and availability", () => {
    const day = [{ from: "09:00", to: "17:00" }];

    it("accepts hours per weekday, with missing days not worked", () => {
        const parsed = engine.workingHoursSchema.parse({ "1": day, "2": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "24:00" }] });
        expect(parsed["0"]).toEqual([]);
        expect(parsed["2"]).toHaveLength(2);
    });

    it("refuses bad ranges", () => {
        expect(engine.workingHoursSchema.safeParse({ "1": [{ from: "17:00", to: "09:00" }] }).success).toBe(false);
        expect(engine.workingHoursSchema.safeParse({ "1": [{ from: "9:00", to: "17:00" }] }).success).toBe(false);
        expect(engine.workingHoursSchema.safeParse({ "1": [{ from: "09:00", to: "13:00" }, { from: "12:00", to: "15:00" }] }).success).toBe(false);
    });

    it("accepts date overrides and refuses impossible dates", () => {
        expect(engine.availabilitySchema.parse({ weekly: { "1": day }, overrides: { "2026-12-25": [] } }).overrides["2026-12-25"]).toEqual([]);
        expect(engine.availabilitySchema.safeParse({ weekly: {}, overrides: { "2026-02-30": [] } }).success).toBe(false);
        expect(engine.availabilitySchema.safeParse({ weekly: {}, overrides: { tomorrow: [] } }).success).toBe(false);
        expect(engine.availabilitySchema.safeParse({ weekly: {}, overrides: { "2026-06-01": [{ from: "10:00", to: "25:00" }] } }).success).toBe(false);
    });

    it("normalises addresses", () => {
        expect(engine.normalizeEmail("  MAILTO:Ana@Example.COM ")).toBe("ana@example.com");
    });
});
