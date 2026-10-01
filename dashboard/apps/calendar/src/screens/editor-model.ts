/**
 * The event editor's form, apart from the component that draws it: what an
 * opened event reads as, what a new one starts with, what the form sends, and
 * whether it differs from what was loaded.
 *
 * "Dirty" is a comparison of what would be sent against what the loaded event
 * would send, never "a field was touched": a title changed and changed back
 * leaves Save disabled. Validation is the engine's `eventInputSchema`, the one
 * the server checks with; an empty required field is incomplete, not an error.
 *
 * Pure.
 */

import * as engine from "../engine";
import type { EventDetail } from "../lib/wire";
import type { CalendarPreferences } from "../lib/preferences";
import { addDays, isDayString, timeOfMinutes, wallOf } from "./time";

export interface AlarmDraft {
    readonly action: engine.AlarmAction;
    readonly trigger: engine.AlarmTrigger;
    readonly description: string;
}

export interface AttendeeDraft {
    readonly email: string;
    readonly name: string;
    readonly role: engine.AttendeeRole;
    readonly partstat: engine.PartStat;
    readonly rsvp: boolean;
    readonly type: engine.CalendarUserType;
}

export interface AttachmentDraft {
    readonly uri: string;
    readonly name: string;
    readonly mime: string;
}

export interface EditorForm {
    readonly calendarId: string;
    readonly summary: string;
    readonly description: string;
    readonly location: string;
    readonly allDay: boolean;
    readonly startDate: string;
    readonly startTime: string;
    /** An IANA zone, "UTC", or "" for a floating time. */
    readonly startZone: string;
    /** For an all-day event, the last day it covers (inclusive). */
    readonly endDate: string;
    readonly endTime: string;
    readonly endZone: string;
    readonly repeat: engine.RuleEditorModel;
    /** The loaded rule is one the editor cannot show and it was not replaced:
     *  the server keeps it as stored. */
    readonly keepRule: boolean;
    readonly attachments: readonly AttachmentDraft[];
    readonly alarms: readonly AlarmDraft[];
    readonly attendees: readonly AttendeeDraft[];
    readonly categories: readonly string[];
    readonly color: string | null;
    readonly status: engine.EventStatus | null;
    readonly transparency: engine.Transparency;
    readonly classification: engine.Classification;
    readonly url: string;
    readonly conference: string;
    readonly kind: engine.EventKind;
}

/** The categories offered before somebody types their own: the everyday
 *  kinds of time a calendar holds. Stored as the reader's words, the way every
 *  other client writes CATEGORIES. */
export const DEFAULT_CATEGORIES = [
    "work",
    "meeting",
    "call",
    "deadline",
    "travel",
    "personal",
    "family",
    "health",
    "birthday",
    "holiday",
    "education",
    "social"
] as const;

/** Durations offered beside the end, in minutes. */
export const DURATION_PRESETS = [15, 30, 45, 60, 90, 120, 180] as const;

/** Colours offered for one event. */
export const EVENT_COLORS = ["#d62728", "#ff7f0e", "#bcbd22", "#2ca02c", "#17becf", "#1f77b4", "#9467bd", "#e377c2", "#8c564b", "#7f7f7f"] as const;

function splitWall(wall: string): { date: string; time: string } {
    return { date: wall.slice(0, 10), time: wall.slice(11, 16) };
}

function zoneOf(value: engine.DateValue): string {
    if ("date" in value || value.tzid === null) return "";
    return engine.resolveZone(value.tzid) ?? value.tzid;
}

function alarmDrafts(alarms: readonly engine.Alarm[]): AlarmDraft[] {
    return alarms.map((alarm) => ({ action: alarm.action, trigger: alarm.trigger, description: alarm.description }));
}

/** Reminders as minutes relative to the start, the shape calendars and
 *  preferences store their defaults in. */
export function alarmsFromMinutes(minutes: readonly number[]): AlarmDraft[] {
    return minutes.map((value) => ({ action: "DISPLAY", trigger: { kind: "relative", minutes: value, related: "START" }, description: "" }));
}

/** The rule the editor shows: the series', read by the start of the occurrence. */
export function ruleOf(detail: EventDetail): engine.RecurrenceRule | null {
    return detail.series?.rule ?? detail.event.rule;
}

/** The form an opened event reads as. */
export function formFromDetail(detail: EventDetail): EditorForm {
    const event = detail.event;
    const allDay = "date" in event.start;
    const start = "date" in event.start ? { date: event.start.date, time: "09:00" } : splitWall(event.start.dateTime);
    const end = "date" in event.end ? { date: addDays(event.end.date, -1) < start.date ? start.date : addDays(event.end.date, -1), time: "10:00" } : splitWall(event.end.dateTime);
    return {
        calendarId: detail.calendarId,
        summary: event.summary,
        description: event.description,
        location: event.location,
        allDay,
        startDate: start.date,
        startTime: start.time,
        startZone: zoneOf(event.start),
        endDate: end.date,
        endTime: end.time,
        endZone: zoneOf(event.end),
        repeat: engine.editorFromRule(ruleOf(detail), event.start),
        keepRule: ruleOf(detail)?.supported === false,
        attachments: event.attachments.map((attachment) => ({ uri: attachment.uri, name: attachment.name, mime: attachment.mime })),
        alarms: alarmDrafts(event.alarms),
        attendees: event.attendees.map((attendee) => ({
            email: attendee.email,
            name: attendee.name,
            role: attendee.role,
            partstat: attendee.partstat,
            rsvp: attendee.rsvp,
            type: attendee.type
        })),
        categories: [...event.categories],
        color: event.color,
        status: event.status,
        transparency: event.transparency,
        classification: event.classification,
        url: event.url,
        conference: event.conference,
        kind: event.kind
    };
}

/** What a new event starts with. */
export function newForm(input: {
    readonly calendarId: string;
    readonly zone: string;
    readonly allDay: boolean;
    /** Instants for a timed event, days (end exclusive) for an all-day one. */
    readonly start: Date | string;
    readonly end: Date | string;
    readonly summary?: string;
    readonly alarms: readonly number[];
}): EditorForm {
    const startWall = typeof input.start === "string" ? `${input.start}T09:00:00` : wallOf(input.start, input.zone);
    const endWall = typeof input.end === "string" ? `${addDays(input.end, -1)}T10:00:00` : wallOf(input.end, input.zone);
    const start = splitWall(startWall);
    const end = splitWall(endWall);
    const startValue: engine.DateValue = input.allDay ? { date: start.date } : { dateTime: startWall, tzid: input.zone };
    return {
        calendarId: input.calendarId,
        summary: input.summary ?? "",
        description: "",
        location: "",
        allDay: input.allDay,
        startDate: start.date,
        startTime: start.time,
        startZone: input.zone,
        endDate: end.date < start.date ? start.date : end.date,
        endTime: end.time,
        endZone: input.zone,
        repeat: engine.editorFromRule(null, startValue),
        keepRule: false,
        attachments: [],
        alarms: alarmsFromMinutes(input.alarms),
        attendees: [],
        categories: [],
        color: null,
        status: null,
        transparency: "OPAQUE",
        classification: "PUBLIC",
        url: "",
        conference: "",
        kind: "default"
    };
}

/** The reminders a new event in a calendar starts with: the calendar's own
 *  defaults, or the person's. */
export function defaultAlarmMinutes(allDay: boolean, calendar: { defaultAlarms: { timed: readonly number[]; allDay: readonly number[] } } | null, preferences: CalendarPreferences): readonly number[] {
    const own = calendar ? (allDay ? calendar.defaultAlarms.allDay : calendar.defaultAlarms.timed) : [];
    if (own.length > 0) return own;
    return allDay ? preferences.defaultAlarms.allDay : preferences.defaultAlarms.timed;
}

function startValue(form: EditorForm): engine.DateValue {
    if (form.allDay) return { date: form.startDate };
    return { dateTime: `${form.startDate}T${form.startTime}`, tzid: form.startZone || null };
}

function endValue(form: EditorForm): engine.DateValue {
    if (form.allDay) return { date: isDayString(form.endDate) ? addDays(form.endDate, 1) : form.endDate };
    return { dateTime: `${form.endDate}T${form.endTime}`, tzid: form.endZone || null };
}

/** What the form sends, before the schema has read it. */
export function inputOf(form: EditorForm) {
    return {
        calendarId: form.calendarId,
        summary: form.summary,
        description: form.description,
        location: form.location,
        start: startValue(form),
        end: endValue(form),
        allDay: form.allDay,
        rule: form.repeat.frequency === "NONE" ? null : form.repeat,
        keepRule: form.keepRule,
        attachments: form.attachments,
        alarms: form.alarms,
        attendees: form.attendees,
        categories: form.categories,
        color: form.color,
        status: form.status,
        transparency: form.transparency,
        classification: form.classification,
        url: form.url,
        conference: form.conference,
        kind: form.kind
    };
}

/** Whether two forms would send the same thing. */
export function sameForm(a: EditorForm, b: EditorForm): boolean {
    return JSON.stringify(inputOf(a)) === JSON.stringify(inputOf(b));
}

/** Whether the repeat rule is what differs. */
export function sameRule(a: EditorForm, b: EditorForm): boolean {
    const rule = (form: EditorForm) => JSON.stringify([inputOf(form).rule, form.keepRule]);
    return rule(a) === rule(b);
}

/** The fields a validation message is drawn under. */
export type FieldName = "calendarId" | "summary" | "start" | "end" | "allDay" | "location" | "description" | "url" | "conference" | "color" | "attendees" | "rule" | "alarms" | "categories" | "attachments";

export interface FormCheck {
    /** Complete and valid: what the schema read. */
    readonly input: engine.EventInput | null;
    /** A required field is still empty. */
    readonly incomplete: boolean;
    /** Per field, the `calendarRule` validation key (or "checkInput"). */
    readonly errors: Partial<Record<FieldName, string>>;
}

const KNOWN = new Set<string>(Object.values(engine.SCHEMA_MESSAGES));

/** Check the form as the server will. */
export function checkForm(form: EditorForm): FormCheck {
    const empty = {
        calendarId: form.calendarId === "",
        start: form.startDate === "" || (!form.allDay && form.startTime === ""),
        end: form.endDate === "" || (!form.allDay && form.endTime === "")
    };
    const incomplete = empty.calendarId || empty.start || empty.end;
    const errors: Partial<Record<FieldName, string>> = {};
    let parsed: ReturnType<typeof engine.eventInputSchema.safeParse>;
    try {
        parsed = engine.eventInputSchema.safeParse(inputOf(form));
    } catch {
        // A start or end that does not read as a date yet stops the schema's
        // own cross-field check; it is the same as one that is not filled in.
        if (!empty.start && !empty.end) errors.start = engine.SCHEMA_MESSAGES.dateTimeForm;
        return { input: null, incomplete: true, errors };
    }
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            const field = (issue.path[0] ?? "summary") as FieldName;
            // An empty required field says nothing until it is filled in.
            if (field in empty && empty[field as keyof typeof empty]) continue;
            if (errors[field]) continue;
            errors[field] = KNOWN.has(issue.message) ? issue.message : "checkInput";
        }
    }
    return { input: parsed.success && !incomplete ? parsed.data : null, incomplete, errors };
}

/** The instant a form's start or end names; null while it does not read. */
export function formInstant(date: string, time: string, zone: string, fallbackZone: string): Date | null {
    if (!isDayString(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
    const resolved = engine.resolveZone(zone || fallbackZone) ?? "UTC";
    return engine.wallToInstant(engine.parseWall(`${date}T${time}`), resolved);
}

/** The end moved so the event lasts `minutes` from its start, in the end's zone. */
export function withDuration(form: EditorForm, minutes: number, fallbackZone: string): EditorForm {
    const start = formInstant(form.startDate, form.startTime, form.startZone, fallbackZone);
    if (!start) return form;
    const endZone = engine.resolveZone(form.endZone || fallbackZone) ?? "UTC";
    const wall = wallOf(new Date(start.getTime() + minutes * 60_000), endZone);
    return { ...form, endDate: wall.slice(0, 10), endTime: wall.slice(11, 16) };
}

/** Minutes from the start to the end, when both read. */
export function durationOf(form: EditorForm, fallbackZone: string): number | null {
    if (form.allDay) return null;
    const start = formInstant(form.startDate, form.startTime, form.startZone, fallbackZone);
    const end = formInstant(form.endDate, form.endTime, form.endZone, fallbackZone);
    if (!start || !end) return null;
    return Math.round((end.getTime() - start.getTime()) / 60_000);
}

/** The start moved, the length kept. */
export function withStart(form: EditorForm, date: string, time: string, fallbackZone: string): EditorForm {
    if (form.allDay) {
        const length = isDayString(form.startDate) && isDayString(form.endDate) ? Math.max(0, engine.daysBetween(form.startDate, form.endDate)) : 0;
        return { ...form, startDate: date, endDate: isDayString(date) ? addDays(date, length) : form.endDate };
    }
    const length = durationOf(form, fallbackZone);
    const moved = { ...form, startDate: date, startTime: time };
    return length !== null && length >= 0 ? withDuration(moved, length, fallbackZone) : moved;
}

/** All day switched on or off, times kept for switching back. */
export function withAllDay(form: EditorForm, allDay: boolean, fallbackZone: string): EditorForm {
    if (allDay === form.allDay) return form;
    if (allDay) return { ...form, allDay, endDate: form.endDate < form.startDate ? form.startDate : form.endDate };
    const zone = form.startZone || fallbackZone;
    const next = { ...form, allDay, startZone: zone, endZone: form.endZone || zone, endDate: form.startDate };
    return form.startTime < form.endTime ? next : { ...next, endTime: timeOfMinutes(Math.min(1439, (engine.minutesOf(form.startTime) || 0) + 60)) };
}

/** Whether a URL-ish token is a web link a person may open. */
export function isWebLink(text: string): boolean {
    try {
        const url = new URL(text);
        return url.protocol === "https:" || url.protocol === "http:";
    } catch {
        return false;
    }
}

/** Text cut into plain runs and web links, for a description in view mode. */
export function linkify(text: string): { readonly text: string; readonly href: string | null }[] {
    const parts: { text: string; href: string | null }[] = [];
    const pattern = /https?:\/\/[^\s<>"')\]]+/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        const raw = match[0].replace(/[.,;:!?]+$/, "");
        if (index > last) parts.push({ text: text.slice(last, index), href: null });
        parts.push({ text: raw, href: isWebLink(raw) ? raw : null });
        last = index + raw.length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), href: null });
    return parts;
}

/** The addresses a person answers to among the attendees. */
export function myAttendee(detail: EventDetail): engine.Attendee | null {
    const mine = new Set(detail.myEmails.map((email) => email.toLowerCase()));
    return detail.event.attendees.find((attendee) => mine.has(attendee.email.toLowerCase())) ?? null;
}

/** Answers by kind, for "3 yes, 1 maybe". */
export function responseCounts(attendees: readonly AttendeeDraft[]): Record<"ACCEPTED" | "TENTATIVE" | "DECLINED" | "NEEDS-ACTION", number> {
    const counts = { ACCEPTED: 0, TENTATIVE: 0, DECLINED: 0, "NEEDS-ACTION": 0 };
    for (const attendee of attendees) {
        if (attendee.partstat === "ACCEPTED" || attendee.partstat === "TENTATIVE" || attendee.partstat === "DECLINED") counts[attendee.partstat] += 1;
        else counts["NEEDS-ACTION"] += 1;
    }
    return counts;
}
