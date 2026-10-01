/**
 * A VTIMEZONE block for an IANA zone, written from what `Intl` knows.
 *
 * RFC 5545 (3.6.5, 3.2.19) wants every TZID a file uses to be defined in it.
 * Google and Apple read an IANA name without one; Outlook and stricter CalDAV
 * servers do not. Polaris ships no time-zone database, so the definition is
 * worked out the way vzic does it: find the year's transitions, and describe
 * each as a yearly rule ("the last Sunday of March at 02:00"). A zone with no
 * daylight saving gets one fixed STANDARD observance.
 *
 * The rule is the current one. Dates before a zone last changed its rules are
 * read with today's rule by a client that has no database of its own - the
 * same compromise every generated VTIMEZONE makes.
 *
 * Pure.
 */

import { instantToWall, resolveZone, zoneOffsetMinutes } from "./tz";

const DAY = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** Years a change is looked up in to tell its rule: enough for its date to
 *  fall on every day of the week. */
const RULE_YEARS = 12;

interface Transition {
    /** The instant the offset changes. */
    readonly at: Date;
    readonly from: number;
    readonly to: number;
}

/** The offset changes of one zone during one year, in order. */
export function transitionsIn(zone: string, year: number): Transition[] {
    return transitionsBetween(zone, Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1));
}

/** The offset changes of one zone from one instant to another, to the day. */
function transitionsBetween(zone: string, from: number, to: number): Transition[] {
    const found: Transition[] = [];
    let previous = zoneOffsetMinutes(new Date(from), zone);
    for (let time = from + DAY; time < to; time += DAY) {
        const at = new Date(time);
        const offset = zoneOffsetMinutes(at, zone);
        if (offset === previous) continue;
        // The change is inside the last day: narrow it to the minute.
        let low = at.getTime() - DAY;
        let high = at.getTime();
        while (high - low > 60_000) {
            const middle = low + Math.floor((high - low) / 120_000) * 60_000;
            if (zoneOffsetMinutes(new Date(middle), zone) === previous) low = middle;
            else high = middle;
        }
        found.push({ at: new Date(high), from: previous, to: offset });
        previous = offset;
    }
    return found;
}

/** `+0130`, `-0500`. */
function offsetText(minutes: number): string {
    const sign = minutes < 0 ? "-" : "+";
    const whole = Math.abs(minutes);
    return `${sign}${String(Math.floor(whole / 60)).padStart(2, "0")}${String(whole % 60).padStart(2, "0")}`;
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** The day of `month` (1-12) in `year` that is the `ordinal`th `weekday` (0 =
 *  Sunday); -1 is the last one. */
function nthWeekday(year: number, month: number, weekday: number, ordinal: number): number {
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (ordinal === -1) {
        const lastDay = new Date(Date.UTC(year, month - 1, days)).getUTCDay();
        return days - ((lastDay - weekday + 7) % 7);
    }
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (ordinal - 1) * 7;
}

/** The wall clock as it read just before a change: what DTSTART is in. */
function wallBefore(transition: Transition) {
    return instantToWall(new Date(transition.at.getTime() + transition.from * 60_000), "UTC");
}

const weekdayOf = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * How a change recurs, told from the days of the month it fell on in the years
 * from `year` on: the last or the nth of a weekday, the first of a weekday on
 * or after a day (Israel's "Friday before the last Sunday" is Fri>=23), or a
 * fixed date. With nothing to tell them apart, the year's own day decides.
 */
function yearlyRule(zone: string, transition: Transition, year: number): { rule: string; startDay: number } {
    const local = wallBefore(transition);
    const { month, day } = local;
    const weekday = weekdayOf(local.year, month, day);
    const seen = [{ year: local.year, day }];
    for (let next = year + 1; next < year + RULE_YEARS; next++) {
        const match = transitionsBetween(zone, Date.UTC(next, month - 1, 1) - 2 * DAY, Date.UTC(next, month, 1) + 2 * DAY)
            .filter((change) => change.from === transition.from && change.to === transition.to)
            .map(wallBefore)
            .find((wall) => wall.month === month);
        if (match) seen.push({ year: match.year, day: match.day });
    }
    const sameWeekday = seen.every((entry) => weekdayOf(entry.year, month, entry.day) === weekday);
    if (!sameWeekday && seen.every((entry) => entry.day === day)) return { rule: `BYMONTH=${month};BYMONTHDAY=${day}`, startDay: day };
    const ordinal = (entry: { year: number; day: number }) => (entry.day + 7 > daysIn(entry.year, month) ? -1 : Math.ceil(entry.day / 7));
    const ordinals = new Set(sameWeekday ? seen.map(ordinal) : [ordinal(seen[0]!)]);
    const last = sameWeekday && seen.every((entry) => entry.day + 7 > daysIn(entry.year, month));
    if (last || ordinals.size === 1) {
        const which = last ? -1 : [...ordinals][0]!;
        return { rule: `BYMONTH=${month};BYDAY=${which}${WEEKDAYS[weekday]}`, startDay: nthWeekday(1970, month, weekday, which) };
    }
    const first = Math.min(...seen.map((entry) => entry.day));
    const days = Array.from({ length: 7 }, (_, index) => first + index);
    return {
        rule: `BYMONTH=${month};BYDAY=${WEEKDAYS[weekday]};BYMONTHDAY=${days.join(",")}`,
        startDay: first + ((weekday - weekdayOf(1970, month, first) + 7) % 7)
    };
}

/** One observance: the wall time it starts at (before the change), as a rule. */
function observance(transition: Transition, kind: "STANDARD" | "DAYLIGHT", zoneName: string, year: number): string[] {
    const local = wallBefore(transition);
    const { rule, startDay } = yearlyRule(zoneName, transition, year);
    return [
        `BEGIN:${kind}`,
        `DTSTART:1970${pad(local.month)}${pad(startDay)}T${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`,
        `RRULE:FREQ=YEARLY;${rule}`,
        `TZOFFSETFROM:${offsetText(transition.from)}`,
        `TZOFFSETTO:${offsetText(transition.to)}`,
        `TZNAME:${zoneName}`,
        `END:${kind}`
    ];
}

/**
 * The VTIMEZONE text for a zone, or null when the zone is not one `Intl`
 * knows (a file's own VTIMEZONE is kept for those). `year` is the year whose
 * rules are described - the year of the events, normally.
 */
export function vtimezoneFor(tzid: string, year: number): string | null {
    const zone = resolveZone(tzid);
    if (!zone || zone === "UTC") return null;
    const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
    const changes = transitionsIn(zone, year);
    if (changes.length === 2) {
        const [first, second] = changes as [Transition, Transition];
        const daylight = first.to > second.to ? first : second;
        const standard = daylight === first ? second : first;
        lines.push(...observance(standard, "STANDARD", zone, year), ...observance(daylight, "DAYLIGHT", zone, year));
    } else {
        // No daylight saving this year (or an irregular one): the offset the
        // year ends on, held.
        const offset = zoneOffsetMinutes(new Date(Date.UTC(year, 11, 31)), zone);
        lines.push(
            "BEGIN:STANDARD",
            "DTSTART:19700101T000000",
            `TZOFFSETFROM:${offsetText(offset)}`,
            `TZOFFSETTO:${offsetText(offset)}`,
            `TZNAME:${zone}`,
            "END:STANDARD"
        );
    }
    lines.push("END:VTIMEZONE");
    return lines.join("\r\n");
}
