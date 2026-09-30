/**
 * Microsoft 365 and Outlook.com calendars, through Microsoft Graph v1.0.
 *
 * Pulls use `calendarView/delta`, which answers in expanded occurrences over a
 * window, not in series. The sync engine stores one object per series, so every
 * series the delta touches is read back whole - the master with its
 * `exceptionOccurrences` and `cancelledOccurrences` - and becomes one object:
 * the master with an RRULE, its exceptions as overrides, its cancelled
 * occurrences as EXDATEs. Outlook's `patternedRecurrence` and RRULE are mapped
 * both ways; a rule Outlook cannot hold is refused on write rather than bent.
 *
 * Times are asked for in UTC (`Prefer: outlook.timezone="UTC"`) and placed in
 * the event's own zone here, so a weekly rule's weekday is the organizer's.
 */

import { z } from "zod";
import * as bridge from "./bridge";
import type * as types from "../../engine/types";
import { errorFor, readJson, retryAfter, send, type Fetcher } from "./http";
import type { CalendarProvider, ChangeSet, RemoteCalendar, RemoteObject } from "./provider";
import { SyncAuthError, SyncError, SyncGoneError, SyncRefusedError, SyncUnreachableError } from "./errors";

export const GRAPH_API = "https://graph.microsoft.com/v1.0";
const GRAPH_ORIGIN = "https://graph.microsoft.com";

/** How far back and ahead the delta window reaches by default. */
export const DEFAULT_WINDOW = { pastDays: 365, futureDays: 730 };

const PREFER = "odata.maxpagesize=200, outlook.timezone=\"UTC\"";

/**
 * IANA names Graph's `dateTimeTimeZone` documents accepting besides Windows
 * names (learn.microsoft.com, "dateTimeTimeZone resource type", "Additional
 * time zones"). A zone outside this list is written as UTC.
 */
const GRAPH_IANA_ZONES = new Set([
    "Etc/GMT+12", "Etc/GMT+11", "Pacific/Honolulu", "America/Anchorage", "America/Santa_Isabel", "America/Los_Angeles", "America/Phoenix",
    "America/Chihuahua", "America/Denver", "America/Guatemala", "America/Chicago", "America/Mexico_City", "America/Regina", "America/Bogota",
    "America/New_York", "America/Indiana/Indianapolis", "America/Caracas", "America/Asuncion", "America/Halifax", "America/Cuiaba",
    "America/La_Paz", "America/Santiago", "America/St_Johns", "America/Sao_Paulo", "America/Argentina/Buenos_Aires", "America/Cayenne",
    "America/Godthab", "America/Montevideo", "America/Bahia", "Etc/GMT+2", "Atlantic/Azores", "Atlantic/Cape_Verde", "Africa/Casablanca",
    "Etc/GMT", "Europe/London", "Atlantic/Reykjavik", "Europe/Berlin", "Europe/Budapest", "Europe/Paris", "Europe/Warsaw", "Africa/Lagos",
    "Africa/Windhoek", "Europe/Bucharest", "Asia/Beirut", "Africa/Cairo", "Asia/Damascus", "Africa/Johannesburg", "Europe/Kyiv",
    "Europe/Istanbul", "Asia/Jerusalem", "Asia/Amman", "Asia/Baghdad", "Europe/Kaliningrad", "Asia/Riyadh", "Africa/Nairobi", "Asia/Tehran",
    "Asia/Dubai", "Asia/Baku", "Europe/Moscow", "Indian/Mauritius", "Asia/Tbilisi", "Asia/Yerevan", "Asia/Kabul", "Asia/Karachi",
    "Asia/Kolkata", "Asia/Colombo", "Asia/Kathmandu", "Asia/Dhaka", "Asia/Yekaterinburg", "Asia/Bangkok", "Asia/Novosibirsk",
    "Asia/Shanghai", "Asia/Krasnoyarsk", "Asia/Singapore", "Australia/Perth", "Asia/Taipei", "Asia/Ulaanbaatar", "Asia/Irkutsk",
    "Asia/Tokyo", "Asia/Seoul", "Australia/Adelaide", "Australia/Darwin", "Australia/Brisbane", "Australia/Sydney", "Pacific/Port_Moresby",
    "Australia/Hobart", "Asia/Yakutsk", "Pacific/Guadalcanal", "Asia/Vladivostok", "Pacific/Auckland", "Etc/GMT-12", "Pacific/Fiji",
    "Asia/Magadan", "Pacific/Tongatapu", "Pacific/Apia", "Pacific/Kiritimati", "UTC"
]);

const GraphTime = z.object({ dateTime: z.string(), timeZone: z.string().nullish() });

const GraphRecipient = z.object({ emailAddress: z.object({ address: z.string().nullish(), name: z.string().nullish() }).nullish() });

const GraphPattern = z.object({
    type: z.string(),
    interval: z.number().nullish(),
    month: z.number().nullish(),
    dayOfMonth: z.number().nullish(),
    daysOfWeek: z.array(z.string()).nullish(),
    firstDayOfWeek: z.string().nullish(),
    index: z.string().nullish()
});

const GraphRange = z.object({
    type: z.string(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    numberOfOccurrences: z.number().nullish(),
    recurrenceTimeZone: z.string().nullish()
});

const GraphRecurrence = z.object({ pattern: GraphPattern, range: GraphRange });

export type GraphRecurrenceJson = z.infer<typeof GraphRecurrence>;

const GraphEventBase = z.object({
    id: z.string(),
    "@odata.etag": z.string().nullish(),
    changeKey: z.string().nullish(),
    "@removed": z.object({ reason: z.string().nullish() }).nullish(),
    type: z.string().nullish(),
    seriesMasterId: z.string().nullish(),
    iCalUId: z.string().nullish(),
    subject: z.string().nullish(),
    body: z.object({ contentType: z.string().nullish(), content: z.string().nullish() }).nullish(),
    location: z.object({ displayName: z.string().nullish() }).nullish(),
    start: GraphTime.nullish(),
    end: GraphTime.nullish(),
    isAllDay: z.boolean().nullish(),
    isCancelled: z.boolean().nullish(),
    attendees: z
        .array(GraphRecipient.extend({ type: z.string().nullish(), status: z.object({ response: z.string().nullish() }).nullish() }))
        .nullish(),
    organizer: GraphRecipient.nullish(),
    isReminderOn: z.boolean().nullish(),
    reminderMinutesBeforeStart: z.number().nullish(),
    showAs: z.string().nullish(),
    sensitivity: z.string().nullish(),
    onlineMeeting: z.object({ joinUrl: z.string().nullish() }).nullish(),
    recurrence: GraphRecurrence.nullish(),
    originalStart: z.string().nullish(),
    originalStartTimeZone: z.string().nullish(),
    categories: z.array(z.string()).nullish(),
    webLink: z.string().nullish(),
    cancelledOccurrences: z.array(z.string()).nullish(),
    createdDateTime: z.string().nullish(),
    lastModifiedDateTime: z.string().nullish()
});

const GraphEvent = GraphEventBase.extend({ exceptionOccurrences: z.array(GraphEventBase).nullish() });

export type GraphEventJson = z.infer<typeof GraphEvent>;

const DeltaPage = z.object({
    value: z.array(GraphEvent),
    "@odata.nextLink": z.string().optional(),
    "@odata.deltaLink": z.string().optional()
});

const CalendarsPage = z.object({
    value: z.array(
        z.object({
            id: z.string(),
            name: z.string().nullish(),
            hexColor: z.string().nullish(),
            canEdit: z.boolean().nullish()
        })
    ),
    "@odata.nextLink": z.string().optional()
});

const InstancesPage = z.object({ value: z.array(GraphEventBase), "@odata.nextLink": z.string().optional() });

const ErrorBody = z.object({ error: z.object({ code: z.string().nullish(), message: z.string().nullish() }) });

const GONE_CODES = new Set(["syncstatenotfound", "resyncrequired", "syncstateinvalid"]);

/** The sync error for a failed Graph response, read from its error body. */
async function graphError(response: Response): Promise<Error> {
    let code = "";
    let message = "";
    try {
        const parsed = ErrorBody.safeParse(await readJson(response));
        if (parsed.success) {
            code = parsed.data.error.code ?? "";
            message = parsed.data.error.message ?? "";
        }
    } catch {
        // The status alone still decides.
    }
    if (response.status === 410 || GONE_CODES.has(code.toLowerCase())) return new SyncGoneError("Microsoft discarded the sync state", response.status);
    if (response.status === 429) return new SyncUnreachableError("Microsoft asked to slow down", 429, retryAfter(response));
    return errorFor(response, message);
}

async function tokenFrom(accessToken: () => Promise<string>): Promise<string> {
    try {
        return await accessToken();
    } catch (error) {
        if (error instanceof SyncError) throw error;
        const text = error instanceof Error ? error.message : "";
        if (/invalid_grant|unauthorized|revoked/i.test(text)) throw new SyncAuthError("The account's sign-in expired or was revoked", null);
        throw new SyncUnreachableError("Could not refresh the account's sign-in", null);
    }
}

// --- Recurrence ------------------------------------------------------------

const DAY_TO_ICAL: Readonly<Record<string, types.Weekday>> = {
    sunday: "SU",
    monday: "MO",
    tuesday: "TU",
    wednesday: "WE",
    thursday: "TH",
    friday: "FR",
    saturday: "SA"
};

const ICAL_TO_DAY: Readonly<Record<types.Weekday, string>> = {
    SU: "sunday",
    MO: "monday",
    TU: "tuesday",
    WE: "wednesday",
    TH: "thursday",
    FR: "friday",
    SA: "saturday"
};

const INDEX_TO_ORDINAL: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

const ORDINAL_TO_INDEX: Readonly<Record<number, string>> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

/** The RRULE parts a `patternedRecurrence` can carry. */
const GRAPH_RULE_PARTS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "COUNT", "UNTIL", "WKST"]);

/** Refused a rule Outlook has no pattern for. */
function unsupportedRule(): never {
    throw new SyncRefusedError("Outlook cannot hold this repeat rule", null);
}

/**
 * Outlook's pattern as an RRULE value.
 *
 * `startWall` is the series start in `zone`: an `endDate` range ends after the
 * occurrence on that date, so UNTIL is the end of that day in the series zone,
 * written in UTC as RFC 5545 requires of a timed series.
 */
export function patternToRrule(recurrence: GraphRecurrenceJson, allDay: boolean, zone: string): string {
    const { pattern, range } = recurrence;
    const parts: string[] = [];
    const days = (pattern.daysOfWeek ?? []).map((d) => DAY_TO_ICAL[d.toLowerCase()]).filter((d): d is types.Weekday => Boolean(d));
    const interval = pattern.interval && pattern.interval > 1 ? pattern.interval : 1;
    const relative = () => {
        const ordinal = INDEX_TO_ORDINAL[(pattern.index ?? "first").toLowerCase()] ?? 1;
        if (days.length === 1) parts.push(`BYDAY=${ordinal}${days[0]}`);
        else if (days.length > 1) parts.push(`BYDAY=${days.join(",")}`, `BYSETPOS=${ordinal}`);
    };
    switch (pattern.type) {
        case "daily":
            parts.push("FREQ=DAILY");
            break;
        case "weekly":
            parts.push("FREQ=WEEKLY");
            if (days.length > 0) parts.push(`BYDAY=${days.join(",")}`);
            break;
        case "absoluteMonthly":
            parts.push("FREQ=MONTHLY");
            if (pattern.dayOfMonth) parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
            break;
        case "relativeMonthly":
            parts.push("FREQ=MONTHLY");
            relative();
            break;
        case "absoluteYearly":
            parts.push("FREQ=YEARLY");
            if (pattern.month) parts.push(`BYMONTH=${pattern.month}`);
            if (pattern.dayOfMonth) parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
            break;
        case "relativeYearly":
            parts.push("FREQ=YEARLY");
            if (pattern.month) parts.push(`BYMONTH=${pattern.month}`);
            relative();
            break;
        default:
            throw new SyncRefusedError("Outlook sent a repeat pattern this app does not know", null);
    }
    if (interval > 1) parts.splice(1, 0, `INTERVAL=${interval}`);
    if (range.type === "numbered" && range.numberOfOccurrences) parts.push(`COUNT=${range.numberOfOccurrences}`);
    else if (range.type === "endDate" && range.endDate) {
        if (allDay) parts.push(`UNTIL=${range.endDate.replace(/-/g, "")}`);
        else {
            const until = bridge.toInstant({ dateTime: `${range.endDate}T23:59:59`, tzid: zone });
            parts.push(`UNTIL=${until.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`);
        }
    }
    if (pattern.type === "weekly" && pattern.firstDayOfWeek) {
        const wkst = DAY_TO_ICAL[pattern.firstDayOfWeek.toLowerCase()];
        if (wkst) parts.push(`WKST=${wkst}`);
    }
    return parts.join(";");
}

/** An engine rule as Outlook's pattern and range; refuses what Outlook cannot express. */
export function ruleToPattern(rule: types.RecurrenceRule, start: types.DateValue, zone: string): GraphRecurrenceJson {
    // `supported` is about the editor; what matters here is whether the rule
    // uses a part Outlook has nothing for (BYHOUR, BYWEEKNO, BYYEARDAY...).
    const parts = rule.raw.split(";").map((piece) => piece.split("=")[0]!.trim().toUpperCase()).filter(Boolean);
    if (parts.some((part) => !GRAPH_RULE_PARTS.has(part))) unsupportedRule();
    const startDate = bridge.isDate(start) ? start.date : bridge.wallValue(bridge.toInstant(start), zone).dateTime.slice(0, 10);
    const startDay = new Date(`${startDate}T00:00:00Z`);
    const startWeekday = (["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const)[startDay.getUTCDay()]!;
    const pattern: z.infer<typeof GraphPattern> = { type: "daily", interval: rule.interval || 1 };
    const plainDays = rule.byDay.filter((d) => d.ordinal === null).map((d) => ICAL_TO_DAY[d.day]);
    const relative = (): void => {
        const ordinals = rule.byDay.map((d) => d.ordinal);
        if (rule.byDay.length === 1 && ordinals[0] !== null && rule.bySetPos.length === 0) {
            pattern.index = ORDINAL_TO_INDEX[ordinals[0]!] ?? unsupportedRule();
            pattern.daysOfWeek = [ICAL_TO_DAY[rule.byDay[0]!.day]];
        } else if (rule.byDay.length >= 1 && ordinals.every((o) => o === null) && rule.bySetPos.length === 1) {
            pattern.index = ORDINAL_TO_INDEX[rule.bySetPos[0]!] ?? unsupportedRule();
            pattern.daysOfWeek = plainDays;
        } else unsupportedRule();
    };
    if (rule.byMonthDay.length > 1 || rule.byMonth.length > 1) unsupportedRule();
    switch (rule.frequency) {
        case "DAILY":
            if (rule.byDay.length > 0) {
                if (rule.interval > 1 || plainDays.length !== rule.byDay.length) unsupportedRule();
                pattern.type = "weekly";
                pattern.daysOfWeek = plainDays;
                pattern.firstDayOfWeek = ICAL_TO_DAY[rule.weekStart ?? "SU"];
            }
            break;
        case "WEEKLY":
            if (plainDays.length !== rule.byDay.length) unsupportedRule();
            pattern.type = "weekly";
            pattern.daysOfWeek = plainDays.length > 0 ? plainDays : [ICAL_TO_DAY[startWeekday]];
            pattern.firstDayOfWeek = ICAL_TO_DAY[rule.weekStart ?? "SU"];
            break;
        case "MONTHLY":
            if (rule.byDay.length > 0) {
                pattern.type = "relativeMonthly";
                relative();
            } else {
                pattern.type = "absoluteMonthly";
                pattern.dayOfMonth = rule.byMonthDay[0] ?? startDay.getUTCDate();
            }
            break;
        case "YEARLY":
            pattern.month = rule.byMonth[0] ?? startDay.getUTCMonth() + 1;
            if (rule.byDay.length > 0) {
                pattern.type = "relativeYearly";
                relative();
            } else {
                pattern.type = "absoluteYearly";
                pattern.dayOfMonth = rule.byMonthDay[0] ?? startDay.getUTCDate();
            }
            break;
        default:
            unsupportedRule();
    }
    if (pattern.dayOfMonth !== undefined && pattern.dayOfMonth !== null && pattern.dayOfMonth < 1) unsupportedRule();
    const range: z.infer<typeof GraphRange> = { type: "noEnd", startDate, recurrenceTimeZone: zone };
    if (rule.count) {
        range.type = "numbered";
        range.numberOfOccurrences = rule.count;
    } else if (rule.until) {
        range.type = "endDate";
        range.endDate = bridge.isDate(rule.until) ? rule.until.date : bridge.wallValue(bridge.toInstant(rule.until, zone), zone).dateTime.slice(0, 10);
    }
    return { pattern, range };
}

// --- Events ----------------------------------------------------------------

/** A Graph time (UTC unless it says otherwise) as an instant. */
function graphInstant(time: z.infer<typeof GraphTime>): Date {
    const wall = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(time.dateTime)?.[1] ?? time.dateTime;
    return bridge.toInstant({ dateTime: wall, tzid: time.timeZone ?? "UTC" });
}

/** The zone an event was created in, as IANA, or UTC. */
function eventZone(event: z.infer<typeof GraphEventBase>, fallback: string | null): string {
    return bridge.zoneOrUtc(event.originalStartTimeZone ?? event.recurrence?.range.recurrenceTimeZone ?? fallback);
}

function graphValue(time: z.infer<typeof GraphTime> | null | undefined, allDay: boolean, zone: string): types.DateValue | null {
    if (!time) return null;
    if (allDay) return { date: time.dateTime.slice(0, 10) };
    const instant = graphInstant(time);
    return Number.isNaN(instant.getTime()) ? null : bridge.wallValue(instant, zone);
}

/** Escapes a value for an iCalendar TEXT property kept verbatim in `extra`. */
function icalText(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function unIcalText(value: string): string {
    return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const RESPONSE_TO_PARTSTAT: Readonly<Record<string, types.PartStat>> = {
    accepted: "ACCEPTED",
    organizer: "ACCEPTED",
    declined: "DECLINED",
    tentativelyAccepted: "TENTATIVE",
    none: "NEEDS-ACTION",
    notResponded: "NEEDS-ACTION"
};

/** One Graph event as an engine event, placed in `zone`. */
export function graphToEvent(event: z.infer<typeof GraphEventBase>, uid: string, zone: string, recurrenceId: types.DateValue | null): types.CalendarEvent | null {
    const allDay = Boolean(event.isAllDay);
    const start = graphValue(event.start, allDay, zone);
    if (!start) return null;
    const end = graphValue(event.end, allDay, zone) ?? start;
    const draft = bridge.blankEvent(uid, start, end);
    const extra: types.ExtraProperty[] = [];
    draft.recurrenceId = recurrenceId;
    draft.summary = event.subject ?? "";
    const content = event.body?.content ?? "";
    if ((event.body?.contentType ?? "").toLowerCase() === "html" && content.trim()) {
        extra.push({ line: `X-ALT-DESC;FMTTYPE=text/html:${icalText(content)}` });
        draft.description = bridge.htmlToText(content);
    } else draft.description = content;
    draft.location = event.location?.displayName ?? "";
    if (event.isCancelled) draft.status = "CANCELLED";
    const showAs = event.showAs ?? "busy";
    if (showAs === "free") draft.transparency = "TRANSPARENT";
    if (showAs === "oof") draft.kind = "outOfOffice";
    if (showAs === "tentative" || showAs === "workingElsewhere") extra.push({ line: `X-POLARIS-GRAPH-SHOWAS:${showAs}` });
    if (event.sensitivity === "private" || event.sensitivity === "personal") draft.classification = "PRIVATE";
    if (event.sensitivity === "confidential") draft.classification = "CONFIDENTIAL";
    if (event.sensitivity === "personal") extra.push({ line: "X-POLARIS-GRAPH-SENSITIVITY:personal" });
    const organizer = event.organizer?.emailAddress;
    if (organizer?.address) draft.organizer = { email: organizer.address.toLowerCase(), name: organizer.name ?? "" };
    draft.attendees = (event.attendees ?? [])
        .filter((a) => a.emailAddress?.address)
        .map((a) => ({
            email: a.emailAddress!.address!.toLowerCase(),
            name: a.emailAddress?.name ?? "",
            role: a.type === "optional" ? "OPT-PARTICIPANT" : a.type === "resource" ? "NON-PARTICIPANT" : "REQ-PARTICIPANT",
            partstat: RESPONSE_TO_PARTSTAT[a.status?.response ?? "none"] ?? "NEEDS-ACTION",
            rsvp: (a.status?.response ?? "none") === "none" || a.status?.response === "notResponded",
            type: a.type === "resource" ? "RESOURCE" : "INDIVIDUAL"
        }));
    if (event.isReminderOn && typeof event.reminderMinutesBeforeStart === "number") {
        draft.alarms = [{ action: "DISPLAY", trigger: { kind: "relative", minutes: -event.reminderMinutesBeforeStart, related: "START" }, description: draft.summary }];
    }
    draft.conference = event.onlineMeeting?.joinUrl ?? "";
    draft.categories = event.categories ?? [];
    draft.url = event.webLink ?? "";
    draft.created = bridge.stampOf(event.createdDateTime);
    draft.lastModified = bridge.stampOf(event.lastModifiedDateTime);
    if (!recurrenceId && event.recurrence) {
        Object.assign(draft, bridge.readRecurrence([`RRULE:${patternToRrule(event.recurrence, allDay, zone)}`], start));
    }
    draft.extra = extra;
    return draft;
}

/** The date an `OID.{masterId}.{yyyy-MM-dd}` occurrence id names, or null. */
export function occurrenceDate(occurrenceId: string): string | null {
    const match = /\.(\d{4}-\d{2}-\d{2})$/.exec(occurrenceId);
    return match ? match[1]! : null;
}

function etagOf(event: z.infer<typeof GraphEventBase>): string {
    return event["@odata.etag"] ?? event.changeKey ?? "";
}

/**
 * A series master (with its exceptions and cancelled occurrences) as one
 * object, or a single event as itself.
 */
export function seriesToObject(master: GraphEventJson): RemoteObject | null {
    const zone = eventZone(master, null);
    const uid = master.iCalUId ?? master.id;
    const event = graphToEvent(master, uid, zone, null);
    if (!event) return null;
    const exceptions = (master.exceptionOccurrences ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
    const overrides: types.CalendarEvent[] = [];
    for (const exception of exceptions) {
        if (!exception.originalStart) continue;
        const original = new Date(exception.originalStart);
        if (Number.isNaN(original.getTime())) continue;
        const recurrenceId: types.DateValue = bridge.isDate(event.start) ? { date: bridge.wallValue(original, zone).dateTime.slice(0, 10) } : bridge.wallValue(original, zone);
        const override = graphToEvent(exception, uid, zone, recurrenceId);
        if (override) overrides.push(override);
    }
    const exdates: types.DateValue[] = [];
    for (const occurrence of master.cancelledOccurrences ?? []) {
        const date = occurrenceDate(occurrence);
        if (!date) continue;
        if (bridge.isDate(event.start)) exdates.push({ date });
        else exdates.push({ dateTime: `${date}T${event.start.dateTime.slice(11)}`, tzid: event.start.tzid });
    }
    const full = exdates.length > 0 ? { ...event, exdates: [...event.exdates, ...exdates] } : event;
    const etag = [etagOf(master), ...exceptions.map(etagOf)].join(",");
    return { href: master.id, etag, ics: bridge.writeItem(bridge.eventItem(uid, full, overrides)) };
}

/**
 * A Graph `dateTimeTimeZone` for an engine value, written in `zone` (one Graph
 * accepts). An all-day value is midnight, as Graph requires of all-day events.
 */
function toGraphTime(value: types.DateValue, zone: string): { dateTime: string; timeZone: string } {
    if (bridge.isDate(value)) return { dateTime: `${value.date}T00:00:00`, timeZone: "UTC" };
    return { dateTime: bridge.wallValue(bridge.toInstant(value), zone).dateTime, timeZone: zone };
}

/** An engine event as the body of a create or a patch. */
export function eventToGraph(event: types.CalendarEvent, options: { instance: boolean; insert: boolean }): Record<string, unknown> {
    const zone = bridge.isDate(event.start) ? "UTC" : bridge.zoneOrUtc(event.start.tzid);
    const writeZone = GRAPH_IANA_ZONES.has(zone) ? zone : "UTC";
    const html = bridge.extraValue(event, "X-ALT-DESC");
    const showAsExtra = bridge.extraValue(event, "X-POLARIS-GRAPH-SHOWAS");
    const reminder = event.alarms.find((a) => a.trigger.kind === "relative" && a.trigger.related === "START" && a.trigger.minutes <= 0);
    const body: Record<string, unknown> = {
        subject: event.summary,
        body: html !== null ? { contentType: "html", content: unIcalText(html) } : { contentType: "text", content: event.description },
        location: { displayName: event.location },
        start: toGraphTime(event.start, writeZone),
        end: toGraphTime(event.end, writeZone),
        isAllDay: bridge.isDate(event.start),
        showAs: event.kind === "outOfOffice" ? "oof" : event.transparency === "TRANSPARENT" ? "free" : (showAsExtra ?? "busy"),
        sensitivity:
            event.classification === "CONFIDENTIAL"
                ? "confidential"
                : event.classification === "PRIVATE"
                  ? bridge.extraValue(event, "X-POLARIS-GRAPH-SENSITIVITY") === "personal"
                      ? "personal"
                      : "private"
                  : "normal",
        isReminderOn: Boolean(reminder),
        categories: [...event.categories],
        attendees: event.attendees.map((a) => ({
            emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
            type: a.type === "RESOURCE" || a.type === "ROOM" ? "resource" : a.role === "OPT-PARTICIPANT" ? "optional" : "required"
        }))
    };
    if (reminder && reminder.trigger.kind === "relative") body.reminderMinutesBeforeStart = -reminder.trigger.minutes;
    if (!options.instance) {
        if (event.rule) body.recurrence = ruleToPattern(event.rule, event.start, writeZone);
        else if (!options.insert) body.recurrence = null;
    }
    if (options.insert) body.transactionId = event.uid.slice(0, 255);
    return body;
}

/** A Microsoft 365 / Outlook.com account as a `CalendarProvider`. */
export function createGraphProvider(input: {
    accessToken: () => Promise<string>;
    fetcher: Fetcher;
    window?: { pastDays: number; futureDays: number };
}): CalendarProvider {
    const window = input.window ?? DEFAULT_WINDOW;

    /** Only Graph's own origin gets the bearer token, whatever a stored link says. */
    const graphUrl = (raw: string): string => {
        let url: URL;
        try {
            url = new URL(raw, `${GRAPH_API}/`);
        } catch {
            throw new SyncGoneError("The stored sync link is not valid", null);
        }
        if (url.origin !== GRAPH_ORIGIN) throw new SyncGoneError("The stored sync link does not point at Microsoft Graph", null);
        return url.href;
    };

    const call = async (method: string, url: string, options: { body?: unknown; ifMatch?: string; prefer?: boolean } = {}): Promise<Response> => {
        const headers: Record<string, string> = { Authorization: `Bearer ${await tokenFrom(input.accessToken)}`, Accept: "application/json" };
        if (options.prefer !== false) headers.Prefer = PREFER;
        if (options.body !== undefined) headers["Content-Type"] = "application/json";
        if (options.ifMatch) headers["If-Match"] = options.ifMatch;
        const { response } = await send(input.fetcher, graphUrl(url), {
            method,
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
        return response;
    };

    const json = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
        if (!response.ok) throw await graphError(response);
        const parsed = schema.safeParse(await readJson(response));
        if (!parsed.success) throw new SyncUnreachableError("Microsoft answered in an unexpected shape", response.status);
        return parsed.data;
    };

    const SERIES_SELECT = [
        "id", "changeKey", "type", "seriesMasterId", "iCalUId", "subject", "body", "location", "start", "end", "isAllDay", "isCancelled",
        "attendees", "organizer", "isReminderOn", "reminderMinutesBeforeStart", "showAs", "sensitivity", "onlineMeeting", "recurrence",
        "originalStart", "originalStartTimeZone", "categories", "webLink", "createdDateTime", "lastModifiedDateTime", "cancelledOccurrences", "exceptionOccurrences"
    ].join(",");

    /** A series master with its exceptions and cancelled occurrences, or null when it is gone. */
    const readSeries = async (id: string): Promise<GraphEventJson | null> => {
        const response = await call("GET", `${GRAPH_API}/me/events/${encodeURIComponent(id)}?$select=${SERIES_SELECT}&$expand=exceptionOccurrences`);
        if (response.status === 404) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        return json(response, GraphEvent);
    };

    /** The occurrence of a series that started at `original`, or null. */
    const findOccurrence = async (seriesId: string, original: types.DateValue, zone: string): Promise<z.infer<typeof GraphEventBase> | null> => {
        const instant = bridge.toInstant(original, zone);
        const from = new Date(instant.getTime() - 86_400_000).toISOString();
        const to = new Date(instant.getTime() + 2 * 86_400_000).toISOString();
        let url: string | undefined = `${GRAPH_API}/me/events/${encodeURIComponent(seriesId)}/instances?startDateTime=${from}&endDateTime=${to}`;
        const wantedDate = bridge.isDate(original) ? original.date : null;
        while (url) {
            const page: z.infer<typeof InstancesPage> = await json(await call("GET", url), InstancesPage);
            for (const occurrence of page.value) {
                if (!occurrence.originalStart) continue;
                const at = new Date(occurrence.originalStart);
                if (wantedDate ? bridge.wallValue(at, zone).dateTime.slice(0, 10) === wantedDate : at.getTime() === instant.getTime()) return occurrence;
            }
            url = page["@odata.nextLink"];
        }
        return null;
    };

    return {
        async listCalendars() {
            const calendars: RemoteCalendar[] = [];
            let url: string | undefined = `${GRAPH_API}/me/calendars?$top=100`;
            while (url) {
                const page: z.infer<typeof CalendarsPage> = await json(await call("GET", url, { prefer: false }), CalendarsPage);
                for (const calendar of page.value) {
                    calendars.push({
                        remoteId: calendar.id,
                        name: calendar.name ?? calendar.id,
                        color: /^#[0-9a-f]{6}$/i.test(calendar.hexColor ?? "") ? calendar.hexColor!.toLowerCase() : null,
                        description: "",
                        timezone: null,
                        readOnly: calendar.canEdit === false,
                        components: ["VEVENT"]
                    });
                }
                url = page["@odata.nextLink"];
            }
            return calendars;
        },

        async pull(state): Promise<ChangeSet> {
            const now = Date.now();
            const start = new Date(now - window.pastDays * 86_400_000).toISOString();
            const end = new Date(now + window.futureDays * 86_400_000).toISOString();
            let url: string | undefined = state.syncToken
                ? state.syncToken
                : `${GRAPH_API}/me/calendars/${encodeURIComponent(state.remoteId)}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
            const items: GraphEventJson[] = [];
            let deltaLink = "";
            for (let page = 0; url; page++) {
                if (page >= 10_000) throw new SyncUnreachableError("Microsoft kept paging without an end", null);
                const data: z.infer<typeof DeltaPage> = await json(await call("GET", url), DeltaPage);
                items.push(...data.value);
                if (data["@odata.deltaLink"]) deltaLink = graphUrl(data["@odata.deltaLink"]);
                url = data["@odata.nextLink"];
            }

            const changed: RemoteObject[] = [];
            const removed = new Set<string>();
            const series = new Set<string>();
            for (const item of items) {
                if (item["@removed"]) {
                    removed.add(item.id);
                    continue;
                }
                if (item.type === "occurrence" || item.type === "exception") {
                    if (item.seriesMasterId) series.add(item.seriesMasterId);
                    continue;
                }
                if (item.type === "seriesMaster") {
                    series.add(item.id);
                    continue;
                }
                if (item.isCancelled) {
                    removed.add(item.id);
                    continue;
                }
                const object = seriesToObject(item);
                if (object) changed.push(object);
            }
            for (const id of series) {
                const master = await readSeries(id);
                const object = master ? seriesToObject(master) : null;
                if (object && !master?.isCancelled) {
                    changed.push(object);
                    removed.delete(id);
                } else removed.add(id);
            }
            const full = !state.syncToken;
            const reported = full ? changed : changed.filter((object) => state.known.get(object.href) !== object.etag);
            return { changed: reported, removed: full ? [] : [...removed], syncToken: deltaLink || state.syncToken, ctag: "", full };
        },

        async put(target, object) {
            const item = bridge.readEventItem(object.ics, object.uid);
            const master = item.master;
            if (!master) throw new SyncRefusedError("An occurrence cannot be written without its series", null);
            const ifMatch = object.etag?.split(",")[0] || undefined;
            const response = object.href
                ? await call("PATCH", `${GRAPH_API}/me/events/${encodeURIComponent(object.href)}`, { body: eventToGraph(master, { instance: false, insert: false }), ifMatch })
                : await call("POST", `${GRAPH_API}/me/calendars/${encodeURIComponent(target.remoteId)}/events`, { body: eventToGraph(master, { instance: false, insert: true }) });
            const saved = await json(response, GraphEventBase);
            const href = saved.id;
            if (master.rule) {
                const zone = bridge.isDate(master.start) ? "UTC" : bridge.zoneOrUtc(master.start.tzid);
                for (const override of item.overrides) {
                    if (!override.recurrenceId) continue;
                    const occurrence = await findOccurrence(href, override.recurrenceId, zone);
                    if (!occurrence) throw new SyncRefusedError("A changed occurrence is not part of the series on Outlook", null);
                    await json(await call("PATCH", `${GRAPH_API}/me/events/${encodeURIComponent(occurrence.id)}`, { body: eventToGraph(override, { instance: true, insert: false }) }), GraphEventBase);
                }
                for (const exdate of master.exdates) {
                    const occurrence = await findOccurrence(href, exdate, zone);
                    if (!occurrence) continue;
                    const deleted = await call("DELETE", `${GRAPH_API}/me/events/${encodeURIComponent(occurrence.id)}`);
                    await deleted.body?.cancel().catch(() => undefined);
                    if (!deleted.ok && deleted.status !== 404) throw await graphError(deleted);
                }
            }
            const series = await readSeries(href);
            const written = series ? seriesToObject(series) : null;
            return { href, etag: written?.etag ?? etagOf(saved) };
        },

        async remove(_target, object) {
            const response = await call("DELETE", `${GRAPH_API}/me/events/${encodeURIComponent(object.href)}`, { ifMatch: object.etag?.split(",")[0] || undefined });
            if (response.ok || response.status === 404) {
                await response.body?.cancel().catch(() => undefined);
                return;
            }
            throw await graphError(response);
        }
    };
}
