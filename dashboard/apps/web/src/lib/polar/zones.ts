/**
 * Time zones by their IANA names, from the runtime's own `Intl` data: whether a
 * name is one, a zone's offset at an instant, and a wall time in a zone as an
 * instant. No table of offsets is kept here, so daylight saving is whatever the
 * runtime knows it to be.
 *
 * Pure; shared by the server (checking a view) and the browser (drawing it).
 */

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** Minutes `zone` is ahead of UTC at `instant` (negative when behind). */
export function zoneOffsetMinutes(instant: number, zone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).formatToParts(new Date(instant));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour"),
        get("minute"),
        get("second")
    );
    return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60000);
}

/** A wall time (`YYYY-MM-DDTHH:mm`) in `zone` as an instant, or null when it is
 *  not a real date and time. A time daylight saving skips lands just after. */
export function instantOf(wall: string, zone: string): number | null {
    const match = WALL.exec(wall);
    if (!match) return null;
    const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number
    ];
    if (hour > 23 || minute > 59) return null;
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const check = new Date(guess);
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    const first = guess - zoneOffsetMinutes(guess, zone) * 60000;
    return guess - zoneOffsetMinutes(first, zone) * 60000;
}

/** Whether `wall` reads as a wall time at all. */
export function isWallTime(wall: string): boolean {
    return instantOf(wall, "UTC") !== null;
}
