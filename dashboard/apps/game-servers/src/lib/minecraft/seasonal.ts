/**
 * A Minecraft server dressed for the time of year: pumpkins and cobwebs around
 * Halloween, with monsters wearing pumpkins and a few more of them at night;
 * snow through winter, with snow golems about the cold places.
 *
 * The dates are Polaris's own (`seasonOn` in @polaris/core), read on the
 * server's wall clock in its events' time zone, so a server decorates on the
 * days its players are living. Nothing here keeps a second calendar: this only
 * decides what the server's Polaris jar is told, and the jar draws it - to each
 * player's screen only, never into the world (see `SeasonalDecor` in the mod and
 * the plugin).
 *
 * Pure, so the decision can be asserted in a test.
 */

import * as core from "@polaris/core";

/** What the jar knows how to draw. */
export const DECORATIONS = ["halloween", "winter"] as const;

export type Decoration = (typeof DECORATIONS)[number];

/** Where a server's own switch is kept. Absent is on: every server decorates
 *  until somebody turns it off. */
export const SEASONAL_KEY = "seasonalDecorations";

/**
 * How long the jar keeps a season it was told, in seconds. Told again every
 * pass while the season lasts, so this only matters when Polaris stops talking
 * to it: the decorations then come down on their own instead of lingering past
 * their dates.
 */
export const SEASON_HOLD_SECONDS = 60 * 60;

/** Whether this server's own switch leaves the decorations on. */
export function seasonalOn(config: Readonly<Record<string, unknown>>): boolean {
    return config[SEASONAL_KEY] !== false;
}

/** The decoration a season brings. New Year's days are part of winter; the
 *  Lunar New Year has none of its own in the game. */
export function decorationFor(season: core.Season | null): Decoration | null {
    if (season === "halloween") return "halloween";
    if (season === "winter" || season === "newYear") return "winter";
    return null;
}

/**
 * The season on a date as a clock in `timeZone` reads it. `seasonOn` reads a
 * date's local fields, so it is handed a date whose local fields are that
 * zone's wall clock. A zone the runtime does not know, or "automatic" (which
 * would be the dashboard machine's own clock), is UTC.
 */
export function seasonInZone(now: Date, timeZone: string): core.Season | null {
    const zone =
        timeZone !== core.AUTOMATIC_TIME_ZONE && core.isTimeZone(timeZone) ? timeZone : "UTC";
    const wall = core.wallClock(now, zone);
    return core.seasonOn(new Date(wall.year, wall.month - 1, wall.day, 12));
}

export interface SeasonInputs {
    readonly now: Date;
    readonly timeZone: string;
    /** The operator's switch for the whole deployment. */
    readonly allowed: boolean;
    /** This server's own switch. */
    readonly serverOn: boolean;
    /** An event is running: its arena stays as it was built. */
    readonly eventRunning: boolean;
}

/** What the server should be showing now, or null for nothing. */
export function decorationNow(inputs: SeasonInputs): Decoration | null {
    if (!inputs.allowed || !inputs.serverOn || inputs.eventRunning) return null;
    return decorationFor(seasonInZone(inputs.now, inputs.timeZone));
}

/** Where a server keeps how many more monsters come out on a Halloween night. */
export const NIGHT_SPAWNS_KEY = "seasonalNightSpawns";

/** Where a server keeps how many snow golems wander its cold places in winter. */
export const SNOW_GOLEMS_KEY = "seasonalSnowGolems";

/** Halloween night spawns, as a multiple of the usual: 1 adds none. */
export const NIGHT_SPAWN_CHOICES = [1, 1.25, 1.5, 2, 3] as const;

/** Winter snow golems, as a multiple of the usual few: 0 brings none. */
export const SNOW_GOLEM_CHOICES = [0, 0.5, 1, 2, 3] as const;

export const DEFAULT_NIGHT_SPAWNS = 1.5;
export const DEFAULT_SNOW_GOLEMS = 1;

/** The jar capability that takes the mob settings on the season line. */
export const MOBS_CAP = "season-mobs";

/** The seasonal mobs a server asks for. */
export interface SeasonalMobs {
    readonly nightSpawns: number;
    readonly snowGolems: number;
}

function choice(value: unknown, choices: readonly number[], fallback: number): number {
    return typeof value === "number" && choices.includes(value) ? value : fallback;
}

/** This server's mob settings; anything absent or not one of the choices is the default. */
export function seasonalMobs(config: Readonly<Record<string, unknown>>): SeasonalMobs {
    return {
        nightSpawns: choice(config[NIGHT_SPAWNS_KEY], NIGHT_SPAWN_CHOICES, DEFAULT_NIGHT_SPAWNS),
        snowGolems: choice(config[SNOW_GOLEMS_KEY], SNOW_GOLEM_CHOICES, DEFAULT_SNOW_GOLEMS)
    };
}

/**
 * The console line that tells the jar. With `mobs` (a jar that lists
 * {@link MOBS_CAP}) the line carries both settings as whole percentages; a jar
 * without it is told the season alone, the line it has always taken.
 */
export function seasonCommand(decoration: Decoration | null, mobs?: SeasonalMobs | null): string {
    if (!decoration) return "polaris season clear";
    const line = `polaris season set ${decoration} ${SEASON_HOLD_SECONDS}`;
    if (!mobs) return line;
    const percent = (multiple: number) => Math.round(multiple * 100);
    return `${line} ${percent(mobs.nightSpawns)} ${percent(mobs.snowGolems)}`;
}
