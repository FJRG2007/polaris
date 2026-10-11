/**
 * A Minecraft server dressed for the time of year: pumpkins and cobwebs around
 * Halloween, snow through winter.
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

/** The console line that tells the jar. */
export function seasonCommand(decoration: Decoration | null): string {
    return decoration
        ? `polaris season set ${decoration} ${SEASON_HOLD_SECONDS}`
        : "polaris season clear";
}
