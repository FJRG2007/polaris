/**
 * The times of year Polaris dresses up for, and the one thing an account can say
 * about it.
 *
 * Modelled on Discord's seasonal events: Polaris carries the packs and runs each
 * one on its dates - a light decoration and a set of sounds - with nothing to
 * set up. The windows are Discord's: Halloween from 7 October to 2 November (its
 * 2026 event), the winter pack from 19 December to 5 January, with New Year's
 * Eve and Day carved out of winter for confetti, and the Lunar New Year (the
 * first fifteen days of the first lunar month, up to the Lantern Festival).
 *
 * Decided in the reader's own calendar, on their device: a holiday is a date on
 * the wall where somebody is sitting, not one on the server's clock.
 *
 * Like Discord, the sounds come on with the season and an account can turn off
 * the pack in force - only that one: the next season's comes on again when it
 * starts. The decoration is not a choice; the operator's switch is the only one.
 */

import { z } from "zod";

export const SEASONS = ["halloween", "winter", "newYear", "lunarNewYear"] as const;

export type Season = (typeof SEASONS)[number];

/** The sound pack a season plays. New Year's Eve and Day sit inside the winter
 *  event, so they belong to its pack: one switch turns the whole stretch off. */
export function packOf(season: Season): Season {
    return season === "newYear" ? "winter" : season;
}

/**
 * Which pack is playing on a date, as a key that names that one run of it -
 * `halloween-2026`, `winter-2026` (through to 5 January 2027) - or null when
 * none is. A pack turned off is stored by this key, so turning one off says
 * nothing about the next.
 */
export function packOn(date: Date): string | null {
    const season = seasonOn(date);
    if (!season) return null;
    const pack = packOf(season);
    // Winter runs over New Year: its January days belong to December's run.
    const year = pack === "winter" && date.getMonth() === 0 ? date.getFullYear() - 1 : date.getFullYear();
    return `${pack}-${year}`;
}

/** What an account sends: the pack it turned off, or null to turn it back on. */
export const seasonalPrefsSchema = z
    .object({ mutedPack: z.string().regex(/^(halloween|winter|lunarNewYear)-\d{4}$/).nullable() })
    .strict();

export type SeasonalPrefs = z.infer<typeof seasonalPrefsSchema>;

export interface SeasonalChoice {
    /** The run of a pack this account turned off, by `packOn`'s key. */
    readonly mutedPack: string | null;
}

export const SEASONAL_DEFAULTS: SeasonalChoice = { mutedPack: null };

/**
 * A stored choice read back. Anything that does not parse is the defaults.
 *
 * Rows saved before the packs ran by date hold `theme` and `sounds` switches;
 * those were choices about a feature that no longer asks, and read as nothing.
 */
export function parseSeasonalPrefs(raw: string | null | undefined): SeasonalChoice {
    if (!raw) return SEASONAL_DEFAULTS;
    try {
        const parsed = z
            .object({ mutedPack: seasonalPrefsSchema.shape.mutedPack.optional() })
            .safeParse(JSON.parse(raw));
        return parsed.success ? { mutedPack: parsed.data.mutedPack ?? null } : SEASONAL_DEFAULTS;
    } catch {
        return SEASONAL_DEFAULTS;
    }
}

/** Whether a pack's sounds play on a date for an account with this choice. */
export function packPlays(date: Date, choice: SeasonalChoice): boolean {
    const pack = packOn(date);
    return pack !== null && pack !== choice.mutedPack;
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
    if (within(month, day, [12, 19], [12, 31]) || within(month, day, [1, 1], [1, 5])) return "winter";
    if (within(month, day, [10, 7], [11, 2])) return "halloween";
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

/** The last day of the sound pack playing on `date` - winter's runs through New
 *  Year - or null when none is. */
export function packLastDay(date: Date): Date | null {
    const pack = packOn(date);
    if (!pack) return null;
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    for (let step = 0; step < 40; step += 1) {
        const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        if (packOn(next) !== pack) return day;
        day.setDate(day.getDate() + 1);
    }
    return day;
}
