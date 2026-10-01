/**
 * Turning the file's date values into instants and back.
 *
 * A TZID is read through `Intl` whenever `resolveZone` knows it. One it does not
 * - a zone somebody's server invented, an Outlook display name - is read through
 * the VTIMEZONE block the same file carried for it, which ical.js knows how to
 * evaluate. Only when neither exists is the time read as floating, in the zone
 * of whoever is looking: the least wrong reading of a file that named a zone and
 * never defined it.
 */

import ICAL from "ical.js";
import type { DateValue, WallTime } from "./types";
import { formatWall, instantToWall, parseWall, resolveZone, wallToInstant } from "./tz";

/** Both directions of one zone's clock. */
export interface ZoneClock {
    toInstant(wall: WallTime): Date;
    toWall(instant: Date): WallTime;
}

/** Parsed VTIMEZONE blocks, by their text: parsing one expands its rules. */
const fileZones = new Map<string, ICAL.Timezone | null>();

function fileZone(text: string): ICAL.Timezone | null {
    if (fileZones.has(text)) return fileZones.get(text) ?? null;
    let zone: ICAL.Timezone | null = null;
    try {
        zone = new ICAL.Timezone(ICAL.Component.fromString(text));
    } catch {
        zone = null;
    }
    fileZones.set(text, zone);
    return zone;
}

/** The TZID a VTIMEZONE block declares, or null when it has none. */
export function vtimezoneId(text: string): string | null {
    const match = /^TZID(?:;[^:]*)?:(.*)$/im.exec(text);
    return match?.[1]?.trim() ?? null;
}

function intlClock(zone: string): ZoneClock {
    return {
        toInstant: (wall) => wallToInstant(wall, zone),
        toWall: (instant) => instantToWall(instant, zone)
    };
}

function icalClock(zone: ICAL.Timezone): ZoneClock {
    return {
        toInstant(wall) {
            const time = ICAL.Time.fromData({ ...wall, isDate: false });
            const offset = zone.utcOffset(time);
            const utc = Date.UTC(
                wall.year,
                wall.month - 1,
                wall.day,
                wall.hour,
                wall.minute,
                wall.second
            );
            return new Date(utc - offset * 1000);
        },
        toWall(instant) {
            const time = ICAL.Time.fromJSDate(instant, true).convertToZone(zone);
            return {
                year: time.year,
                month: time.month,
                day: time.day,
                hour: time.hour,
                minute: time.minute,
                second: time.second
            };
        }
    };
}

/**
 * The clock a TZID is read on.
 *
 * `null` is floating time, read in `floatingZone`. `timezones` are the VTIMEZONE
 * blocks the item carried, consulted only for a TZID `Intl` cannot resolve.
 */
export function clockFor(
    tzid: string | null,
    floatingZone: string,
    timezones: readonly string[] = []
): ZoneClock {
    if (tzid === null) return intlClock(resolveZone(floatingZone) ?? "UTC");
    const known = resolveZone(tzid);
    if (known) return intlClock(known);
    const block = timezones.find((text) => vtimezoneId(text) === tzid);
    const zone = block ? fileZone(block) : null;
    if (zone) return icalClock(zone);
    return intlClock(resolveZone(floatingZone) ?? "UTC");
}

/** The wall reading of a value: midnight for a date. */
export function valueWall(value: DateValue): WallTime {
    return "date" in value ? parseWall(value.date) : parseWall(value.dateTime);
}

/** Whether a value is a date with no time (an all-day value). */
export function isDateOnly(value: DateValue): value is { readonly date: string } {
    return "date" in value;
}

/**
 * The instant a date value names.
 *
 * An all-day value is midnight in `floatingZone`, as is a floating time's wall
 * reading: both mean "wherever the reader is". `timezones` are the item's
 * VTIMEZONE blocks, for a TZID `Intl` does not know.
 */
export function valueToInstant(
    value: DateValue,
    floatingZone: string,
    timezones: readonly string[] = []
): Date {
    if ("date" in value) return clockFor(null, floatingZone).toInstant(parseWall(value.date));
    return clockFor(value.tzid, floatingZone, timezones).toInstant(parseWall(value.dateTime));
}

/** An instant written as a value in the same zone and kind as `like`. */
export function instantToValue(
    instant: Date,
    like: DateValue,
    floatingZone: string,
    timezones: readonly string[] = []
): DateValue {
    if ("date" in like)
        return { date: formatWall(clockFor(null, floatingZone).toWall(instant)).slice(0, 10) };
    const wall = clockFor(like.tzid, floatingZone, timezones).toWall(instant);
    return { dateTime: formatWall(wall), tzid: like.tzid };
}

/** A date string moved by whole days: `addDays("2026-03-30", 2)` is `2026-04-01`. */
export function addDays(date: string, days: number): string {
    const wall = parseWall(date);
    const moved = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
    return moved.toISOString().slice(0, 10);
}

/** Whole days from one date string to another. */
export function daysBetween(from: string, to: string): number {
    const a = parseWall(from);
    const b = parseWall(to);
    return Math.round(
        (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000
    );
}
