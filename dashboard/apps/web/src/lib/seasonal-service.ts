/**
 * Where the seasonal choices are kept: the operator's switch for the whole
 * deployment, and the pack each account turned off.
 *
 * The deployment's is a setting that is only ever written to say no - absent is
 * on - so an install that predates it decorates like every other, and turning it
 * off is one row. An account's is a nullable column; null follows the defaults
 * in @polaris/core.
 */

import { cache } from "react";
import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";

const SETTING_KEY = "seasonal.enabled";

/** Whether the operator lets seasons show at all on this deployment. */
export const seasonsAllowed = cache(async (): Promise<boolean> => (await getSetting(SETTING_KEY)) !== "off");

export async function setSeasonsAllowed(allowed: boolean): Promise<void> {
    await setSetting(SETTING_KEY, allowed ? null : "off");
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
