/**
 * Where an account's Overview arrangement is kept.
 *
 * One JSON column on the user row, like the display and notification
 * preferences beside it, and read through React's request cache so a page that
 * asks twice still costs one query. It follows the account rather than the
 * browser deliberately: somebody who arranges their landing screen has arranged
 * it for themselves, not for the machine they happened to be at.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import {
    parseOverviewPreferences,
    stringifyOverviewPreferences,
    type OverviewPreferences
} from "@polaris/core";

export const getOverviewPreferences = cache(async (userId: string): Promise<OverviewPreferences> => {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { overviewPrefs: true } });
    return parseOverviewPreferences(row?.overviewPrefs);
});

export async function saveOverviewPreferences(userId: string, preferences: OverviewPreferences): Promise<void> {
    await prisma.user.update({
        where: { id: userId },
        data: { overviewPrefs: stringifyOverviewPreferences(preferences) }
    });
}
