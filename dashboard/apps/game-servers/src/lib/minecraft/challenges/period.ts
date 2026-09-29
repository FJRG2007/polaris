/**
 * When each layer's period begins and ends, in the server's own time zone.
 *
 * A day starts at the reset time, not at midnight: with a reset at 06:00, five
 * in the morning still belongs to yesterday. A week starts on the chosen
 * weekday's reset, a month on the first day's, and a season is a run of whole
 * weeks from its first day.
 *
 * Pure, with the clock passed in.
 */

import { parseTime } from "../schedule";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar date and the minute of the day at an instant, in a zone. */
export function localParts(
    at: number,
    timezone: string
): { year: number; month: number; day: number; minutes: number } {
    const format = (zone: string) =>
        new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }).formatToParts(new Date(at));
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = format(timezone);
    } catch {
        parts = format("UTC");
    }
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {
        year: read("year"),
        month: read("month"),
        day: read("day"),
        minutes: read("hour") * 60 + read("minute")
    };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `2026-09-29` for a date's parts. */
function dateKey(parts: { year: number; month: number; day: number }): string {
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Days since the epoch for a `YYYY-MM-DD`, so two can be subtracted. */
export function dayNumber(key: string): number {
    const [year, month, day] = key.split("-").map(Number) as [number, number, number];
    return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function keyOfDay(number: number): string {
    const date = new Date(number * DAY_MS);
    return dateKey({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate()
    });
}

/** 0 for Sunday. */
export function weekdayOf(key: string): number {
    return new Date(dayNumber(key) * DAY_MS).getUTCDay();
}

export interface Clock {
    readonly timezone: string;
    /** `HH:MM` */
    readonly resetAt: string;
    /** 0 is Sunday. */
    readonly weekDay: number;
}

function resetMinutes(clock: Clock): number {
    return parseTime(clock.resetAt) ?? 0;
}

/** The challenge day an instant belongs to. */
export function dayKey(clock: Clock, now: number): string {
    return dateKey(localParts(now - resetMinutes(clock) * 60_000, clock.timezone));
}

/** The challenge week: the day it began. */
export function weekKey(clock: Clock, now: number): string {
    return weekOfDay(clock, dayKey(clock, now));
}

export function weekOfDay(clock: Clock, day: string): string {
    const back = (weekdayOf(day) - clock.weekDay + 7) % 7;
    return keyOfDay(dayNumber(day) - back);
}

/** The challenge month: `2026-09`. */
export function monthKey(clock: Clock, now: number): string {
    return dayKey(clock, now).slice(0, 7);
}

/** Milliseconds to the next reset of the day. */
export function msToNextDay(clock: Clock, now: number): number {
    const { minutes } = localParts(now, clock.timezone);
    const seconds = Math.floor(now / 1000) % 60;
    const wait = (resetMinutes(clock) - minutes + 1440) % 1440 || 1440;
    return wait * 60_000 - seconds * 1000;
}

/** When the period of a key ends, as an instant, from the moment now. */
export function dayEndsAt(clock: Clock, now: number): number {
    return now + msToNextDay(clock, now);
}

export function weekEndsAt(clock: Clock, now: number): number {
    const today = dayKey(clock, now);
    const left = 6 - ((weekdayOf(today) - clock.weekDay + 7) % 7);
    return dayEndsAt(clock, now) + left * DAY_MS;
}

export function monthEndsAt(clock: Clock, now: number): number {
    const today = dayKey(clock, now);
    const [year, month] = today.split("-").map(Number) as [number, number];
    const next = Math.round(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1) / DAY_MS);
    return dayEndsAt(clock, now) + (next - dayNumber(today) - 1) * DAY_MS;
}

export interface Season {
    readonly key: string;
    /** 1 for the first. */
    readonly number: number;
    readonly startDay: string;
    readonly endDay: string;
    readonly endsAt: number;
    /** Whole days left, today included. */
    readonly daysLeft: number;
}

/** The season a day falls in, counted in runs of `weeks` from the first day. */
export function seasonOf(clock: Clock, now: number, firstDay: string, weeks: number): Season {
    const today = dayKey(clock, now);
    const length = weeks * 7;
    const elapsed = Math.max(0, dayNumber(today) - dayNumber(firstDay));
    const index = Math.floor(elapsed / length);
    const start = dayNumber(firstDay) + index * length;
    const end = start + length - 1;
    return {
        key: `${firstDay}#${index + 1}`,
        number: index + 1,
        startDay: keyOfDay(start),
        endDay: keyOfDay(end),
        endsAt: dayEndsAt(clock, now) + (end - dayNumber(today)) * DAY_MS,
        daysLeft: end - dayNumber(today) + 1
    };
}
