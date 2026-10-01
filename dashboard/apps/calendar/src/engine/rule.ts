/**
 * Recurrence rules: the RRULE text, the editor's model of it, and the sentence
 * that describes it.
 *
 * The editor is Nextcloud's: repeat every N days, weeks on chosen weekdays,
 * months on chosen days or "on the [first..fifth, second-to-last, last]
 * [weekday / day / weekday / weekend day]", years in chosen months. A rule it
 * cannot show faithfully is marked `supported: false`, drawn as its summary and
 * kept as written until the person replaces it.
 */

import ICAL from "ical.js";
import type { DateValue, Frequency, RecurrenceRule, WallTime, Weekday } from "./types";
import { formatWall, parseWall, resolveZone, wallToInstant, instantToWall } from "./tz";

const FREQUENCIES: readonly Frequency[] = [
    "SECONDLY",
    "MINUTELY",
    "HOURLY",
    "DAILY",
    "WEEKLY",
    "MONTHLY",
    "YEARLY"
];

/** Weekdays in the order the editor and RRULE text list them. */
export const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

const WORKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR"];
const WEEKEND: readonly Weekday[] = ["SA", "SU"];

/** Parts the model has a field for; any other (BYWEEKNO, BYHOUR, RSCALE,
 *  SKIP, X-...) makes a rule unsupported and is written back as it came. */
const MODELED_PARTS = [
    "FREQ",
    "INTERVAL",
    "BYDAY",
    "BYMONTHDAY",
    "BYMONTH",
    "BYSETPOS",
    "COUNT",
    "UNTIL",
    "WKST"
];

/** Ordinals the editor offers, as BYSETPOS / BYDAY prefixes. */
export type RuleOrdinal = 1 | 2 | 3 | 4 | 5 | -1 | -2;

const ORDINALS: readonly number[] = [1, 2, 3, 4, 5, -1, -2];

/** What the recurrence editor edits. */
export interface RuleEditorModel {
    readonly frequency: "NONE" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
    readonly interval: number;
    readonly weekdays: readonly Weekday[];
    readonly monthlyMode: "day" | "ordinal";
    readonly monthDays: readonly number[];
    readonly ordinal: RuleOrdinal;
    readonly ordinalDay: Weekday | "day" | "weekday" | "weekend";
    readonly months: readonly number[];
    readonly end:
        | { readonly kind: "never" }
        | { readonly kind: "until"; readonly date: string }
        | { readonly kind: "count"; readonly count: number };
}

function isWeekday(value: string): value is Weekday {
    return (WEEKDAYS as readonly string[]).includes(value);
}

function numbers(value: string | undefined): number[] {
    if (!value) return [];
    return value
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((part) => Number.isInteger(part));
}

/** An UNTIL value as written: `20261231`, `20261231T235959Z` or floating. */
function parseUntil(text: string): DateValue {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(text.trim());
    if (!match) throw new Error(`Invalid UNTIL: ${text}`);
    const [, y, m, d, hh, mm, ss, z] = match;
    if (hh === undefined) return { date: `${y}-${m}-${d}` };
    return { dateTime: `${y}-${m}-${d}T${hh}:${mm}:${ss}`, tzid: z ? "UTC" : null };
}

/** An UNTIL value written back as RRULE text. */
export function formatUntil(value: DateValue): string {
    if ("date" in value) return value.date.replace(/-/g, "");
    return value.dateTime.replace(/[-:]/g, "") + (value.tzid === "UTC" ? "Z" : "");
}

/**
 * Read the text after `RRULE:`.
 *
 * Throws when FREQ is missing or unknown - there is no rule to keep then; the
 * iCalendar reader keeps such a line verbatim instead. Anything else the editor
 * cannot show only clears `supported`.
 */
export function parseRule(raw: string): RecurrenceRule {
    const text = raw.trim().replace(/^RRULE:/i, "");
    const parts = new Map<string, string>();
    for (const piece of text.split(";")) {
        if (!piece.trim()) continue;
        const cut = piece.indexOf("=");
        if (cut < 0) throw new Error(`Invalid RRULE part: ${piece}`);
        parts.set(piece.slice(0, cut).trim().toUpperCase(), piece.slice(cut + 1).trim());
    }
    const frequency = parts.get("FREQ")?.toUpperCase() as Frequency | undefined;
    if (!frequency || !FREQUENCIES.includes(frequency))
        throw new Error(`Invalid RRULE frequency: ${text}`);
    const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
    if (!Number.isInteger(interval) || interval < 1)
        throw new Error(`Invalid RRULE interval: ${text}`);
    const byDay = (parts.get("BYDAY") ?? "")
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean)
        .map((part) => {
            const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(part);
            if (!match) throw new Error(`Invalid BYDAY: ${part}`);
            return { day: match[2] as Weekday, ordinal: match[1] ? Number(match[1]) : null };
        });
    const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
    if (count !== null && (!Number.isInteger(count) || count < 1))
        throw new Error(`Invalid RRULE count: ${text}`);
    const until = parts.has("UNTIL") ? parseUntil(parts.get("UNTIL") ?? "") : null;
    const wkst = parts.get("WKST")?.toUpperCase() ?? null;
    const rule: Omit<RecurrenceRule, "supported"> = {
        frequency,
        interval,
        byDay,
        byMonthDay: numbers(parts.get("BYMONTHDAY")),
        byMonth: numbers(parts.get("BYMONTH")),
        bySetPos: numbers(parts.get("BYSETPOS")),
        count,
        until,
        weekStart: wkst && isWeekday(wkst) ? wkst : null,
        raw: text
    };
    return { ...rule, supported: editable(rule, [...parts.keys()]) };
}

/** Whether the editor can show a rule exactly as it is. */
function editable(rule: Omit<RecurrenceRule, "supported">, parts: readonly string[]): boolean {
    if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.frequency)) return false;
    if (parts.some((part) => !MODELED_PARTS.includes(part))) return false;
    if (rule.count !== null && rule.until !== null) return false;
    const plainDays = rule.byDay.every((entry) => entry.ordinal === null);
    switch (rule.frequency) {
        case "DAILY":
            return (
                rule.byDay.length === 0 &&
                rule.byMonthDay.length === 0 &&
                rule.byMonth.length === 0 &&
                rule.bySetPos.length === 0
            );
        case "WEEKLY":
            return (
                plainDays &&
                rule.byMonthDay.length === 0 &&
                rule.byMonth.length === 0 &&
                rule.bySetPos.length === 0
            );
        case "MONTHLY":
            if (rule.byMonth.length > 0) return false;
            if (rule.byMonthDay.length > 0)
                return (
                    rule.byDay.length === 0 &&
                    rule.bySetPos.length === 0 &&
                    rule.byMonthDay.every((day) => day >= 1 && day <= 31)
                );
            return rule.byDay.length === 0 || ordinalOf(rule) !== null;
        case "YEARLY":
            if (rule.byMonthDay.length > 0) return false;
            return rule.byDay.length === 0 || ordinalOf(rule) !== null;
        default:
            return false;
    }
}

/** The "on the Nth ..." reading of a rule's BYDAY/BYSETPOS, or null. */
function ordinalOf(
    rule: Pick<RecurrenceRule, "byDay" | "bySetPos">
): { ordinal: RuleOrdinal; day: RuleEditorModel["ordinalDay"] } | null {
    const days = rule.byDay;
    if (days.length === 1 && rule.bySetPos.length === 0) {
        const [only] = days;
        if (only?.ordinal != null && ORDINALS.includes(only.ordinal))
            return { ordinal: only.ordinal as RuleOrdinal, day: only.day };
        return null;
    }
    if (rule.bySetPos.length !== 1 || days.some((entry) => entry.ordinal !== null)) return null;
    const position = rule.bySetPos[0] ?? 0;
    if (!ORDINALS.includes(position)) return null;
    const set = new Set(days.map((entry) => entry.day));
    const same = (group: readonly Weekday[]) =>
        set.size === group.length && group.every((day) => set.has(day));
    if (same(WEEKDAYS)) return { ordinal: position as RuleOrdinal, day: "day" };
    if (same(WORKDAYS)) return { ordinal: position as RuleOrdinal, day: "weekday" };
    if (same(WEEKEND)) return { ordinal: position as RuleOrdinal, day: "weekend" };
    const [only] = days;
    if (days.length === 1 && only) return { ordinal: position as RuleOrdinal, day: only.day };
    return null;
}

/** The most days each month can have. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The BY parts ical.js 2.2.1 tests each candidate against instead of
 *  generating from (its `_expandMap` CONTRACT entries), per frequency. */
const CONTRACTING: Readonly<Record<Frequency, readonly string[]>> = {
    SECONDLY: ["BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYWEEKNO", "BYMONTH"],
    MINUTELY: ["BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYWEEKNO", "BYMONTH"],
    HOURLY: ["BYHOUR", "BYDAY", "BYMONTHDAY", "BYWEEKNO", "BYMONTH"],
    DAILY: ["BYDAY", "BYMONTHDAY", "BYWEEKNO", "BYMONTH"],
    WEEKLY: ["BYWEEKNO", "BYMONTH"],
    MONTHLY: ["BYMONTH"],
    YEARLY: []
};

/** The seconds one step of a frequency moves when no BY part of its own sets
 *  that field instead. */
const UNIT_SECONDS: Partial<Record<Frequency, number>> = {
    SECONDLY: 1,
    MINUTELY: 60,
    HOURLY: 3600,
    DAILY: 86_400
};

/** The BY part that, present, sets the field a frequency steps. */
const OWN_PART: Partial<Record<Frequency, string>> = {
    SECONDLY: "BYSECOND",
    MINUTELY: "BYMINUTE",
    HOURLY: "BYHOUR"
};

const WEEK_SECONDS = 604_800;

function gcd(a: number, b: number): number {
    return b === 0 ? a : gcd(b, a % b);
}

/**
 * Whether a rule can never produce an occurrence after DTSTART, read the way
 * ical.js 2.2.1 iterates it.
 *
 * For SECONDLY to WEEKLY ical.js steps candidate times and tests them against
 * the contracting BY parts with no bound, so a rule none of whose candidates
 * can pass - `FREQ=DAILY;BYDAY=1MO` (an ordinal never equals a weekday),
 * `FREQ=DAILY;BYMONTHDAY=-1` (a negative never equals a day),
 * `FREQ=DAILY;INTERVAL=7;BYDAY=TU` from a Monday - would never return. Also
 * true when BYMONTH and BYMONTHDAY name no day that exists. Only rules that
 * certainly yield nothing are reported; the iterator's own step guard bounds
 * the rest.
 */
export function neverRecurs(rule: RecurrenceRule, start: WallTime): boolean {
    const parts = new Map<string, number[]>();
    for (const piece of rule.raw.split(";")) {
        const cut = piece.indexOf("=");
        if (cut > 0)
            parts.set(piece.slice(0, cut).trim().toUpperCase(), numbers(piece.slice(cut + 1)));
    }
    const months = rule.byMonth.length > 0 ? rule.byMonth : MONTH_DAYS.map((_, index) => index + 1);
    const realDays = rule.byMonthDay.filter((day) =>
        months.some((month) => Math.abs(day) <= (MONTH_DAYS[month - 1] ?? 0))
    );
    if (rule.byMonthDay.length > 0 && realDays.length === 0) return true;
    const contracting = new Set(CONTRACTING[rule.frequency].filter((name) => parts.has(name)));
    const plainDays = rule.byDay
        .filter((entry) => entry.ordinal === null)
        .map((entry) => WEEKDAYS.indexOf(entry.day));
    if (contracting.has("BYDAY") && plainDays.length === 0) return true;
    const monthDays = realDays.filter((day) => day > 0);
    if (contracting.has("BYMONTHDAY") && monthDays.length === 0) return true;
    const weeks = (parts.get("BYWEEKNO") ?? []).filter((week) => week >= 1 && week <= 53);
    if (contracting.has("BYWEEKNO") && weeks.length === 0) return true;
    const allowed = (name: string, value: number) =>
        !contracting.has(name) || (parts.get(name) ?? []).includes(value);
    if (
        contracting.has("BYSECOND") &&
        !(parts.get("BYSECOND") ?? []).some((second) => second >= 0 && second <= 59)
    )
        return true;
    const unit = UNIT_SECONDS[rule.frequency];
    const own = OWN_PART[rule.frequency];
    // With no BY part setting the stepped field and no BYMONTH (whose months
    // ical.js jumps between), candidates sit on a fixed lattice of
    // `unit * interval` seconds from DTSTART; within a week that lattice is
    // `gcd(step, week)` apart, and every weekday and time of day it reaches
    // recurs every week.
    if (unit !== undefined && (own === undefined || !parts.has(own)) && !parts.has("BYMONTH")) {
        const step = unit * rule.interval;
        const weekday =
            (new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay() + 6) % 7;
        const origin =
            Math.floor(
                (weekday * 86_400 + start.hour * 3600 + start.minute * 60 + start.second) / unit
            ) * unit;
        const spacing = gcd(step, WEEK_SECONDS);
        const timed = ["BYDAY", "BYHOUR", "BYMINUTE"].some((name) => contracting.has(name));
        let reached = !timed;
        for (let offset = 0; !reached && offset < WEEK_SECONDS; offset += spacing) {
            const at = (origin + offset) % WEEK_SECONDS;
            const day = Math.floor(at / 86_400);
            const seconds = at % 86_400;
            reached =
                (!contracting.has("BYDAY") || plainDays.includes(day)) &&
                allowed("BYHOUR", Math.floor(seconds / 3600)) &&
                allowed("BYMINUTE", Math.floor(seconds / 60) % 60);
        }
        if (!reached) return true;
    }
    // A week number pins a candidate to a few days of the year: whether any
    // real date also has the month, day and weekday asked for. 2001-2028 holds
    // every kind of year, and every pair of consecutive ones.
    if (
        contracting.has("BYWEEKNO") &&
        ["BYMONTH", "BYMONTHDAY", "BYDAY"].some((name) => contracting.has(name))
    ) {
        const weekStart = ICAL.Recur.icalDayToNumericDay(rule.weekStart ?? "MO") as Parameters<
            ICAL.Time["weekNumber"]
        >[0];
        const day = ICAL.Time.fromData({ year: 2001, month: 1, day: 1, isDate: true });
        let found = false;
        for (; !found && day.year < 2029; day.adjust(1, 0, 0, 0)) {
            found =
                (!contracting.has("BYMONTH") || rule.byMonth.includes(day.month)) &&
                (!contracting.has("BYMONTHDAY") || monthDays.includes(day.day)) &&
                (!contracting.has("BYDAY") || plainDays.includes((day.dayOfWeek() + 5) % 7)) &&
                weeks.includes(day.weekNumber(weekStart));
        }
        if (!found) return true;
    }
    return false;
}

/** Write a rule back as the text after `RRULE:`, in the conventional order. */
export function formatRule(rule: RecurrenceRule): string {
    const parts: string[] = [`FREQ=${rule.frequency}`];
    if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
    if (rule.byDay.length > 0)
        parts.push(
            `BYDAY=${rule.byDay.map((entry) => `${entry.ordinal ?? ""}${entry.day}`).join(",")}`
        );
    if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
    if (rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
    if (rule.bySetPos.length > 0) parts.push(`BYSETPOS=${rule.bySetPos.join(",")}`);
    if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
    if (rule.until !== null) parts.push(`UNTIL=${formatUntil(rule.until)}`);
    if (rule.weekStart !== null) parts.push(`WKST=${rule.weekStart}`);
    // Parts this model does not carry (BYHOUR, RSCALE, X-...) survive from
    // the text the rule was read from.
    for (const piece of rule.raw.split(";")) {
        const name = piece.split("=")[0]?.trim().toUpperCase() ?? "";
        if (name && !MODELED_PARTS.includes(name)) parts.push(piece.trim());
    }
    return parts.join(";");
}

/** A rule with some fields replaced and its `raw` rewritten to match. */
export function withRule(
    rule: RecurrenceRule,
    change: Partial<Omit<RecurrenceRule, "raw" | "supported">>
): RecurrenceRule {
    const next = { ...rule, ...change };
    return parseRule(formatRule({ ...next, raw: rule.raw }));
}

function startWall(start: DateValue) {
    return parseWall("date" in start ? start.date : start.dateTime);
}

/** The RRULE weekday of a date value's own calendar date. */
export function weekdayOf(start: DateValue): Weekday {
    const wall = startWall(start);
    const index = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
    return WEEKDAYS[(index + 6) % 7] ?? "MO";
}

/** Which "Nth weekday of the month" a date is: 1..5. */
function nthOfMonth(start: DateValue): RuleOrdinal {
    return Math.min(5, Math.ceil(startWall(start).day / 7)) as RuleOrdinal;
}

/**
 * The editor's reading of a rule. `null` (no repetition) gives frequency NONE
 * with the choices pre-filled from the start, so switching to "weekly" already
 * has the start's weekday ticked. A rule the editor cannot show is read as far
 * as it goes; screens check `rule.supported` before offering to edit it.
 */
export function editorFromRule(rule: RecurrenceRule | null, start: DateValue): RuleEditorModel {
    const wall = startWall(start);
    const base: RuleEditorModel = {
        frequency: "NONE",
        interval: 1,
        weekdays: [weekdayOf(start)],
        monthlyMode: "day",
        monthDays: [wall.day],
        ordinal: nthOfMonth(start),
        ordinalDay: weekdayOf(start),
        months: [wall.month],
        end: { kind: "never" }
    };
    if (!rule) return base;
    const frequency =
        rule.frequency === "DAILY" ||
        rule.frequency === "WEEKLY" ||
        rule.frequency === "MONTHLY" ||
        rule.frequency === "YEARLY"
            ? rule.frequency
            : "NONE";
    const ordinal = ordinalOf(rule);
    const plainDays = rule.byDay
        .filter((entry) => entry.ordinal === null)
        .map((entry) => entry.day);
    return {
        ...base,
        frequency,
        interval: rule.interval,
        weekdays:
            frequency === "WEEKLY" && plainDays.length > 0
                ? WEEKDAYS.filter((day) => plainDays.includes(day))
                : base.weekdays,
        monthlyMode: ordinal ? "ordinal" : "day",
        monthDays:
            rule.byMonthDay.length > 0
                ? [...rule.byMonthDay].sort((a, b) => a - b)
                : base.monthDays,
        ordinal: ordinal?.ordinal ?? base.ordinal,
        ordinalDay: ordinal?.day ?? base.ordinalDay,
        months: rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : base.months,
        end:
            rule.count !== null
                ? { kind: "count", count: rule.count }
                : rule.until
                  ? { kind: "until", date: untilDate(rule.until, start) }
                  : { kind: "never" }
    };
}

/** The last day an UNTIL allows, read in the start's own zone. */
function untilDate(until: DateValue, start: DateValue): string {
    if ("date" in until) return until.date;
    if (until.tzid !== "UTC" || "date" in start) return until.dateTime.slice(0, 10);
    const zone = resolveZone(start.tzid) ?? "UTC";
    return formatWall(instantToWall(new Date(`${until.dateTime}Z`), zone)).slice(0, 10);
}

/**
 * The rule the editor's choices make, or null for "does not repeat".
 *
 * UNTIL follows RFC 5545: a date for an all-day start, the last second of the
 * chosen day in UTC for a start with a zone, floating for a floating start. A
 * start in a zone `Intl` does not know is taken as UTC for that one second.
 */
export function ruleFromEditor(model: RuleEditorModel, start: DateValue): RecurrenceRule | null {
    if (model.frequency === "NONE") return null;
    const parts: string[] = [`FREQ=${model.frequency}`];
    if (model.interval > 1) parts.push(`INTERVAL=${Math.floor(model.interval)}`);
    const wall = startWall(start);
    if (model.frequency === "WEEKLY") {
        const days =
            model.weekdays.length > 0
                ? WEEKDAYS.filter((day) => model.weekdays.includes(day))
                : [weekdayOf(start)];
        parts.push(`BYDAY=${days.join(",")}`);
    }
    if (model.frequency === "MONTHLY" || model.frequency === "YEARLY") {
        if (model.frequency === "YEARLY") {
            const months =
                model.months.length > 0
                    ? [...new Set(model.months)].sort((a, b) => a - b)
                    : [wall.month];
            parts.push(`BYMONTH=${months.join(",")}`);
        }
        if (model.monthlyMode === "ordinal")
            parts.push(...ordinalParts(model.ordinal, model.ordinalDay));
        else if (model.frequency === "MONTHLY") {
            const days =
                model.monthDays.length > 0
                    ? [...new Set(model.monthDays)].sort((a, b) => a - b)
                    : [wall.day];
            parts.push(`BYMONTHDAY=${days.join(",")}`);
        }
    }
    if (model.end.kind === "count") parts.push(`COUNT=${Math.max(1, Math.floor(model.end.count))}`);
    if (model.end.kind === "until")
        parts.push(`UNTIL=${formatUntil(untilFor(model.end.date, start))}`);
    return parseRule(parts.join(";"));
}

function ordinalParts(ordinal: RuleOrdinal, day: RuleEditorModel["ordinalDay"]): string[] {
    if (day === "day") return [`BYDAY=${WEEKDAYS.join(",")}`, `BYSETPOS=${ordinal}`];
    if (day === "weekday") return [`BYDAY=${WORKDAYS.join(",")}`, `BYSETPOS=${ordinal}`];
    if (day === "weekend") return [`BYDAY=${WEEKEND.join(",")}`, `BYSETPOS=${ordinal}`];
    // `BYDAY=2MO` rather than BYSETPOS: the form Google and Outlook both accept.
    return [`BYDAY=${ordinal}${day}`];
}

function untilFor(date: string, start: DateValue): DateValue {
    if ("date" in start) return { date };
    const last = `${date}T23:59:59`;
    if (start.tzid === null) return { dateTime: last, tzid: null };
    const zone = resolveZone(start.tzid) ?? "UTC";
    const instant = wallToInstant(parseWall(last), zone);
    return { dateTime: instant.toISOString().slice(0, 19), tzid: "UTC" };
}

/** A translator scoped to the `rule` namespace (`messages/<locale>/rule.json`). */
export type RuleTranslator = (key: string, values?: Record<string, unknown>) => string;

function weekdayName(day: Weekday, locale: string): string {
    // 2024-01-01 was a Monday.
    const date = new Date(Date.UTC(2024, 0, 1 + WEEKDAYS.indexOf(day)));
    return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(date);
}

function monthName(month: number, locale: string): string {
    return new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(
        new Date(Date.UTC(2024, month - 1, 1))
    );
}

function list(items: readonly string[], locale: string): string {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
}

function ordinalWord(position: number, t: RuleTranslator): string {
    if (position === -1) return t("ordinal.last");
    if (position === -2) return t("ordinal.secondLast");
    if (position >= 1 && position <= 5) return t(`ordinal.n${position}`);
    return t("ordinal.other", { n: position });
}

/**
 * The rule as one sentence: "Every 2 weeks on Monday and Wednesday, 10 times",
 * "Cada 2 semanas el lunes y el miércoles, 10 veces".
 *
 * Weekday and month names come from `Intl` in the reader's language; the
 * connecting words from `rule.json`. A rule the editor cannot show is described
 * as far as its parts have words, which covers everything but BYWEEKNO,
 * BYYEARDAY and the time-of-day parts.
 */
export function summarizeRule(rule: RecurrenceRule, t: RuleTranslator, locale: string): string {
    let text = t(`every.${rule.frequency.toLowerCase()}`, { interval: rule.interval });
    const ordinal = ordinalOf(rule);
    const plainDays = WEEKDAYS.filter((day) =>
        rule.byDay.some((entry) => entry.day === day && entry.ordinal === null)
    );
    if (rule.byMonth.length > 0) {
        const months = [...rule.byMonth]
            .sort((a, b) => a - b)
            .map((month) => monthName(month, locale));
        text = t("pattern.months", { base: text, months: list(months, locale) });
    }
    if (ordinal) {
        const kind =
            ordinal.day === "day" || ordinal.day === "weekday" || ordinal.day === "weekend"
                ? ordinal.day
                : null;
        if (kind)
            text = t("pattern.ordinalKind", {
                base: text,
                ordinal: ordinalWord(ordinal.ordinal, t),
                kind
            });
        else
            text = t("pattern.ordinal", {
                base: text,
                ordinal: ordinalWord(ordinal.ordinal, t),
                day: weekdayName(ordinal.day as Weekday, locale)
            });
    } else {
        const ordinalDays = rule.byDay.filter((entry) => entry.ordinal !== null);
        const dayItems = [
            ...ordinalDays.map((entry) =>
                t("pattern.ordinalItem", {
                    ordinal: ordinalWord(entry.ordinal ?? 1, t),
                    day: weekdayName(entry.day, locale)
                })
            ),
            ...plainDays.map((day) => t("pattern.dayItem", { day: weekdayName(day, locale) }))
        ];
        if (rule.byMonthDay.length > 0) {
            const days = [...rule.byMonthDay]
                .sort((a, b) => a - b)
                .map((day) => (day < 0 ? t("pattern.fromEnd", { n: -day }) : String(day)));
            text = t("pattern.monthDays", { base: text, days: list(days, locale) });
        }
        if (dayItems.length > 0)
            text = t("pattern.days", { base: text, days: list(dayItems, locale) });
        if (rule.bySetPos.length > 0)
            text = t("pattern.setPos", {
                base: text,
                positions: list(
                    rule.bySetPos.map((position) => ordinalWord(position, t)),
                    locale
                )
            });
    }
    if (rule.count !== null) text = t("pattern.count", { base: text, count: rule.count });
    if (rule.until !== null) {
        const date = "date" in rule.until ? rule.until.date : rule.until.dateTime.slice(0, 10);
        const [y, m, d] = date.split("-").map(Number);
        const formatted = new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeZone: "UTC"
        }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
        text = t("pattern.until", { base: text, date: formatted });
    }
    return text;
}
