/**
 * Christmas and New Year's Eve on a Minecraft server, on top of the winter
 * decorations `seasonal.ts` already sends: what each server switched on, and
 * the line that tells its Polaris jar.
 *
 * The jar keeps no calendar. The dates are read here, on the server's wall
 * clock in its events' time zone (the same clock `seasonInZone` reads), and the
 * jar is handed the moments themselves - Christmas Eve's midnight and New
 * Year's - as instants, so a countdown on the server lands on the second the
 * players' own clocks say midnight.
 *
 * Pure, so every decision can be asserted in a test.
 */

import { z } from "zod";
import * as core from "@polaris/core";

/** Where a server keeps its Christmas and New Year settings. */
export const WINTER_KEY = "seasonalWinter";

/** The jar capability that takes the winter line. */
export const WINTER_CAP = "season-winter";

/** The settings that are an amount, as a multiple of the usual few: 0 is none. */
export const WINTER_AMOUNTS = [
    "pumpkinGolems",
    "snowCover",
    "reindeer",
    "elves",
    "snowmen"
] as const;

/** The settings that are on or off. */
export const WINTER_SWITCHES = [
    "presents",
    "santa",
    "lights",
    "christmasEve",
    "newYear",
    "sparkles"
] as const;

export type WinterAmount = (typeof WINTER_AMOUNTS)[number];
export type WinterSwitch = (typeof WINTER_SWITCHES)[number];

/** The multiples an amount may be. */
export const WINTER_AMOUNT_CHOICES = [0, 0.5, 1, 2, 3] as const;

export type WinterSettings = { readonly [K in WinterAmount]: number } & {
    readonly [K in WinterSwitch]: boolean;
};

/** Everything on at the usual amount: the jar caps each near every player. */
export const WINTER_DEFAULTS: WinterSettings = {
    pumpkinGolems: 1,
    snowCover: 1,
    reindeer: 1,
    elves: 1,
    snowmen: 1,
    presents: true,
    santa: true,
    lights: true,
    christmasEve: true,
    newYear: true,
    sparkles: true
};

const amountSchema = z
    .number()
    .refine((value) => (WINTER_AMOUNT_CHOICES as readonly number[]).includes(value));

/** What a save may change; anything left out stays as it is. */
export const winterPatchSchema = z
    .object({
        pumpkinGolems: amountSchema,
        snowCover: amountSchema,
        reindeer: amountSchema,
        elves: amountSchema,
        snowmen: amountSchema,
        presents: z.boolean(),
        santa: z.boolean(),
        lights: z.boolean(),
        christmasEve: z.boolean(),
        newYear: z.boolean(),
        sparkles: z.boolean()
    })
    .partial()
    .strict();

export type WinterPatch = z.infer<typeof winterPatchSchema>;

/** This server's settings; anything absent, or not one of the choices, is the default. */
export function winterSettings(config: Readonly<Record<string, unknown>>): WinterSettings {
    const raw = config[WINTER_KEY];
    const stored: Record<string, unknown> =
        raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
    const settings: Record<string, number | boolean> = { ...WINTER_DEFAULTS };
    for (const key of WINTER_AMOUNTS) {
        const value = stored[key];
        if (
            typeof value === "number" &&
            (WINTER_AMOUNT_CHOICES as readonly number[]).includes(value)
        )
            settings[key] = value;
    }
    for (const key of WINTER_SWITCHES) {
        if (typeof stored[key] === "boolean") settings[key] = stored[key];
    }
    return settings as WinterSettings;
}

/** The stored settings with a patch on top, as they are written back. */
export function patchWinter(
    config: Readonly<Record<string, unknown>>,
    patch: WinterPatch
): WinterSettings {
    return { ...winterSettings(config), ...patch };
}

/** The days and moments the jar is told, read on the server's own clock. */
export interface WinterCalendar {
    /** The day on that clock as yyyymmdd: a present is one per player per day. */
    readonly day: number;
    /** 1 to 26 December: presents, Santa and the elves are about. */
    readonly christmas: boolean;
    /** Christmas Eve's midnight (25 December, 00:00) this December, or 0 outside it. */
    readonly eveAt: number;
    /** New Year's midnight (1 January, 00:00) after this December, or 0 outside it. */
    readonly newYearAt: number;
}

function zoneOf(timeZone: string): string {
    return timeZone !== core.AUTOMATIC_TIME_ZONE && core.isTimeZone(timeZone) ? timeZone : "UTC";
}

/** The calendar on `now` as a clock in `timeZone` reads it ("automatic" and unknown zones are UTC). */
export function winterCalendar(now: Date, timeZone: string): WinterCalendar {
    const zone = zoneOf(timeZone);
    const wall = core.wallClock(now, zone);
    const december = wall.month === 12;
    const midnight = (year: number, month: number, day: number) =>
        core.zonedInstant({ year, month, day, hours: 0, minutes: 0 }, zone).getTime();
    return {
        day: wall.year * 10_000 + wall.month * 100 + wall.day,
        christmas: december && wall.day <= 26,
        eveAt: december ? midnight(wall.year, 12, 25) : 0,
        newYearAt: december ? midnight(wall.year + 1, 1, 1) : 0
    };
}

/**
 * The console line with this server's winter, for a jar that lists
 * {@link WINTER_CAP}. Amounts go as whole percentages, switches as 1 or 0, and
 * `lang` is the language players read its messages in.
 */
export function winterCommand(
    settings: WinterSettings,
    calendar: WinterCalendar,
    language: "en" | "es"
): string {
    const percent = (multiple: number) => Math.round(multiple * 100);
    const flag = (on: boolean) => (on ? 1 : 0);
    const parts = [
        `golems=${percent(settings.pumpkinGolems)}`,
        `snow=${percent(settings.snowCover)}`,
        `reindeer=${percent(settings.reindeer)}`,
        `elves=${percent(settings.elves)}`,
        `snowmen=${percent(settings.snowmen)}`,
        `presents=${flag(settings.presents)}`,
        `santa=${flag(settings.santa)}`,
        `lights=${flag(settings.lights)}`,
        `eve=${flag(settings.christmasEve)}`,
        `newyear=${flag(settings.newYear)}`,
        `sparkles=${flag(settings.sparkles)}`,
        `christmas=${flag(calendar.christmas)}`,
        `day=${calendar.day}`,
        `eveat=${calendar.eveAt}`,
        `nyat=${calendar.newYearAt}`,
        `lang=${language}`
    ];
    return `polaris season winter ${parts.join(" ")}`;
}
