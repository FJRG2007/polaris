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
import { loadEnv } from "@polaris/config";
import {
    parseOverviewPreferences,
    stringifyOverviewPreferences,
    type OverviewPreferences
} from "@polaris/core";

export const getOverviewPreferences = cache(
    async (userId: string): Promise<OverviewPreferences> => {
        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { overviewPrefs: true }
        });
        return parseOverviewPreferences(row?.overviewPrefs);
    }
);

/**
 * Change part of an account's arrangement from what is stored right now. The
 * Overview saves its cards and the apps' cards on separate actions that can
 * land together, so each one reads and writes under the user row's lock rather
 * than writing back a copy the other has since changed. Postgres only - the
 * local SQLite database has one writer at a time and no row locks to ask for.
 */
export async function updateOverviewPreferences(
    userId: string,
    change: (current: OverviewPreferences) => OverviewPreferences
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        if (loadEnv().POLARIS_DB_PROVIDER === "postgresql") {
            await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
        }
        const row = await tx.user.findUnique({
            where: { id: userId },
            select: { overviewPrefs: true }
        });
        await tx.user.update({
            where: { id: userId },
            data: {
                overviewPrefs: stringifyOverviewPreferences(
                    change(parseOverviewPreferences(row?.overviewPrefs))
                )
            }
        });
    });
}
