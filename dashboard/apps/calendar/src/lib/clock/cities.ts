/**
 * The world clock's cities: every IANA zone the runtime knows, found by the
 * city in its name, its country in the reader's language, the tz database's
 * note for it, its zone's name ("Central European Time", "hora de Europa
 * central"), its abbreviation or its offset - and how a city's time compares
 * with the reader's own.
 *
 * Pure: the browser draws with it, a test reads it.
 */

import * as core from "@polaris/core";
import { ZONE_COUNTRIES, ZONE_LINKS } from "../../engine/zone-countries";
import { addDays, instantToWall, listZones, parseWall, wallToInstant, zoneOffsetMinutes } from "../../engine";

export interface CityOption {
    readonly zone: string;
    /** "New York", "Ho Chi Minh". */
    readonly city: string;
    /** "United States", "Estados Unidos"; empty for a zone of no country (UTC). */
    readonly country: string;
    /** The tz database's note ("Spain (mainland)"), when it has one. */
    readonly note: string;
    /** "Eastern Time", in the reader's language. */
    readonly zoneName: string;
    /** "EST", or "GMT-5" where the zone has no abbreviation in that language. */
    readonly abbreviation: string;
    /** "GMT-05:00" at the moment the list was made. */
    readonly offset: string;
}

function lastSegment(zone: string): string {
    return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/** The city a zone is named after: its last segment, spaced - by its current
 *  name when the runtime still lists an older one ("Kolkata" for
 *  `Asia/Calcutta`). */
export function cityOf(zone: string): string {
    if (zone === "UTC") return "UTC";
    return lastSegment(ZONE_LINKS[zone] ?? zone);
}

function zonePart(zone: string, at: Date, locale: string, style: Intl.DateTimeFormatOptions["timeZoneName"]): string {
    try {
        return (
            new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style })
                .formatToParts(at)
                .find((part) => part.type === "timeZoneName")?.value ?? ""
        );
    } catch {
        return "";
    }
}

/** "+02:00", "-03:30", "+00:00". */
export function offsetText(minutes: number): string {
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

let cached: { key: string; options: CityOption[] } | null = null;

/**
 * Every zone as a city. Kept for the hour and the language it was made in: the
 * offsets and abbreviations change only at a clock change, and making the list
 * reads four hundred formatters.
 */
export function cityOptions(locale: string, now: Date): CityOption[] {
    const key = `${locale}:${Math.floor(now.getTime() / 3_600_000)}`;
    if (cached?.key === key) return cached.options;
    let regions: Intl.DisplayNames | null = null;
    try {
        regions = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
        regions = null;
    }
    const options = listZones().map((zone): CityOption => {
        const known = ZONE_COUNTRIES[zone] ?? ZONE_COUNTRIES[ZONE_LINKS[zone] ?? ""] ?? "";
        const [code = "", note = ""] = known.split("|");
        let country = "";
        try {
            country = code && regions ? (regions.of(code) ?? "") : "";
        } catch {
            country = "";
        }
        return {
            zone,
            city: cityOf(zone),
            country,
            note,
            zoneName: zonePart(zone, now, locale, "longGeneric") || zonePart(zone, now, locale, "long"),
            abbreviation: zonePart(zone, now, locale, "short"),
            offset: `GMT${offsetText(zoneOffsetMinutes(now, zone))}`
        };
    });
    cached = { key, options };
    return options;
}

/** The older names each zone was known by, as cities. */
const OLD_NAMES = new Map<string, string[]>();
for (const [name, target] of Object.entries(ZONE_LINKS))
    OLD_NAMES.set(target, [...(OLD_NAMES.get(target) ?? []), lastSegment(name)]);

const FIELDS: readonly core.SearchField<CityOption>[] = [
    { text: (option) => option.city, weight: 3 },
    { text: (option) => option.country, weight: 2 },
    { text: (option) => [option.note, option.zoneName, option.abbreviation], weight: 1 },
    // The zone's id and its other name ("Calcutta" for Kolkata, also where the
    // runtime still lists the old one and the row is named by the new), for
    // whoever knows a city by that.
    {
        text: (option) => [
            option.zone.replace(/[_/]/g, " "),
            ...(OLD_NAMES.get(option.zone) ?? []),
            lastSegment(option.zone)
        ],
        weight: 1
    },
    { text: (option) => [option.offset, option.offset.replace(":00", "")], weight: 1 }
];

/** The cities matching what was typed, best first. */
export function searchCities(options: readonly CityOption[], query: string, limit = 50): CityOption[] {
    return core.searchItems(options, query, FIELDS, { limit });
}

/** Minutes a city is ahead of another at an instant (+360 for Tokyo over Madrid in summer). */
export function offsetBetween(zone: string, from: string, at: Date): number {
    return zoneOffsetMinutes(at, zone) - zoneOffsetMinutes(at, from);
}

/** Whole calendar days a city's date is ahead of another's at an instant: -1,
 *  0 or 1 ("Yesterday", "Today", "Tomorrow"). */
export function dayDifference(zone: string, from: string, at: Date): number {
    const a = instantToWall(at, zone);
    const b = instantToWall(at, from);
    return Math.round(
        (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86_400_000
    );
}

/**
 * Whether a zone's clock moves in the next `withinDays` days, and when: the
 * world clock warns "clocks change on 25 Oct" before it happens.
 */
export function nextClockChange(zone: string, from: Date, withinDays = 14): Date | null {
    const hour = 3_600_000;
    const start = zoneOffsetMinutes(from, zone);
    let low = from.getTime();
    for (let at = low + hour; at <= from.getTime() + withinDays * 86_400_000; at += hour) {
        if (zoneOffsetMinutes(new Date(at), zone) !== start) {
            // Narrow to the minute it happens.
            let high = at;
            while (high - low > 60_000) {
                const middle = Math.floor((low + high) / 2);
                if (zoneOffsetMinutes(new Date(middle), zone) === start) low = middle;
                else high = middle;
            }
            return new Date(Math.ceil(high / 60_000) * 60_000);
        }
        low = at;
    }
    return null;
}

/** How an hour reads for somebody in a city, timeanddate's way: at work, awake
 *  but off, or asleep or on a day off. */
export type HourKind = "work" | "edge" | "off";

/**
 * An hour of a city's day. `work` is when the person is expected to be at work
 * - the reader's own working hours for their own city, 09:00-17:00 on a
 * weekday anywhere else; `edge` the waking hours around it (07:00-22:00 on a
 * weekday); `off` the night, and the weekend.
 */
export function hourKind(
    weekday: number,
    minutes: number,
    workingHours?: Readonly<Record<string, readonly { from: string; to: string }[]>>
): HourKind {
    const asMinutes = (text: string) => {
        const [h, m] = text.split(":").map(Number) as [number, number];
        return h * 60 + m;
    };
    if (workingHours) {
        const spans = workingHours[String(weekday)] ?? [];
        if (spans.some((span) => minutes >= asMinutes(span.from) && minutes < asMinutes(span.to)))
            return "work";
        if (spans.length === 0) return "off";
        return minutes >= 7 * 60 && minutes < 22 * 60 ? "edge" : "off";
    }
    if (weekday === 0 || weekday === 6) return "off";
    if (minutes >= 9 * 60 && minutes < 17 * 60) return "work";
    return minutes >= 7 * 60 && minutes < 22 * 60 ? "edge" : "off";
}

/** The weekday (0 = Sunday) and minutes after midnight an instant reads as in a city. */
export function wallClock(at: Date, zone: string): { weekday: number; minutes: number; day: string } {
    const wall = instantToWall(at, zone);
    const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
    return {
        weekday: date.getUTCDay(),
        minutes: wall.hour * 60 + wall.minute,
        day: date.toISOString().slice(0, 10)
    };
}

/** The hours of `day` in `zone`, as instants: 24 on most days, 23 or 25 on the
 *  day the clocks change. */
export function hoursOfDay(day: string, zone: string): Date[] {
    const start = wallToInstant(parseWall(day), zone).getTime();
    const end = wallToInstant(parseWall(addDays(day, 1)), zone).getTime();
    const hours: Date[] = [];
    for (let at = start; at < end; at += 3_600_000) hours.push(new Date(at));
    return hours;
}

/** An instant as the path segment `/calendar/new/<when>` reads. */
export function newEventPath(at: Date): string {
    return `/calendar/new/${at.toISOString().slice(0, 16)}Z`;
}
