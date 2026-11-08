/**
 * Where the seasonal choices are kept: the operator's switch for the whole
 * deployment, and the pack each account turned off.
 *
 * The deployment's is a setting that is only ever written to say no - absent is
 * on - so an install that predates it decorates like every other, and turning it
 * off is one row. An account's is a nullable column; null follows the defaults
 * in @polaris/core.
 *
 * The calendar - each season's window and whether it runs - is one more setting,
 * holding only what an admin changed: absent is the dates Polaris ships with, so
 * an install that never opened the list keeps them. `seasonCalendar` is the one
 * reader; the frame, the sounds and the game servers all decide by it.
 */

import { cache } from "react";
import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { getSetting, setSetting, swapSetting } from "@/lib/setting-store";

const SETTING_KEY = "seasonal.enabled";
const CALENDAR_KEY = "seasonal.calendar";

/** Whether the operator lets seasons show at all on this deployment. */
export const seasonsAllowed = cache(
    async (): Promise<boolean> => (await getSetting(SETTING_KEY)) !== "off"
);

export async function setSeasonsAllowed(allowed: boolean): Promise<void> {
    await setSetting(SETTING_KEY, allowed ? null : "off");
}

/** What an admin changed of the calendar, read back season by season. */
export const seasonOverrides = cache(async (): Promise<core.SeasonOverrides> =>
    core.parseSeasonOverrides(await getSetting(CALENDAR_KEY))
);

/** The calendar every reader decides by: the shipped windows with an admin's
 *  changes on top. */
export const seasonCalendar = cache(async (): Promise<core.SeasonCalendar> =>
    core.resolveSeasonCalendar(await seasonOverrides())
);

/** How many times a save reads again after another admin's save landed first. */
const SAVE_ATTEMPTS = 5;

/**
 * Store one season's rule, checked against the calendar as it is when it is
 * written rather than as it was read earlier. A rule that is the defaults is
 * forgotten rather than kept.
 *
 * The stored calendar is one value, so two admins saving different seasons at
 * once would otherwise each write their own copy and one change would be lost
 * - or two windows that overlap would each pass a check made before the other
 * landed. The write only lands if the value is still the one read; whoever
 * loses reads again and is checked again.
 */
export async function saveSeasonRule(
    season: core.Season,
    rule: core.SeasonRule
): Promise<{ calendar: core.SeasonCalendar } | { clash: core.Season }> {
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
        const stored = await getSetting(CALENDAR_KEY);
        const overrides: core.SeasonOverrides = { ...core.parseSeasonOverrides(stored) };
        const clash = core.seasonOverlaps(
            { ...core.resolveSeasonCalendar(overrides), [season]: rule },
            season
        )[0];
        if (clash) return { clash };
        const override = core.overrideOf(season, rule);
        if (override) overrides[season] = override;
        else delete overrides[season];
        // "{}" rather than forgetting the key: the swap needs a value to land on,
        // and an empty calendar reads back as the shipped one either way.
        if (await swapSetting(CALENDAR_KEY, stored, JSON.stringify(overrides)))
            return { calendar: core.resolveSeasonCalendar(overrides) };
    }
    throw new Error("seasonal calendar kept changing under the save");
}

/** What an account chose, memoized per request. */
export const getSeasonalChoice = cache(async (userId: string): Promise<core.SeasonalChoice> => {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { seasonal: true } });
    return core.parseSeasonalPrefs(row?.seasonal);
});

/** Store a choice the caller has already validated. It replaces what was kept:
 *  an account only ever has one pack turned off, the one in force. */
export async function saveSeasonalChoice(
    userId: string,
    choice: core.SeasonalPrefs
): Promise<core.SeasonalChoice> {
    const next: core.SeasonalChoice = { mutedPack: choice.mutedPack };
    await prisma.user.update({ where: { id: userId }, data: { seasonal: JSON.stringify(next) } });
    return next;
}
