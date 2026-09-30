/**
 * Hours of the day in a named zone: the local days a range covers and the
 * instant a "HH:mm" on one of them is. Shared by free/busy suggestions and
 * booking pages, which both think in "Mondays 09:00-17:00 in Madrid".
 */

import { addDays } from "./zones";
import { formatWall, instantToWall, parseWall, wallToInstant } from "./tz";

/** "HH:mm" as minutes from midnight; "24:00" is 1440, the end of the day. */
export function minutesOf(time: string): number {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) throw new Error(`Not a time of day: ${time}`);
    return Number(match[1]) * 60 + Number(match[2]);
}

/** The instant `minutes` past local midnight of `date` in `zone` (1440 is the
 *  next midnight). */
export function instantAt(date: string, minutes: number, zone: string): Date {
    const day = Math.floor(minutes / 1440);
    const rest = minutes - day * 1440;
    const wall = parseWall(addDays(date, day));
    return wallToInstant({ ...wall, hour: Math.floor(rest / 60), minute: rest % 60, second: 0 }, zone);
}

/** The local date an instant falls on in a zone. */
export function localDate(instant: Date, zone: string): string {
    return formatWall(instantToWall(instant, zone)).slice(0, 10);
}

/** Every local date from the one `from` falls on to the one `to` falls on. */
export function localDays(from: Date, to: Date, zone: string): string[] {
    const days: string[] = [];
    const last = localDate(to, zone);
    for (let day = localDate(from, zone); day <= last && days.length < 3700; day = addDays(day, 1)) days.push(day);
    return days;
}

/** 0 for Sunday .. 6 for Saturday, the keys `WorkingHours` uses. */
export function weekdayIndex(date: string): number {
    const wall = parseWall(date);
    return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}
