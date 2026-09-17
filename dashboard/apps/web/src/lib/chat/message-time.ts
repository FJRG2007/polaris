/**
 * When a message was sent, the way a chat says it.
 *
 * A clock time rather than "an hour ago": somebody reading back through a
 * conversation places a line by the time on it, and a relative phrase has to be
 * worked backwards from the time now. Today is the time alone, yesterday says so,
 * and anything older carries its date - the same shape Discord uses. Formatted
 * through the reader's own display preferences, so the clock is their 12 or 24
 * hours and the date is in their order, and the day is decided in their time
 * zone rather than the server's.
 */

import { wallClock, type DisplayFormat } from "@polaris/core";

/** The calendar day of `date` in `timeZone`, as a number that orders days. */
function dayNumber(date: Date, timeZone: string): number {
    const wall = wallClock(date, timeZone);
    return Date.UTC(wall.year, wall.month - 1, wall.day) / 86_400_000;
}

/** "14:05", "Yesterday at 14:05", or "31/07/2026 14:05". "-" for no date. */
export function messageStamp(format: DisplayFormat, iso: string, now: Date = new Date()): string {
    const sent = new Date(iso);
    if (Number.isNaN(sent.getTime())) return "-";
    const zone = format.preferences.timeZone;
    const days = dayNumber(now, zone) - dayNumber(sent, zone);
    const time = format.time(sent);
    if (days === 0) return time;
    if (days === 1) return `Yesterday at ${time}`;
    return format.dateTime(sent);
}
