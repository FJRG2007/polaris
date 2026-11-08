/**
 * The times of year Polaris dresses up for, and the one thing an account can say
 * about it.
 *
 * Modelled on Discord's seasonal events: Polaris carries the packs and runs each
 * one on its dates - a light decoration and a set of sounds - with nothing to
 * set up. The windows are Discord's: Halloween from 7 October to 2 November (its
 * 2026 event), the winter pack from 1 December to 9 January, with New Year's
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

/**
 * Whether a season's window is read on the Gregorian calendar or the Chinese
 * one. The Lunar New Year moves against the Gregorian year, so its window is
 * months and days of the lunar year.
 */
export const SEASON_KINDS: Readonly<Record<Season, "solar" | "lunar">> = {
    halloween: "solar",
    winter: "solar",
    newYear: "solar",
    lunarNewYear: "lunar"
};

/** Which season wins a day two windows share: New Year's Eve and Day are carved
 *  out of winter, and the lunar window is only asked once no other matched. */
export const SEASON_PRIORITY: readonly Season[] = [
    "newYear",
    "winter",
    "halloween",
    "lunarNewYear"
];

/** A day of the year, as the month (1-12) and the day of the month. */
export interface MonthDay {
    readonly month: number;
    readonly day: number;
}

/** The days a season runs, both inclusive. `from` later in the year than `to`
 *  is a window that crosses the year end, as winter's does. */
export interface SeasonWindow {
    readonly from: MonthDay;
    readonly to: MonthDay;
}

export interface SeasonRule {
    readonly enabled: boolean;
    readonly window: SeasonWindow;
}

/** Every season's rule: what every reader of the calendar decides by. */
export type SeasonCalendar = Readonly<Record<Season, SeasonRule>>;

/** The windows Polaris ships with, Discord's. */
export const DEFAULT_SEASON_CALENDAR: SeasonCalendar = {
    halloween: {
        enabled: true,
        window: { from: { month: 10, day: 7 }, to: { month: 11, day: 2 } }
    },
    winter: { enabled: true, window: { from: { month: 12, day: 1 }, to: { month: 1, day: 9 } } },
    newYear: { enabled: true, window: { from: { month: 12, day: 31 }, to: { month: 1, day: 1 } } },
    lunarNewYear: {
        enabled: true,
        window: { from: { month: 1, day: 1 }, to: { month: 1, day: 15 } }
    }
};

/** The longest each month runs: February with its 29th, a lunar month 30. */
const SOLAR_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const LUNAR_MONTH_DAYS = 30;

/** The last day a month can have, on a season's calendar. */
export function daysInSeasonMonth(season: Season, month: number): number {
    if (SEASON_KINDS[season] === "lunar") return LUNAR_MONTH_DAYS;
    return SOLAR_MONTH_DAYS[month - 1] ?? 31;
}

const monthDaySchema = z
    .object({
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31)
    })
    .strict();

/** One season's rule as an admin sends it, the day checked against its month on
 *  that season's calendar. The issue codes are what the screen translates. */
export function seasonRuleSchema(season: Season) {
    return z
        .object({ enabled: z.boolean(), from: monthDaySchema, to: monthDaySchema })
        .strict()
        .superRefine((rule, ctx) => {
            for (const end of ["from", "to"] as const) {
                if (rule[end].day > daysInSeasonMonth(season, rule[end].month)) {
                    ctx.addIssue({ code: "custom", path: [end, "day"], message: "dayOutOfMonth" });
                }
            }
        });
}

export type SeasonRuleInput = z.infer<ReturnType<typeof seasonRuleSchema>>;

/** The days of a leap year a solar window covers, as month * 100 + day. */
function daysOf(window: SeasonWindow): Set<number> {
    const days = new Set<number>();
    for (let month = 1; month <= 12; month += 1) {
        for (let day = 1; day <= SOLAR_MONTH_DAYS[month - 1]!; day += 1) {
            if (inWindow(month, day, window)) days.add(month * 100 + day);
        }
    }
    return days;
}

/** Two seasons whose windows may share days: New Year is meant to sit inside
 *  winter, whose pack it plays. */
function mayShare(a: Season, b: Season): boolean {
    return (a === "newYear" && b === "winter") || (a === "winter" && b === "newYear");
}

/**
 * The seasons an enabled solar season shares days with, where it may not. The
 * lunar window cannot be compared - its days move every year - and the
 * priority order settles a day it shares.
 */
export function seasonOverlaps(calendar: SeasonCalendar, season: Season): Season[] {
    const rule = calendar[season];
    if (!rule.enabled || SEASON_KINDS[season] !== "solar") return [];
    const mine = daysOf(rule.window);
    return SEASONS.filter((other) => {
        if (other === season || mayShare(season, other)) return false;
        const theirs = calendar[other];
        if (!theirs.enabled || SEASON_KINDS[other] !== "solar") return false;
        for (const day of daysOf(theirs.window)) if (mine.has(day)) return true;
        return false;
    });
}

/** Whether a window is the one the season ships with. */
export function isDefaultWindow(season: Season, window: SeasonWindow): boolean {
    const shipped = DEFAULT_SEASON_CALENDAR[season].window;
    return (
        shipped.from.month === window.from.month &&
        shipped.from.day === window.from.day &&
        shipped.to.month === window.to.month &&
        shipped.to.day === window.to.day
    );
}

/** A stored override of one season: only what differs from the defaults. */
const storedRuleSchema = z
    .object({
        enabled: z.boolean().optional(),
        from: monthDaySchema.optional(),
        to: monthDaySchema.optional()
    })
    .strip();

export type SeasonOverrides = Partial<
    Record<Season, { enabled?: boolean; from?: MonthDay; to?: MonthDay }>
>;

/**
 * The stored overrides read back, season by season: one that does not parse,
 * or names a day its month does not have, is that season's defaults, and
 * nothing stored is the shipped calendar - so an install that never touched it
 * keeps the dates it always had.
 */
export function parseSeasonOverrides(raw: string | null | undefined): SeasonOverrides {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== "object") return {};
    const overrides: SeasonOverrides = {};
    for (const season of SEASONS) {
        const entry = storedRuleSchema.safeParse((parsed as Record<string, unknown>)[season]);
        if (!entry.success) continue;
        const { enabled, from, to } = entry.data;
        const days = (end: MonthDay | undefined) =>
            !end || end.day <= daysInSeasonMonth(season, end.month);
        // A window is kept whole or not at all: half of one is a different season.
        const window = from && to && days(from) && days(to) ? { from, to } : {};
        overrides[season] = { ...(enabled === undefined ? {} : { enabled }), ...window };
    }
    return overrides;
}

/** The calendar every reader decides by: the defaults with the overrides on top. */
export function resolveSeasonCalendar(overrides: SeasonOverrides): SeasonCalendar {
    const calendar = {} as Record<Season, SeasonRule>;
    for (const season of SEASONS) {
        const shipped = DEFAULT_SEASON_CALENDAR[season];
        const own = overrides[season];
        calendar[season] = {
            enabled: own?.enabled ?? shipped.enabled,
            window: own?.from && own.to ? { from: own.from, to: own.to } : shipped.window
        };
    }
    return calendar;
}

/** The override that stores a rule: only the parts that differ from the
 *  defaults, or null when it is the defaults. */
export function overrideOf(
    season: Season,
    rule: SeasonRule
): { enabled?: boolean; from?: MonthDay; to?: MonthDay } | null {
    const shipped = DEFAULT_SEASON_CALENDAR[season];
    const enabled = rule.enabled === shipped.enabled ? {} : { enabled: rule.enabled };
    const window = isDefaultWindow(season, rule.window) ? {} : { ...rule.window };
    const override = { ...enabled, ...window };
    return Object.keys(override).length ? override : null;
}

/** Whether a solar window's `from` comes later in the year than its `to`. */
export function crossesYearEnd(window: SeasonWindow): boolean {
    return window.from.month * 100 + window.from.day > window.to.month * 100 + window.to.day;
}

/** Whether month/day falls in a window, both ends inclusive, across the year
 *  end when the window crosses it. */
function inWindow(month: number, day: number, window: SeasonWindow): boolean {
    const at = month * 100 + day;
    const from = window.from.month * 100 + window.from.day;
    const to = window.to.month * 100 + window.to.day;
    return from <= to ? at >= from && at <= to : at >= from || at <= to;
}

/** The sound pack a season plays. New Year's Eve and Day sit inside the winter
 *  event, so they belong to its pack: one switch turns the whole stretch off. */
export function packOf(season: Season): Season {
    return season === "newYear" ? "winter" : season;
}

/**
 * Which pack is playing on a date, as a key that names that one run of it -
 * `halloween-2026`, `winter-2026` (through to 9 January 2027) - or null when
 * none is. A pack turned off is stored by this key, so turning one off says
 * nothing about the next.
 */
export function packOn(
    date: Date,
    calendar: SeasonCalendar = DEFAULT_SEASON_CALENDAR
): string | null {
    const season = seasonOn(date, calendar);
    if (!season) return null;
    const pack = packOf(season);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    // A run that crosses the year end is named after the year it began in:
    // winter's January days belong to December's run. The pack's own window
    // decides, so New Year's days follow the winter run they sit in.
    const window =
        SEASON_KINDS[pack] === "solar" && inWindow(month, day, calendar[pack].window)
            ? calendar[pack].window
            : calendar[season].window;
    const wraps = SEASON_KINDS[season] === "solar" && crossesYearEnd(window);
    const startedLastYear = wraps && month * 100 + day <= window.to.month * 100 + window.to.day;
    return `${pack}-${startedLastYear ? date.getFullYear() - 1 : date.getFullYear()}`;
}

/** What an account sends: the pack it turned off, or null to turn it back on. */
export const seasonalPrefsSchema = z
    .object({
        mutedPack: z
            .string()
            .regex(/^(halloween|winter|lunarNewYear)-\d{4}$/)
            .nullable()
    })
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
export function packPlays(
    date: Date,
    choice: SeasonalChoice,
    calendar: SeasonCalendar = DEFAULT_SEASON_CALENDAR
): boolean {
    const pack = packOn(date, calendar);
    return pack !== null && pack !== choice.mutedPack;
}

let lunar: Intl.DateTimeFormat | null | undefined;

/** The month and day in the Chinese calendar, or null where the runtime has no
 *  such calendar - in which case the Lunar New Year simply does not come. A
 *  leap month ("4bis") has no number and is in no window. */
function lunarDate(date: Date): { month: number; day: number } | null {
    if (lunar === undefined) {
        try {
            lunar = new Intl.DateTimeFormat("en-u-ca-chinese", {
                month: "numeric",
                day: "numeric"
            });
            // A runtime without the calendar falls back to the Gregorian one silently.
            if (lunar.resolvedOptions().calendar !== "chinese") lunar = null;
        } catch {
            lunar = null;
        }
    }
    if (!lunar) return null;
    let month = Number.NaN;
    let day = 0;
    for (const part of lunar.formatToParts(date)) {
        if (part.type === "month")
            month = /^\d+$/.test(part.value) ? Number(part.value) : Number.NaN;
        if (part.type === "day") day = Number(part.value);
    }
    return Number.isNaN(month) ? null : { month, day };
}

/** The season in force on a date, in that date's local calendar, or null. A
 *  season switched off on the calendar never is. */
export function seasonOn(
    date: Date,
    calendar: SeasonCalendar = DEFAULT_SEASON_CALENDAR
): Season | null {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    for (const season of SEASON_PRIORITY) {
        const rule = calendar[season];
        if (!rule.enabled) continue;
        if (SEASON_KINDS[season] === "solar") {
            if (inWindow(month, day, rule.window)) return season;
            continue;
        }
        const lunarDay = lunarDate(date);
        if (lunarDay && inWindow(lunarDay.month, lunarDay.day, rule.window)) return season;
    }
    return null;
}

/** The next season to begin after `date`, and the day it does - within a year. */
export function nextSeason(
    date: Date,
    calendar: SeasonCalendar = DEFAULT_SEASON_CALENDAR
): { season: Season; from: Date } | null {
    const current = seasonOn(date, calendar);
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    for (let step = 1; step <= 400; step += 1) {
        day.setDate(day.getDate() + 1);
        const season = seasonOn(day, calendar);
        if (season && season !== current) return { season, from: new Date(day) };
    }
    return null;
}

/** The longest a season or pack is followed forward: a window can be most of
 *  the year once an admin widens it. */
const LONGEST_RUN_DAYS = 366;

/** The last day of the season in force on `date`, or null when there is none. */
export function seasonLastDay(
    date: Date,
    calendar: SeasonCalendar = DEFAULT_SEASON_CALENDAR
): Date | null {
    const current = seasonOn(date, calendar);
    if (!current) return null;
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    for (let step = 0; step < LONGEST_RUN_DAYS; step += 1) {
        const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        if (seasonOn(next, calendar) !== current) return day;
        day.setDate(day.getDate() + 1);
    }
    return day;
}

/** The last day of the sound pack playing on `date` - winter's runs through New
 *  Year - or null when none is. */
export function packLastDay(
    date: Date,
    calendar: SeasonCalendar = DEFAULT_SEASON_CALENDAR
): Date | null {
    const pack = packOn(date, calendar);
    if (!pack) return null;
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    for (let step = 0; step < LONGEST_RUN_DAYS; step += 1) {
        const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        if (packOn(next, calendar) !== pack) return day;
        day.setDate(day.getDate() + 1);
    }
    return day;
}
