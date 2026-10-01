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

interface Transition {
    /** The instant the offset changes. */
    readonly at: Date;
    readonly from: number;
    readonly to: number;
}

/** The offset changes of one zone during one year, in order. */
export function transitionsIn(zone: string, year: number): Transition[] {
    const found: Transition[] = [];
    let previous = zoneOffsetMinutes(new Date(Date.UTC(year, 0, 1)), zone);
    for (let day = 1; day <= 366; day += 1) {
        const at = new Date(Date.UTC(year, 0, 1) + day * DAY);
        if (at.getUTCFullYear() > year) break;
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

/** One observance: the wall time it starts at (before the change), as a rule. */
function observance(transition: Transition, kind: "STANDARD" | "DAYLIGHT", zoneName: string): string[] {
    // The wall clock as it read just before the switch: what DTSTART is in.
    const local = instantToWall(new Date(transition.at.getTime() + transition.from * 60_000), "UTC");
    const month = local.month;
    const day = local.day;
    const weekday = new Date(Date.UTC(local.year, month - 1, day)).getUTCDay();
    const days = new Date(Date.UTC(local.year, month, 0)).getUTCDate();
    const ordinal = day + 7 > days ? -1 : Math.ceil(day / 7);
    const startDay = nthWeekday(1970, month, weekday, ordinal);
    return [
        `BEGIN:${kind}`,
        `DTSTART:1970${pad(month)}${pad(startDay)}T${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${ordinal}${WEEKDAYS[weekday]}`,
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
        lines.push(...observance(standard, "STANDARD", zone), ...observance(daylight, "DAYLIGHT", zone));
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
