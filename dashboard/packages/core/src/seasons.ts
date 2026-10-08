/**
 * The times of year Polaris dresses up for, and what an account chose about it.
 *
 * Modelled on Discord's seasonal events: a light decoration for a couple of weeks
 * around a holiday, and an alternate set of sounds somebody has to ask for. The
 * windows are Discord's own where it published one - Halloween from 20 October
 * to 3 November, the winter pack from 19 December to 3 January - with New Year's
 * Eve and Day carved out of winter for confetti, and the Lunar New Year (the
 * first fifteen days of the first lunar month, up to the Lantern Festival).
 *
 * Decided in the reader's own calendar, on their device: a holiday is a date on
 * the wall where somebody is sitting, not one on the server's clock.
 *
 * Sounds are off unless chosen. Discord turned every sound festive for everybody
 * in 2021 and made them opt-in after the complaints; the decoration stayed on by
 * default with a switch beside it, and so does this.
 */

import { z } from "zod";

export const SEASONS = ["halloween", "winter", "newYear", "lunarNewYear"] as const;

export type Season = (typeof SEASONS)[number];

/** What an account chose. Absent fields follow `SEASONAL_DEFAULTS`. */
export const seasonalPrefsSchema = z
    .object({
        /** The decoration: the mark beside the logo and what drifts over the page. */
        theme: z.boolean(),
        /** The alternate ring, message and alert sounds. */
        sounds: z.boolean()
    })
    .partial()
    .strict();

export type SeasonalPrefs = z.infer<typeof seasonalPrefsSchema>;

export interface SeasonalChoice {
    readonly theme: boolean;
    readonly sounds: boolean;
}

export const SEASONAL_DEFAULTS: SeasonalChoice = { theme: true, sounds: false };

/** A stored choice read back. Anything that does not parse is the defaults. */
export function parseSeasonalPrefs(raw: string | null | undefined): SeasonalChoice {
    if (!raw) return SEASONAL_DEFAULTS;
    try {
        const parsed = seasonalPrefsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? { ...SEASONAL_DEFAULTS, ...parsed.data } : SEASONAL_DEFAULTS;
    } catch {
        return SEASONAL_DEFAULTS;
    }
}

let lunar: Intl.DateTimeFormat | null | undefined;

/** The month and day in the Chinese calendar, or null where the runtime has no
 *  such calendar - in which case the Lunar New Year simply does not come. */
function lunarDate(date: Date): { month: string; day: number } | null {
    if (lunar === undefined) {
        try {
            lunar = new Intl.DateTimeFormat("en-u-ca-chinese", { month: "numeric", day: "numeric" });
            // A runtime without the calendar falls back to the Gregorian one silently.
            if (lunar.resolvedOptions().calendar !== "chinese") lunar = null;
        } catch {
            lunar = null;
        }
    }
    if (!lunar) return null;
    let month = "";
    let day = 0;
    for (const part of lunar.formatToParts(date)) {
        if (part.type === "month") month = part.value;
        if (part.type === "day") day = Number(part.value);
    }
    return { month, day };
}

/** Whether month/day falls between two month/days of the same year, inclusive. */
function within(month: number, day: number, from: [number, number], to: [number, number]): boolean {
    const at = month * 100 + day;
    return at >= from[0] * 100 + from[1] && at <= to[0] * 100 + to[1];
}

/** The season in force on a date, in that date's local calendar, or null. */
export function seasonOn(date: Date): Season | null {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    if ((month === 12 && day === 31) || (month === 1 && day === 1)) return "newYear";
    if (within(month, day, [12, 19], [12, 31]) || within(month, day, [1, 1], [1, 3])) return "winter";
    if (within(month, day, [10, 20], [11, 3])) return "halloween";
    // The lunar new year never falls before 21 January or after 20 February, so
    // the calendar is only asked about those weeks and the rest of the year
    // costs nothing.
    if (month === 1 || month === 2 || month === 3) {
        const lunarDay = lunarDate(date);
        if (lunarDay && lunarDay.month === "1" && lunarDay.day <= 15) return "lunarNewYear";
    }
    return null;
}

/** The next season to begin after `date`, and the day it does - within a year. */
export function nextSeason(date: Date): { season: Season; from: Date } | null {
    const current = seasonOn(date);
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    for (let step = 1; step <= 400; step += 1) {
        day.setDate(day.getDate() + 1);
        const season = seasonOn(day);
        if (season && season !== current) return { season, from: new Date(day) };
    }
    return null;
}

/** The last day of the season in force on `date`, or null when there is none. */
export function seasonLastDay(date: Date): Date | null {
    const current = seasonOn(date);
    if (!current) return null;
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    for (let step = 0; step < 40; step += 1) {
        const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        if (seasonOn(next) !== current) return day;
        day.setDate(day.getDate() + 1);
    }
    return day;
}
