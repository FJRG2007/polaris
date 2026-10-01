/**
 * Time zones on `Intl`, with no time-zone database shipped.
 *
 * Every browser and every Node already carries the IANA database behind
 * `Intl.DateTimeFormat`, so a wall time is turned into an instant by asking it
 * what the offset is, and an instant into a wall time by asking it to format.
 * The only thing added here is the names `Intl` does not know: vendor-prefixed
 * TZIDs (Thunderbird, libical) and Windows zone names (Outlook, Exchange).
 *
 * A TZID none of this resolves is not guessed: the caller falls back to the
 * VTIMEZONE the file carried for it (see `zones.ts`).
 */

import type { WallTime } from "./types";

/**
 * Windows zone names to IANA, the CLDR `windowsZones.xml` primary mapping
 * (territory "001") for the zones Outlook and Exchange write most often.
 * Some targets are CLDR's older aliases (`Asia/Calcutta`); every `Intl` knows
 * them.
 */
const WINDOWS_ZONES: Readonly<Record<string, string>> = {
    "Dateline Standard Time": "Etc/GMT+12",
    "UTC-11": "Etc/GMT+11",
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "Alaskan Standard Time": "America/Anchorage",
    "Pacific Standard Time (Mexico)": "America/Tijuana",
    "Pacific Standard Time": "America/Los_Angeles",
    "US Mountain Standard Time": "America/Phoenix",
    "Mountain Standard Time (Mexico)": "America/Mazatlan",
    "Mountain Standard Time": "America/Denver",
    "Central America Standard Time": "America/Guatemala",
    "Central Standard Time": "America/Chicago",
    "Central Standard Time (Mexico)": "America/Mexico_City",
    "Canada Central Standard Time": "America/Regina",
    "SA Pacific Standard Time": "America/Bogota",
    "Eastern Standard Time": "America/New_York",
    "Eastern Standard Time (Mexico)": "America/Cancun",
    "US Eastern Standard Time": "America/Indianapolis",
    "Venezuela Standard Time": "America/Caracas",
    "Atlantic Standard Time": "America/Halifax",
    "SA Western Standard Time": "America/La_Paz",
    "Pacific SA Standard Time": "America/Santiago",
    "Newfoundland Standard Time": "America/St_Johns",
    "E. South America Standard Time": "America/Sao_Paulo",
    "Argentina Standard Time": "America/Buenos_Aires",
    "SA Eastern Standard Time": "America/Cayenne",
    "Greenland Standard Time": "America/Godthab",
    "Montevideo Standard Time": "America/Montevideo",
    "UTC-02": "Etc/GMT+2",
    "Azores Standard Time": "Atlantic/Azores",
    "Cape Verde Standard Time": "Atlantic/Cape_Verde",
    UTC: "Etc/UTC",
    "GMT Standard Time": "Europe/London",
    "Greenwich Standard Time": "Atlantic/Reykjavik",
    "Morocco Standard Time": "Africa/Casablanca",
    "W. Europe Standard Time": "Europe/Berlin",
    "Central Europe Standard Time": "Europe/Budapest",
    "Romance Standard Time": "Europe/Paris",
    "Central European Standard Time": "Europe/Warsaw",
    "W. Central Africa Standard Time": "Africa/Lagos",
    "GTB Standard Time": "Europe/Bucharest",
    "Middle East Standard Time": "Asia/Beirut",
    "Egypt Standard Time": "Africa/Cairo",
    "E. Europe Standard Time": "Europe/Chisinau",
    "South Africa Standard Time": "Africa/Johannesburg",
    "FLE Standard Time": "Europe/Kiev",
    "Israel Standard Time": "Asia/Jerusalem",
    "Turkey Standard Time": "Europe/Istanbul",
    "Arabic Standard Time": "Asia/Baghdad",
    "Arab Standard Time": "Asia/Riyadh",
    "Russian Standard Time": "Europe/Moscow",
    "E. Africa Standard Time": "Africa/Nairobi",
    "Iran Standard Time": "Asia/Tehran",
    "Arabian Standard Time": "Asia/Dubai",
    "Pakistan Standard Time": "Asia/Karachi",
    "India Standard Time": "Asia/Calcutta",
    "Nepal Standard Time": "Asia/Katmandu",
    "Bangladesh Standard Time": "Asia/Dhaka",
    "SE Asia Standard Time": "Asia/Bangkok",
    "China Standard Time": "Asia/Shanghai",
    "Singapore Standard Time": "Asia/Singapore",
    "Taipei Standard Time": "Asia/Taipei",
    "W. Australia Standard Time": "Australia/Perth",
    "Tokyo Standard Time": "Asia/Tokyo",
    "Korea Standard Time": "Asia/Seoul",
    "Cen. Australia Standard Time": "Australia/Adelaide",
    "AUS Central Standard Time": "Australia/Darwin",
    "E. Australia Standard Time": "Australia/Brisbane",
    "AUS Eastern Standard Time": "Australia/Sydney",
    "West Pacific Standard Time": "Pacific/Port_Moresby",
    "Tasmania Standard Time": "Australia/Hobart",
    "New Zealand Standard Time": "Pacific/Auckland",
    "UTC+12": "Etc/GMT-12",
    "Fiji Standard Time": "Pacific/Fiji",
    "Tonga Standard Time": "Pacific/Tongatapu"
};

const WINDOWS_LOWER = new Map(
    Object.entries(WINDOWS_ZONES).map(([name, zone]) => [name.toLowerCase(), zone])
);

/** Formatters by zone. Building one is the expensive part of every conversion. */
const formatters = new Map<string, Intl.DateTimeFormat>();
/** What `resolveZone` answered for a name, including "nothing". */
const resolved = new Map<string, string | null>();

function formatterFor(zone: string): Intl.DateTimeFormat {
    let found = formatters.get(zone);
    if (!found) {
        found = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            era: "short"
        });
        formatters.set(zone, found);
    }
    return found;
}

/** The name as `Intl` accepts it, or null when it throws on it. */
function intlZone(name: string): string | null {
    try {
        const canonical = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions()
            .timeZone;
        // Keep the name as written unless only its case differed: engines do not
        // agree on which alias is canonical, and a TZID that changes spelling
        // between browsers would make a round trip look like an edit.
        return canonical.toLowerCase() === name.toLowerCase() ? canonical : name;
    } catch {
        return null;
    }
}

/**
 * The IANA name a TZID stands for, or null when neither `Intl`, the vendor
 * prefix nor the Windows table knows it.
 *
 * `"/mozilla.org/20050126_1/Europe/Madrid"` and
 * `"/freeassociation.sourceforge.net/Tzfile/Europe/Madrid"` give
 * `"Europe/Madrid"`; `"Romance Standard Time"` gives `"Europe/Paris"`.
 */
export function resolveZone(tzid: string | null | undefined): string | null {
    if (!tzid) return null;
    const name = tzid.trim().replace(/^"|"$/g, "");
    if (!name) return null;
    const cached = resolved.get(name);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    if (/^(z|utc|gmt|etc\/utc|etc\/gmt)$/i.test(name)) found = "UTC";
    if (!found) found = WINDOWS_LOWER.get(name.toLowerCase()) ?? null;
    if (!found && !name.startsWith("/")) found = intlZone(name);
    if (!found && name.includes("/")) {
        // Vendor prefixes: try the longest trailing run of segments Intl knows.
        const segments = name.split("/").filter(Boolean);
        for (let from = 1; from < segments.length && !found; from++)
            found = intlZone(segments.slice(from).join("/"));
    }
    resolved.set(name, found);
    return found;
}

/** A wall time read as if it were UTC, in milliseconds: the base of every
 *  offset calculation here. */
function wallUtcMs(wall: WallTime): number {
    const date = new Date(0);
    date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
    date.setUTCHours(wall.hour, wall.minute, wall.second, 0);
    return date.getTime();
}

/** The wall time an instant reads as in a zone. */
export function instantToWall(instant: Date, zone: string): WallTime {
    if (zone === "UTC") return wallFromUtcDate(instant);
    const parts = formatterFor(zone).formatToParts(instant);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value ?? 0);
    const era = parts.find((part) => part.type === "era")?.value ?? "AD";
    const year = value("year");
    return {
        year: era.startsWith("B") ? 1 - year : year,
        month: value("month"),
        day: value("day"),
        hour: value("hour") % 24,
        minute: value("minute"),
        second: value("second")
    };
}

function wallFromUtcDate(instant: Date): WallTime {
    return {
        year: instant.getUTCFullYear(),
        month: instant.getUTCMonth() + 1,
        day: instant.getUTCDate(),
        hour: instant.getUTCHours(),
        minute: instant.getUTCMinutes(),
        second: instant.getUTCSeconds()
    };
}

/** Minutes a zone is ahead of UTC at an instant (+120 for Madrid in summer). */
export function zoneOffsetMinutes(instant: Date, zone: string): number {
    if (zone === "UTC") return 0;
    const whole = new Date(Math.floor(instant.getTime() / 1000) * 1000);
    return Math.round((wallUtcMs(instantToWall(whole, zone)) - whole.getTime()) / 60_000);
}

function sameWall(a: WallTime, b: WallTime): boolean {
    return (
        a.year === b.year &&
        a.month === b.month &&
        a.day === b.day &&
        a.hour === b.hour &&
        a.minute === b.minute &&
        a.second === b.second
    );
}

/**
 * The instant a wall time names in a zone.
 *
 * RFC 5545 3.3.5 decides the two readings a clock change makes awkward: a time
 * that does not exist (the hour skipped in spring) is read with the offset from
 * before the gap, so 02:30 on a spring-forward night is 03:30 of the new
 * offset; a time that happens twice (the hour repeated in autumn) is the first
 * of the two.
 */
export function wallToInstant(wall: WallTime, zone: string): Date {
    const utc = wallUtcMs(wall);
    if (zone === "UTC") return new Date(utc);
    const day = 86_400_000;
    const before = zoneOffsetMinutes(new Date(utc - day), zone);
    const offsets = new Set([
        before,
        zoneOffsetMinutes(new Date(utc), zone),
        zoneOffsetMinutes(new Date(utc + day), zone)
    ]);
    const matches: number[] = [];
    for (const offset of offsets) {
        const candidate = utc - offset * 60_000;
        if (sameWall(instantToWall(new Date(candidate), zone), wall)) matches.push(candidate);
    }
    if (matches.length > 0) return new Date(Math.min(...matches));
    return new Date(utc - before * 60_000);
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** Read `YYYY-MM-DDTHH:mm:ss` (seconds optional; a bare date is midnight). */
export function parseWall(text: string): WallTime {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
        text.trim()
    );
    if (!match) throw new Error(`Not a wall time: ${text}`);
    const [, year, month, day, hour, minute, second] = match;
    return {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: Number(hour ?? 0),
        minute: Number(minute ?? 0),
        second: Number(second ?? 0)
    };
}

/** Write a wall time as `YYYY-MM-DDTHH:mm:ss`. */
export function formatWall(wall: WallTime): string {
    return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

/**
 * A wall time moved by whole units of calendar arithmetic (days, minutes...),
 * normalised the way a clock would: 23:30 plus 60 minutes is 00:30 next day.
 */
export function addToWall(wall: WallTime, change: { days?: number; seconds?: number }): WallTime {
    const date = new Date(
        wallUtcMs(wall) + (change.days ?? 0) * 86_400_000 + (change.seconds ?? 0) * 1000
    );
    return wallFromUtcDate(date);
}

/** Seconds from one wall time to another, as if both were on the same clock. */
export function wallDifferenceSeconds(from: WallTime, to: WallTime): number {
    return Math.round((wallUtcMs(to) - wallUtcMs(from)) / 1000);
}

/** Every IANA zone this runtime knows, sorted, with UTC. */
export function listZones(): string[] {
    const supported = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] })
        .supportedValuesOf;
    const zones = new Set(supported ? supported("timeZone") : []);
    zones.add("UTC");
    return [...zones].sort();
}

/** `"GMT+02:00 Europe/Madrid"`: the offset at that instant, then the name. */
export function zoneLabel(zone: string, instant: Date, locale: string): string {
    const offset = zoneOffsetMinutes(instant, zone);
    const sign = offset < 0 ? "-" : "+";
    const abs = Math.abs(offset);
    const name = zone.replace(/_/g, " ");
    // The offset reads the same in every language; only digits are localised.
    const digits = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
    return `GMT${sign}${digits.format(Math.floor(abs / 60))}:${digits.format(abs % 60)} ${name}`;
}
