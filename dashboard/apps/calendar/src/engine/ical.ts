/**
 * iCalendar text in and out: the only module that reads or writes RFC 5545.
 *
 * The component structure (BEGIN/END nesting) is walked here, line by line, so
 * one broken event costs that event and not the file, and so a line this model
 * has no field for can be kept exactly as it was written. Each line the model
 * does read is parsed by ical.js (`ICAL.Property`), which owns escaping, quoted
 * parameters and RFC 6868; each line written is produced by it too. Folding is
 * done here, at 75 octets as RFC 5545 3.1 says, continuation lines included.
 *
 * jCal (RFC 7265) is accepted on input and read into the same structure.
 */

import ICAL from "ical.js";
import type * as T from "./types";
import { absoluteInstant } from "./alarms";
import { parseRule } from "./rule";
import { addToWall, formatWall, resolveZone } from "./tz";
import { vtimezoneFor } from "./vtimezone";
import { addDays, clockFor, isDateOnly, valueToInstant, valueWall, vtimezoneId } from "./zones";
import { expandItem, generateStarts, isRecurring, placeEvent, thisAndFutureReach, type ExpandContext } from "./expand";

export { valueToInstant } from "./zones";

/** One component as written: its own lines (unfolded) and the ones nested in it. */
interface RawComponent {
    readonly name: string;
    readonly lines: string[];
    readonly children: RawComponent[];
    broken: string | null;
}

type Params = Readonly<Record<string, string | readonly string[]>>;

/** A content line read by ical.js: name, parameters, value type, values. */
interface ParsedLine {
    readonly name: string;
    readonly params: Params;
    readonly type: string;
    readonly values: readonly unknown[];
}

/** What `parseCalendarText` found. */
export interface ParsedCalendar {
    readonly items: T.CalendarItem[];
    /** X-WR-CALNAME, or RFC 7986 NAME. */
    readonly name: string | null;
    /** X-APPLE-CALENDAR-COLOR, or RFC 7986 COLOR. */
    readonly color: string | null;
    /** X-WR-TIMEZONE, resolved to an IANA name when possible. */
    readonly timezone: string | null;
    /**
     * What could not be read and was skipped, as `rule.json` catalog keys
     * (`parse.eventUnreadable`...), one per problem.
     */
    readonly errors: string[];
    /** The same problems with what their messages fill in, and a technical
     *  detail in English for the log - never for a screen. */
    readonly problems: ParseProblem[];
}

/** One thing a file had that could not be used. */
export interface ParseProblem {
    /** A `rule.json` key: `parse.<reason>`. */
    readonly key: string;
    readonly values: Readonly<Record<string, string>>;
    readonly detail: string;
}

export const DEFAULT_PRODID = "-//Polaris//Calendar//EN";

const EVENT_STATUSES: readonly T.EventStatus[] = ["CONFIRMED", "TENTATIVE", "CANCELLED"];
const TODO_STATUSES: readonly T.TodoStatus[] = ["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"];
const CLASSES: readonly T.Classification[] = ["PUBLIC", "PRIVATE", "CONFIDENTIAL"];
const ROLES: readonly T.AttendeeRole[] = ["CHAIR", "REQ-PARTICIPANT", "OPT-PARTICIPANT", "NON-PARTICIPANT"];
const PARTSTATS: readonly T.PartStat[] = ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"];
const USER_TYPES: readonly T.CalendarUserType[] = ["INDIVIDUAL", "GROUP", "RESOURCE", "ROOM", "UNKNOWN"];
const ACTIONS: readonly T.AlarmAction[] = ["DISPLAY", "EMAIL", "AUDIO"];
const KINDS: readonly T.EventKind[] = ["default", "outOfOffice", "focusTime", "workingLocation"];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/;

/* ------------------------------------------------------------------ reading */

/** Undo line folding (RFC 5545 3.1) and split into content lines. */
function unfold(text: string): string[] {
    return text
        .replace(/\r\n|\r/g, "\n")
        .replace(/\n[ \t]/g, "")
        .split("\n")
        .filter((line) => line.trim() !== "");
}

function lineName(line: string): string {
    const match = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)?)[;:]/.exec(line);
    return match?.[1]?.toUpperCase() ?? "";
}

/** The BEGIN/END tree of a text, with a note on every component whose
 *  structure is broken. Nothing here throws. */
function readStructure(text: string): RawComponent[] {
    const roots: RawComponent[] = [];
    const stack: RawComponent[] = [];
    for (const line of unfold(text)) {
        const begin = /^BEGIN:(.+)$/i.exec(line);
        const end = /^END:(.+)$/i.exec(line);
        if (begin) {
            const component: RawComponent = { name: (begin[1] ?? "").trim().toUpperCase(), lines: [], children: [], broken: null };
            const parent = stack[stack.length - 1];
            if (parent) parent.children.push(component);
            else roots.push(component);
            stack.push(component);
        } else if (end) {
            const name = (end[1] ?? "").trim().toUpperCase();
            const at = stack.map((component) => component.name).lastIndexOf(name);
            // A stray END closes nothing; the components around it are fine.
            if (at < 0) continue;
            while (stack.length > at + 1) {
                const open = stack.pop();
                if (open) open.broken = `${open.name} was never closed.`;
            }
            stack.pop();
        } else {
            const current = stack[stack.length - 1];
            if (!current) continue;
            if (!lineName(line) || !line.includes(":")) {
                current.broken = `A line in ${current.name} is not a property: ${line.slice(0, 60)}`;
                continue;
            }
            current.lines.push(line);
        }
    }
    for (const open of stack) open.broken = open.broken ?? `${open.name} was never closed.`;
    return roots;
}

/** jCal (RFC 7265) read into the same tree, through ical.js. */
function readJcal(text: string, problems: ParseProblem[]): RawComponent[] {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        problems.push({ key: "parse.notJson", values: {}, detail: "Invalid JSON." });
        return [];
    }
    const list = Array.isArray(data) && typeof data[0] === "string" ? [data] : Array.isArray(data) ? data : [];
    const convert = (component: ICAL.Component): RawComponent => ({
        name: component.name.toUpperCase(),
        lines: component.getAllProperties().map((property) => property.toICALString()),
        children: component.getAllSubcomponents().map(convert),
        broken: null
    });
    const roots: RawComponent[] = [];
    for (const entry of list) {
        try {
            roots.push(convert(new ICAL.Component(entry as unknown[])));
        } catch (error) {
            problems.push({ key: "parse.partUnreadable", values: {}, detail: (error as Error).message });
        }
    }
    return roots;
}

function parseLine(line: string): ParsedLine {
    const property = ICAL.Property.fromString(line);
    const [name, params, type, ...values] = property.jCal as [string, Record<string, string | string[]>, string, ...unknown[]];
    return { name: name.toUpperCase(), params, type, values };
}

function textOf(parsed: ParsedLine): string {
    return parsed.values.map((value) => String(value ?? "")).join(",");
}

function paramText(params: Params, name: string): string | null {
    const value = params[name];
    if (value === undefined) return null;
    return typeof value === "string" ? value : value.join(",");
}

/** The date values of a DTSTART-like line. `zones` collects the raw TZIDs. */
function dateValues(parsed: ParsedLine, zones: Set<string>): T.DateValue[] {
    const rawTzid = paramText(parsed.params, "tzid");
    return parsed.values.map((value) => {
        const text = String(value);
        if (parsed.type === "date") {
            if (!DATE.test(text)) throw new Error(`${parsed.name} is not a date: ${text}`);
            return { date: text };
        }
        if (!DATE_TIME.test(text)) throw new Error(`${parsed.name} is not a date-time: ${text}`);
        if (text.endsWith("Z")) return { dateTime: text.slice(0, -1), tzid: "UTC" };
        if (!rawTzid) return { dateTime: text, tzid: null };
        zones.add(rawTzid);
        return { dateTime: text, tzid: resolveZone(rawTzid) ?? rawTzid };
    });
}

function mailtoless(value: string): string {
    const address = value.trim().replace(/^mailto:/i, "");
    return address.toLowerCase();
}

const PERSON_PARAMS = ["cn", "role", "partstat", "rsvp", "cutype"];

function restParams(params: Params, known: readonly string[]): Params | undefined {
    const rest = Object.fromEntries(Object.entries(params).filter(([name]) => !known.includes(name)));
    return Object.keys(rest).length > 0 ? rest : undefined;
}

function withParams<T extends object>(value: T, params: Params | undefined): T {
    return params ? { ...value, params } : value;
}

function readPerson(parsed: ParsedLine): T.Person {
    return withParams({ email: mailtoless(textOf(parsed)), name: paramText(parsed.params, "cn") ?? "" }, restParams(parsed.params, ["cn"]));
}

function readAttendee(parsed: ParsedLine): T.Attendee {
    const params = parsed.params;
    const role = (paramText(params, "role") ?? "REQ-PARTICIPANT").toUpperCase() as T.AttendeeRole;
    const partstat = (paramText(params, "partstat") ?? "NEEDS-ACTION").toUpperCase() as T.PartStat;
    const cutype = (paramText(params, "cutype") ?? "INDIVIDUAL").toUpperCase() as T.CalendarUserType;
    // A value outside the model's set stays among the kept parameters, so it is
    // written back as it came.
    const known = PERSON_PARAMS.filter((name) => {
        if (name === "role") return ROLES.includes(role);
        if (name === "partstat") return PARTSTATS.includes(partstat);
        if (name === "cutype") return USER_TYPES.includes(cutype);
        return true;
    });
    return withParams(
        {
            email: mailtoless(textOf(parsed)),
            name: paramText(params, "cn") ?? "",
            role: ROLES.includes(role) ? role : "REQ-PARTICIPANT",
            partstat: PARTSTATS.includes(partstat) ? partstat : "NEEDS-ACTION",
            rsvp: (paramText(params, "rsvp") ?? "").toUpperCase() === "TRUE",
            type: USER_TYPES.includes(cutype) ? cutype : "INDIVIDUAL"
        },
        restParams(params, known)
    );
}

function readAlarm(raw: RawComponent): T.Alarm | null {
    if (raw.broken || raw.children.length > 0) return null;
    let action: T.AlarmAction | null = null;
    let trigger: T.Alarm["trigger"] | null = null;
    let description: string | null = null;
    const extra: T.ExtraProperty[] = [];
    for (const line of raw.lines) {
        const name = lineName(line);
        if (name === "ACTION" && action === null) {
            const value = textOf(parseLine(line)).toUpperCase();
            if (!ACTIONS.includes(value as T.AlarmAction)) return null;
            action = value as T.AlarmAction;
        } else if (name === "TRIGGER" && trigger === null) {
            const parsed = parseLine(line);
            const value = String(parsed.values[0] ?? "");
            if (parsed.type === "date-time") {
                if (!DATE_TIME.test(value)) return null;
                // RFC 5545 3.8.6.3: an absolute trigger is in UTC.
                trigger = { kind: "absolute", at: value.endsWith("Z") ? value : `${value}Z` };
            } else {
                const seconds = ICAL.Duration.fromString(value).toSeconds();
                const related = (paramText(parsed.params, "related") ?? "START").toUpperCase() === "END" ? "END" : "START";
                trigger = { kind: "relative", minutes: seconds / 60, related };
            }
        } else if (name === "DESCRIPTION" && description === null) {
            description = textOf(parseLine(line));
        } else extra.push({ line });
    }
    if (!action || !trigger) return null;
    return { action, trigger, description: description ?? "", extra };
}

/** The stable UID a component with none gets: a hash of its own text. */
function derivedUid(raw: RawComponent): string {
    let hash = 0x811c9dc5;
    for (const char of raw.lines.join("\n")) {
        hash ^= char.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `polaris-${hash.toString(16).padStart(8, "0")}`;
}

/** Text of a nested component as written: unfolded lines joined with CRLF. */
function componentText(raw: RawComponent): string {
    const lines = [`BEGIN:${raw.name}`, ...raw.lines, ...raw.children.map(componentText), `END:${raw.name}`];
    return lines.join("\r\n");
}

const EVENT_FIELDS = new Set([
    "UID",
    "RECURRENCE-ID",
    "SUMMARY",
    "DESCRIPTION",
    "LOCATION",
    "DTSTART",
    "DTEND",
    "DURATION",
    "STATUS",
    "TRANSP",
    "CLASS",
    "CATEGORIES",
    "COLOR",
    "URL",
    "ORGANIZER",
    "ATTENDEE",
    "RRULE",
    "EXDATE",
    "RDATE",
    "SEQUENCE",
    "ATTACH",
    "CONFERENCE",
    "X-POLARIS-KIND",
    "CREATED",
    "LAST-MODIFIED"
]);

/** Read one VEVENT. Throws with a readable reason when it cannot be used. */
function readEvent(raw: RawComponent, zones: Set<string>): T.CalendarEvent {
    if (raw.broken) throw new Error(raw.broken);
    const seen = new Set<string>();
    const extra: T.ExtraProperty[] = [];
    const extraComponents: string[] = [];
    const alarms: T.Alarm[] = [];
    const attendees: T.Attendee[] = [];
    const attachments: T.Attachment[] = [];
    const categories: string[] = [];
    const exdates: T.DateValue[] = [];
    const rdates: T.DateValue[] = [];
    const single = new Map<string, ParsedLine>();
    let googleConference = "";
    for (const line of raw.lines) {
        const name = lineName(line);
        if (name === "X-GOOGLE-CONFERENCE" && !googleConference) googleConference = textOf(parseLine(line));
        if (!EVENT_FIELDS.has(name)) {
            extra.push({ line });
            continue;
        }
        const parsed = parseLine(line);
        switch (name) {
            case "ATTENDEE":
                attendees.push(readAttendee(parsed));
                break;
            case "CATEGORIES":
                categories.push(...parsed.values.map((value) => String(value).trim()).filter(Boolean));
                break;
            case "EXDATE":
                // A date list this model cannot read is kept as written rather
                // than costing the whole event.
                try {
                    exdates.push(...dateValues(parsed, zones));
                } catch {
                    extra.push({ line });
                }
                break;
            case "RDATE":
                // A PERIOD RDATE has an end of its own this model cannot hold:
                // kept as written, not expanded.
                if (parsed.type === "period") extra.push({ line });
                else {
                    try {
                        rdates.push(...dateValues(parsed, zones));
                    } catch {
                        extra.push({ line });
                    }
                }
                break;
            case "ATTACH": {
                if (parsed.type === "binary" || paramText(parsed.params, "encoding")) {
                    extra.push({ line });
                    break;
                }
                attachments.push(
                    withParams(
                        { uri: textOf(parsed), name: paramText(parsed.params, "filename") ?? "", mime: paramText(parsed.params, "fmttype") ?? "" },
                        restParams(parsed.params, ["filename", "fmttype"])
                    )
                );
                break;
            }
            default:
                if (seen.has(name)) extra.push({ line });
                else single.set(name, parsed);
        }
        seen.add(name);
    }
    for (const child of raw.children) {
        const alarm = child.name === "VALARM" ? readAlarm(child) : null;
        if (alarm) alarms.push(alarm);
        else extraComponents.push(componentText(child));
    }
    const startLine = single.get("DTSTART");
    if (!startLine) throw new Error("A VEVENT has no DTSTART.");
    const start = dateValues(startLine, zones)[0];
    if (!start) throw new Error("A VEVENT has an empty DTSTART.");
    const end = eventEnd(start, single.get("DTEND"), single.get("DURATION"), zones);
    const text = (name: string) => {
        const parsed = single.get(name);
        return parsed ? textOf(parsed) : "";
    };
    const recurrenceLine = single.get("RECURRENCE-ID");
    const recurrenceId = recurrenceLine ? (dateValues(recurrenceLine, zones)[0] ?? null) : null;
    let rule = null;
    const ruleLine = single.get("RRULE");
    if (ruleLine) {
        const rawRule = /^RRULE(?:;[^:]*)?:(.*)$/i.exec(raw.lines.find((line) => lineName(line) === "RRULE") ?? "")?.[1] ?? "";
        try {
            rule = parseRule(rawRule);
        } catch {
            extra.push({ line: `RRULE:${rawRule}` });
        }
    }
    const status = text("STATUS").toUpperCase();
    const classification = text("CLASS").toUpperCase();
    const kind = text("X-POLARIS-KIND");
    const organizer = single.get("ORGANIZER");
    const sequence = Number.parseInt(text("SEQUENCE"), 10);
    if (status && !EVENT_STATUSES.includes(status as T.EventStatus)) extra.push({ line: property("status", {}, "text", status) });
    if (classification && !CLASSES.includes(classification as T.Classification)) extra.push({ line: property("class", {}, "text", classification) });
    const stamp = (name: string) => {
        const parsed = single.get(name);
        const value = parsed ? String(parsed.values[0] ?? "") : "";
        return value || null;
    };
    return {
        uid: text("UID") || derivedUid(raw),
        recurrenceId,
        thisAndFuture: recurrenceLine ? (paramText(recurrenceLine.params, "range") ?? "").toUpperCase() === "THISANDFUTURE" : false,
        summary: text("SUMMARY"),
        description: text("DESCRIPTION"),
        location: text("LOCATION"),
        start,
        end,
        status: EVENT_STATUSES.includes(status as T.EventStatus) ? (status as T.EventStatus) : null,
        transparency: text("TRANSP").toUpperCase() === "TRANSPARENT" ? "TRANSPARENT" : "OPAQUE",
        classification: CLASSES.includes(classification as T.Classification) ? (classification as T.Classification) : "PUBLIC",
        categories,
        color: text("COLOR") || null,
        url: text("URL"),
        organizer: organizer ? readPerson(organizer) : null,
        attendees,
        alarms,
        rule,
        exdates,
        rdates,
        sequence: Number.isFinite(sequence) ? sequence : 0,
        attachments,
        conference: text("CONFERENCE") || googleConference,
        kind: KINDS.includes(kind as T.EventKind) ? (kind as T.EventKind) : "default",
        created: stamp("CREATED"),
        lastModified: stamp("LAST-MODIFIED"),
        extra,
        extraComponents
    };
}

/**
 * DTEND, or DTSTART plus DURATION, or RFC 5545's default: the start itself for
 * a timed event, the next day for an all-day one. An end of the other kind, or
 * one before the start, is read as that default too.
 */
function eventEnd(start: T.DateValue, endLine: ParsedLine | undefined, durationLine: ParsedLine | undefined, zones: Set<string>): T.DateValue {
    const fallback: T.DateValue = isDateOnly(start) ? { date: addDays(start.date, 1) } : start;
    if (endLine) {
        const end = dateValues(endLine, zones)[0];
        if (!end || isDateOnly(end) !== isDateOnly(start)) return fallback;
        if (isDateOnly(end) && isDateOnly(start)) return end.date > start.date ? end : fallback;
        if (isDateOnly(end) || isDateOnly(start)) return fallback;
        const before = end.tzid === start.tzid ? end.dateTime < start.dateTime : valueToInstant(end, "UTC") < valueToInstant(start, "UTC");
        return before ? fallback : end;
    }
    if (durationLine) {
        const duration = ICAL.Duration.fromString(String(durationLine.values[0] ?? ""));
        if (duration.isNegative) return fallback;
        const days = duration.weeks * 7 + duration.days;
        if (isDateOnly(start)) return { date: addDays(start.date, Math.max(1, days)) };
        const seconds = duration.hours * 3600 + duration.minutes * 60 + duration.seconds;
        return { dateTime: formatWall(addToWall(valueWall(start), { days, seconds })), tzid: start.tzid };
    }
    return fallback;
}

const TODO_FIELDS = new Set(["UID", "SUMMARY", "DESCRIPTION", "DTSTART", "DUE", "COMPLETED", "STATUS", "PERCENT-COMPLETE", "PRIORITY", "CATEGORIES", "RRULE"]);

function readTodo(raw: RawComponent, zones: Set<string>): T.CalendarTodo {
    if (raw.broken) throw new Error(raw.broken);
    const extra: T.ExtraProperty[] = [];
    const extraComponents: string[] = [];
    const alarms: T.Alarm[] = [];
    const categories: string[] = [];
    const single = new Map<string, ParsedLine>();
    let ruleText: string | null = null;
    for (const line of raw.lines) {
        const name = lineName(line);
        if (!TODO_FIELDS.has(name) || (name !== "CATEGORIES" && single.has(name))) {
            extra.push({ line });
            continue;
        }
        const parsed = parseLine(line);
        if (name === "CATEGORIES") categories.push(...parsed.values.map((value) => String(value).trim()).filter(Boolean));
        else single.set(name, parsed);
        if (name === "RRULE") ruleText = /^RRULE(?:;[^:]*)?:(.*)$/i.exec(line)?.[1] ?? "";
    }
    for (const child of raw.children) {
        const alarm = child.name === "VALARM" ? readAlarm(child) : null;
        if (alarm) alarms.push(alarm);
        else extraComponents.push(componentText(child));
    }
    const text = (name: string) => {
        const parsed = single.get(name);
        return parsed ? textOf(parsed) : "";
    };
    const date = (name: string) => {
        const parsed = single.get(name);
        return parsed ? (dateValues(parsed, zones)[0] ?? null) : null;
    };
    let rule = null;
    if (ruleText !== null) {
        try {
            rule = parseRule(ruleText);
        } catch {
            extra.push({ line: `RRULE:${ruleText}` });
        }
    }
    const status = text("STATUS").toUpperCase();
    if (status && !TODO_STATUSES.includes(status as T.TodoStatus)) extra.push({ line: property("status", {}, "text", status) });
    const percent = Number.parseInt(text("PERCENT-COMPLETE"), 10);
    const priority = Number.parseInt(text("PRIORITY"), 10);
    const completed = single.get("COMPLETED");
    return {
        uid: text("UID") || derivedUid(raw),
        summary: text("SUMMARY"),
        description: text("DESCRIPTION"),
        start: date("DTSTART"),
        due: date("DUE"),
        completed: completed ? String(completed.values[0] ?? "") || null : null,
        status: TODO_STATUSES.includes(status as T.TodoStatus) ? (status as T.TodoStatus) : "NEEDS-ACTION",
        percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0,
        priority: Number.isFinite(priority) ? Math.min(9, Math.max(0, priority)) : 0,
        categories,
        alarms,
        rule,
        extra,
        extraComponents
    };
}

/** The VTIMEZONE blocks an item's TZIDs refer to, matched by name or by the
 *  zone both names resolve to. */
function timezonesFor(zones: ReadonlySet<string>, blocks: readonly string[]): string[] {
    const wanted = [...zones];
    return blocks.filter((block) => {
        const id = vtimezoneId(block);
        if (!id) return false;
        const resolved = resolveZone(id);
        return wanted.some((tzid) => tzid === id || (resolved !== null && resolveZone(tzid) === resolved));
    });
}

/**
 * Read a calendar file: iCalendar text or jCal JSON.
 *
 * VEVENTs sharing a UID become one item (master plus overrides); each VTODO is
 * an item of its own. A component that cannot be read is skipped and named in
 * `errors`; nothing here throws for one bad event. VJOURNAL and VFREEBUSY are
 * not calendar entries and are passed over without an error.
 */
export function parseCalendarText(text: string): ParsedCalendar {
    const problems: ParseProblem[] = [];
    const trimmed = text.replace(/^﻿/, "").trimStart();
    const roots = trimmed.startsWith("[") ? readJcal(trimmed, problems) : readStructure(trimmed);
    const calendars = roots.filter((root) => root.name === "VCALENDAR");
    if (calendars.length === 0 && trimmed && problems.length === 0) problems.push({ key: "parse.noCalendar", values: {}, detail: "No VCALENDAR." });
    let name: string | null = null;
    let color: string | null = null;
    let timezone: string | null = null;
    const events = new Map<string, { master: T.CalendarEvent | null; overrides: T.CalendarEvent[]; zones: Set<string>; method: string | null; blocks: string[] }>();
    // Items in the order the file first mentions them: an event's place is
    // where its first component was.
    const order: (string | T.CalendarItem)[] = [];
    for (const calendar of calendars) {
        let method: string | null = null;
        for (const line of calendar.lines) {
            const property = lineName(line);
            const read = () => {
                try {
                    return textOf(parseLine(line)) || null;
                } catch {
                    return null;
                }
            };
            if (property === "X-WR-CALNAME" || (property === "NAME" && name === null)) name = read() ?? name;
            else if (property === "X-APPLE-CALENDAR-COLOR" || (property === "COLOR" && color === null)) color = read() ?? color;
            else if (property === "X-WR-TIMEZONE") timezone = resolveZone(read()) ?? read();
            else if (property === "METHOD") method = read()?.toUpperCase() ?? null;
        }
        const blocks = calendar.children.filter((child) => child.name === "VTIMEZONE" && !child.broken).map(componentText);
        for (const child of calendar.children) {
            if (child.name === "VEVENT") {
                const zones = new Set<string>();
                try {
                    const event = readEvent(child, zones);
                    const entry = events.get(event.uid) ?? { master: null, overrides: [], zones: new Set<string>(), method, blocks: [] };
                    for (const zone of zones) entry.zones.add(zone);
                    entry.blocks.push(...blocks.filter((block) => !entry.blocks.includes(block)));
                    if (event.recurrenceId) {
                        const duplicate = entry.overrides.some((other) => JSON.stringify(other.recurrenceId) === JSON.stringify(event.recurrenceId));
                        if (duplicate) problems.push({ key: "parse.duplicateOccurrence", values: { name: event.summary || event.uid }, detail: event.uid });
                        else entry.overrides.push(event);
                    } else if (entry.master) problems.push({ key: "parse.duplicateEvent", values: { name: event.summary || event.uid }, detail: event.uid });
                    else entry.master = event;
                    if (!events.has(event.uid)) order.push(event.uid);
                    events.set(event.uid, entry);
                } catch (error) {
                    problems.push({ key: "parse.eventUnreadable", values: {}, detail: (error as Error).message });
                }
            } else if (child.name === "VTODO") {
                const zones = new Set<string>();
                try {
                    const todo = readTodo(child, zones);
                    order.push({ component: "VTODO", uid: todo.uid, todo, timezones: timezonesFor(zones, blocks), method });
                } catch (error) {
                    problems.push({ key: "parse.todoUnreadable", values: {}, detail: (error as Error).message });
                }
            }
        }
    }
    const items = order.map((entry): T.CalendarItem => {
        if (typeof entry !== "string") return entry;
        const found = events.get(entry);
        if (!found) throw new Error(`Lost the event ${entry}.`);
        return { component: "VEVENT", uid: entry, master: found.master, overrides: found.overrides, timezones: timezonesFor(found.zones, found.blocks), method: found.method };
    });
    return { items, name, color, timezone, errors: problems.map((problem) => problem.key), problems };
}

/* ------------------------------------------------------------------ writing */

/** Fold one content line at 75 octets (RFC 5545 3.1), never inside a character. */
export function foldLine(line: string): string {
    const encoder = new TextEncoder();
    const out: string[] = [];
    let current = "";
    let size = 0;
    let limit = 75;
    for (const char of line) {
        const bytes = encoder.encode(char).length;
        if (size + bytes > limit) {
            out.push(current);
            current = "";
            size = 0;
            // A continuation line starts with one space, which counts.
            limit = 74;
        }
        current += char;
        size += bytes;
    }
    out.push(current);
    return out.join("\r\n ");
}

/** A value as it may appear on one content line. ical.js escapes a line feed
 *  in TEXT (and RFC 6868 in a parameter) and passes every other control
 *  character through, so a TEXT value or a parameter keeps its tabs and line
 *  breaks (as line feeds) and any other value loses every control character. */
function lineSafe(value: string, text: boolean): string {
    if (!text) return value.replace(/[\u0000-\u001F\u007F]/g, "");
    return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

function property(name: string, params: Params, type: string, ...values: unknown[]): string {
    const clean: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== "" && value !== undefined) clean[key] = typeof value === "string" ? lineSafe(value, true) : value.map((entry) => lineSafe(entry, true));
    }
    const safe = values.map((value) => (typeof value === "string" ? lineSafe(value, type === "text") : value));
    return new ICAL.Property([name.toLowerCase(), clean, type, ...safe]).toICALString();
}

function dateLine(name: string, value: T.DateValue, params: Params = {}): string {
    if (isDateOnly(value)) return property(name, params, "date", value.date);
    if (value.tzid === "UTC") return property(name, params, "date-time", `${value.dateTime}Z`);
    if (value.tzid === null) return property(name, params, "date-time", value.dateTime);
    return property(name, { tzid: value.tzid, ...params }, "date-time", value.dateTime);
}

function stampLine(name: string, value: string): string {
    return property(name, {}, "date-time", value);
}

function address(email: string): string {
    return email.includes(":") ? email : `mailto:${email}`;
}

function personParams(person: T.Person): Params {
    return { ...(person.name ? { cn: person.name } : {}), ...(person.params ?? {}) };
}

function attendeeLine(attendee: T.Attendee): string {
    const params: Record<string, string | readonly string[]> = {};
    if (attendee.name) params.cn = attendee.name;
    params.role = attendee.role;
    params.partstat = attendee.partstat;
    if (attendee.rsvp) params.rsvp = "TRUE";
    if (attendee.type !== "INDIVIDUAL") params.cutype = attendee.type;
    return property("attendee", { ...params, ...(attendee.params ?? {}) }, "cal-address", address(attendee.email));
}

function alarmLines(alarm: T.Alarm): string[] {
    const lines = ["BEGIN:VALARM", property("action", {}, "text", alarm.action)];
    if (alarm.trigger.kind === "absolute") lines.push(property("trigger", {}, "date-time", `${absoluteInstant(alarm.trigger.at).toISOString().slice(0, 19)}Z`));
    else {
        const duration = ICAL.Duration.fromSeconds(Math.round(alarm.trigger.minutes * 60)).toString();
        lines.push(property("trigger", alarm.trigger.related === "END" ? { related: "END" } : {}, "duration", duration));
    }
    if (alarm.description || alarm.action !== "AUDIO") lines.push(property("description", {}, "text", alarm.description));
    lines.push(...(alarm.extra ?? []).map((extra) => extra.line));
    lines.push("END:VALARM");
    return lines;
}

function splitLines(block: string): string[] {
    return block.split(/\r\n|\n/).filter((line) => line !== "");
}

/**
 * The extra lines with DTSTAMP settled: the caller's "now" replaces the one the
 * file had, in its place; the one the file had is kept as it was; with neither,
 * the last change is used, and the epoch only as a last resort because DTSTAMP
 * is required. Returns the DTSTAMP to write up front (when not among the
 * extra lines) and the extra lines to write later.
 */
function stamped(extra: readonly T.ExtraProperty[], fallback: string | null, now: Date | undefined): { head: string[]; rest: string[] } {
    const nowLine = now ? stampLine("dtstamp", `${now.toISOString().slice(0, 19)}Z`) : null;
    const lines = extra.map((entry) => entry.line);
    const at = lines.findIndex((line) => lineName(line) === "DTSTAMP");
    if (at >= 0) return { head: [], rest: lines.map((line, index) => (index === at && nowLine ? nowLine : line)) };
    return { head: [nowLine ?? stampLine("dtstamp", fallback && fallback.endsWith("Z") ? fallback : "1970-01-01T00:00:00Z")], rest: lines };
}

function eventLines(event: T.CalendarEvent, now: Date | undefined): string[] {
    const lines = ["BEGIN:VEVENT", property("uid", {}, "text", event.uid)];
    const dtstamp = stamped(event.extra, event.lastModified ?? event.created, now);
    lines.push(...dtstamp.head);
    if (event.recurrenceId) lines.push(dateLine("recurrence-id", event.recurrenceId, event.thisAndFuture ? { range: "THISANDFUTURE" } : {}));
    lines.push(dateLine("dtstart", event.start), dateLine("dtend", event.end));
    if (event.sequence !== 0) lines.push(property("sequence", {}, "integer", event.sequence));
    if (event.summary) lines.push(property("summary", {}, "text", event.summary));
    if (event.description) lines.push(property("description", {}, "text", event.description));
    if (event.location) lines.push(property("location", {}, "text", event.location));
    if (event.status) lines.push(property("status", {}, "text", event.status));
    if (event.transparency !== "OPAQUE") lines.push(property("transp", {}, "text", event.transparency));
    if (event.classification !== "PUBLIC") lines.push(property("class", {}, "text", event.classification));
    if (event.categories.length > 0) lines.push(property("categories", {}, "text", ...event.categories));
    if (event.color) lines.push(property("color", {}, "text", event.color));
    if (event.url) lines.push(property("url", {}, "uri", event.url));
    if (event.organizer) lines.push(property("organizer", personParams(event.organizer), "cal-address", address(event.organizer.email)));
    lines.push(...event.attendees.map(attendeeLine));
    if (event.rule) lines.push(`RRULE:${lineSafe(event.rule.raw, false)}`);
    lines.push(...event.rdates.map((value) => dateLine("rdate", value)));
    lines.push(...event.exdates.map((value) => dateLine("exdate", value)));
    for (const attachment of event.attachments) {
        const params = { ...(attachment.mime ? { fmttype: attachment.mime } : {}), ...(attachment.name ? { filename: attachment.name } : {}), ...(attachment.params ?? {}) };
        lines.push(property("attach", params, "uri", attachment.uri));
    }
    const google = event.extra.find((entry) => lineName(entry.line) === "X-GOOGLE-CONFERENCE");
    // Google's own line already says it; a second, standard one would be read
    // back as the same link.
    const googleUrl = google ? textOf(parseLine(google.line)) : undefined;
    if (event.conference && event.conference !== googleUrl) lines.push(property("conference", {}, "uri", event.conference));
    if (event.kind !== "default") lines.push(property("x-polaris-kind", {}, "unknown", event.kind));
    if (event.created) lines.push(stampLine("created", event.created));
    if (event.lastModified) lines.push(stampLine("last-modified", event.lastModified));
    lines.push(...dtstamp.rest);
    for (const alarm of event.alarms) lines.push(...alarmLines(alarm));
    for (const block of event.extraComponents ?? []) lines.push(...splitLines(block));
    lines.push("END:VEVENT");
    return lines;
}

function todoLines(todo: T.CalendarTodo, now: Date | undefined): string[] {
    const lines = ["BEGIN:VTODO", property("uid", {}, "text", todo.uid)];
    const dtstamp = stamped(todo.extra, todo.completed, now);
    lines.push(...dtstamp.head);
    if (todo.summary) lines.push(property("summary", {}, "text", todo.summary));
    if (todo.description) lines.push(property("description", {}, "text", todo.description));
    if (todo.start) lines.push(dateLine("dtstart", todo.start));
    if (todo.due) lines.push(dateLine("due", todo.due));
    if (todo.completed) lines.push(stampLine("completed", todo.completed));
    lines.push(property("status", {}, "text", todo.status));
    if (todo.percent > 0) lines.push(property("percent-complete", {}, "integer", todo.percent));
    if (todo.priority > 0) lines.push(property("priority", {}, "integer", todo.priority));
    if (todo.categories.length > 0) lines.push(property("categories", {}, "text", ...todo.categories));
    if (todo.rule) lines.push(`RRULE:${lineSafe(todo.rule.raw, false)}`);
    lines.push(...dtstamp.rest);
    for (const alarm of todo.alarms) lines.push(...alarmLines(alarm));
    for (const block of todo.extraComponents ?? []) lines.push(...splitLines(block));
    lines.push("END:VTODO");
    return lines;
}

/**
 * One item as a whole VCALENDAR: VERSION, PRODID, CALSCALE, METHOD when asked
 * for, the item's VTIMEZONEs as they were read, then the master and every
 * override. Lines are folded at 75 octets and end in CRLF.
 *
 * `now` sets DTSTAMP on every component; without it the DTSTAMP the file had is
 * kept. METHOD is never copied from the item: a stored object must not carry
 * one (RFC 4791 4.1), only a message does.
 */
export function serializeItem(item: T.CalendarItem, options: { method?: string; prodId?: string; now?: Date } = {}): string {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", property("prodid", {}, "text", options.prodId ?? DEFAULT_PRODID), "CALSCALE:GREGORIAN"];
    if (options.method) lines.push(property("method", {}, "text", options.method.toUpperCase()));
    for (const block of item.timezones) lines.push(...splitLines(block));
    const components: string[] = [];
    if (item.component === "VEVENT") {
        if (item.master) components.push(...eventLines(item.master, options.now));
        for (const override of item.overrides) components.push(...eventLines(override, options.now));
    } else components.push(...todoLines(item.todo, options.now));
    lines.push(...missingTimezones(components, item.timezones), ...components);
    lines.push("END:VCALENDAR");
    return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/**
 * A VTIMEZONE for every TZID the components use that the item does not define
 * (RFC 5545 3.2.19), written from the zone's current rules for the year the
 * events start in. A zone the file defined itself keeps its own block.
 */
function missingTimezones(components: readonly string[], timezones: readonly string[]): string[] {
    const defined = new Set(timezones.map((block) => vtimezoneId(block)).filter((id): id is string => Boolean(id)));
    const years = new Map<string, number>();
    for (const line of components) {
        for (const match of line.matchAll(/;TZID=("[^"]+"|[^;:]+)[^:]*:(\d{4})/g)) {
            const id = match[1]!.replace(/^"|"$/g, "");
            const year = Number(match[2]);
            if (!defined.has(id) && (!years.has(id) || year < years.get(id)!)) years.set(id, year);
        }
    }
    const out: string[] = [];
    for (const [id, year] of years) {
        const block = vtimezoneFor(id, year);
        if (block) out.push(...splitLines(block));
    }
    return out;
}

/* ------------------------------------------------------------------ building */

function newUid(): string {
    return globalThis.crypto.randomUUID();
}

/** A new event with every field at its default and a fresh UID. */
export function newEvent(input: Partial<T.CalendarEvent> & { start: T.DateValue; end: T.DateValue }): T.CalendarEvent {
    return {
        uid: newUid(),
        recurrenceId: null,
        thisAndFuture: false,
        summary: "",
        description: "",
        location: "",
        status: null,
        transparency: "OPAQUE",
        classification: "PUBLIC",
        categories: [],
        color: null,
        url: "",
        organizer: null,
        attendees: [],
        alarms: [],
        rule: null,
        exdates: [],
        rdates: [],
        sequence: 0,
        attachments: [],
        conference: "",
        kind: "default",
        created: null,
        lastModified: null,
        extra: [],
        extraComponents: [],
        ...input
    };
}

/** A new task with every field at its default and a fresh UID. */
export function newTodo(input: Partial<T.CalendarTodo> = {}): T.CalendarTodo {
    return {
        uid: newUid(),
        summary: "",
        description: "",
        start: null,
        due: null,
        completed: null,
        status: "NEEDS-ACTION",
        percent: 0,
        priority: 0,
        categories: [],
        alarms: [],
        rule: null,
        extra: [],
        extraComponents: [],
        ...input
    };
}

/** An item holding one event (no overrides). */
export function eventItem(event: T.CalendarEvent, timezones: readonly string[] = []): T.CalendarItem {
    return { component: "VEVENT", uid: event.uid, master: event, overrides: [], timezones, method: null };
}

/** An item holding one task. */
export function todoItem(todo: T.CalendarTodo, timezones: readonly string[] = []): T.CalendarItem {
    return { component: "VTODO", uid: todo.uid, todo, timezones, method: null };
}

/** How many occurrences are counted before a series is treated as endless. */
const BOUNDS_CAP = 5000;

/** What the database indexes an item by. */
export interface ItemBounds {
    readonly startsAt: Date | null;
    /** Null when the item repeats forever (or past 5000 occurrences). */
    readonly endsAt: Date | null;
    readonly recurring: boolean;
    readonly allDay: boolean;
    readonly summary: string;
    readonly location: string;
    readonly status: string;
}

/**
 * The columns a stored item is found by: when it starts, when its last
 * occurrence ends (null: it never stops), and its headline fields. A finite
 * series is walked to its end, up to 5000 occurrences; one longer than that is
 * indexed as endless, which only means it is always fetched.
 */
export function itemBounds(item: T.CalendarItem, floatingZone: string): ItemBounds {
    if (item.component === "VTODO") {
        const { todo } = item;
        const start = todo.start ? valueToInstant(todo.start, floatingZone, item.timezones) : null;
        const due = todo.due ? valueToInstant(todo.due, floatingZone, item.timezones) : null;
        const recurring = todo.rule !== null;
        const endless = recurring && todo.rule?.count === null && todo.rule.until === null;
        const reference = todo.due ?? todo.start;
        return {
            startsAt: start ?? due,
            endsAt: endless ? null : (due ?? start),
            recurring,
            allDay: reference ? isDateOnly(reference) : false,
            summary: todo.summary,
            location: "",
            status: todo.status
        };
    }
    const context: ExpandContext = { floatingZone, timezones: item.timezones };
    const headline = item.master ?? item.overrides[0];
    if (!headline) return { startsAt: null, endsAt: null, recurring: false, allDay: false, summary: "", location: "", status: "" };
    const spans = [item.master, ...item.overrides].filter((event): event is T.CalendarEvent => event !== null).map((event) => placeEvent(event, context));
    let startsAt = new Date(Math.min(...spans.map((span) => span.start.getTime())));
    let endsAt: Date | null = new Date(Math.max(...spans.map((span) => span.end.getTime())));
    const master = item.master;
    const recurring = master ? isRecurring(master) : item.overrides.length > 0;
    if (master && isRecurring(master)) {
        const rule = master.rule;
        if (rule && rule.count === null && rule.until === null) endsAt = null;
        else {
            const starts = generateStarts(master, context, null, BOUNDS_CAP + 1);
            const last = starts[starts.length - 1];
            if (starts.length > BOUNDS_CAP || !last) endsAt = null;
            else {
                const lastStart = clockFor(isDateOnly(master.start) ? null : master.start.tzid, floatingZone, item.timezones).toInstant(last.wall);
                // A THISANDFUTURE override may have moved the last ones later,
                // by up to its wall-clock shift and a clock change.
                const reach = thisAndFutureReach(item, context) * 1000 + 3_600_000;
                const occurrences = expandItem(item, { from: new Date(lastStart.getTime() - 1), to: new Date(lastStart.getTime() + reach) }, { floatingZone, limit: BOUNDS_CAP + item.overrides.length + 1 });
                const lastEnd = Math.max(...occurrences.map((occurrence) => occurrence.end.getTime()), lastStart.getTime());
                endsAt = new Date(Math.max(lastEnd, endsAt?.getTime() ?? 0));
            }
        }
        const firstStart = valueToInstant(master.start, floatingZone, item.timezones);
        if (firstStart < startsAt) startsAt = firstStart;
    }
    return {
        startsAt,
        endsAt,
        recurring,
        allDay: isDateOnly(headline.start),
        summary: headline.summary,
        location: headline.location,
        status: headline.status ?? ""
    };
}
