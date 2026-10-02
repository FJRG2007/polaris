/**
 * How the Time area says times, lengths and repeats, in the reader's language.
 *
 * Pure apart from the translator it is handed.
 */

import type { CalendarTranslator } from "../../lib/i18n";
import { EVERY_DAY, hasDay, WEEKDAYS, WEEKEND } from "../../lib/clock/model";

/** "07:30" or "7:30 AM", the reader's clock, for a wall time "HH:mm". */
export function wallTimeText(time: string, locale: string, hour12: boolean): string {
    const [hour, minute] = time.split(":").map(Number) as [number, number];
    return new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        hour12,
        timeZone: "UTC"
    }).format(new Date(Date.UTC(2024, 0, 1, hour, minute)));
}

/** An instant's time of day in a zone. */
export function instantTimeText(at: Date | number, locale: string, zone: string, hour12: boolean): string {
    return new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        hour12,
        timeZone: zone
    }).format(at);
}

/** The short name of a weekday, 0 = Sunday. */
export function weekdayName(weekday: number, locale: string, style: "short" | "narrow" | "long" = "short"): string {
    // 7 January 2024 was a Sunday.
    return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(
        new Date(Date.UTC(2024, 0, 7 + weekday, 12))
    );
}

/** The weekdays in the order the reader's week runs. */
export function weekOrder(firstDay: number): number[] {
    return Array.from({ length: 7 }, (_, index) => (firstDay + index) % 7);
}

/** "Every day", "Weekdays", "Mon, Wed, Fri" or "Once". */
export function repeatText(days: number, t: CalendarTranslator, locale: string, firstDay: number): string {
    if (days === 0) return t("time.alarms.once");
    if (days === EVERY_DAY) return t("time.alarms.everyDay");
    if (days === WEEKDAYS) return t("time.alarms.weekdays");
    if (days === WEEKEND) return t("time.alarms.weekends");
    return weekOrder(firstDay)
        .filter((weekday) => hasDay(days, weekday))
        .map((weekday) => weekdayName(weekday, locale))
        .join(", ");
}

/** "2 h 05 min", "12 min", "45 s": how long until something, or how long it is. */
export function lengthText(ms: number, t: CalendarTranslator): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return t("time.length.hours", { hours, minutes });
    if (minutes > 0) return t("time.length.minutes", { minutes });
    return t("time.length.seconds", { seconds });
}

/** "+6 h", "-30 min", "+5 h 30 min", or "Same time". */
export function offsetDifferenceText(minutes: number, t: CalendarTranslator): string {
    if (minutes === 0) return t("time.world.sameTime");
    const sign = minutes > 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const rest = abs % 60;
    if (hours === 0) return t("time.world.offsetMinutes", { sign, minutes: rest });
    if (rest === 0) return t("time.world.offsetHours", { sign, hours });
    return t("time.world.offsetBoth", { sign, hours, minutes: rest });
}

/** "Yesterday", "Today" or "Tomorrow" for a day difference of -1, 0 or 1. */
export function dayWord(difference: number, t: CalendarTranslator): string {
    return difference < 0 ? t("time.world.yesterday") : difference > 0 ? t("time.world.tomorrow") : t("time.world.today");
}
