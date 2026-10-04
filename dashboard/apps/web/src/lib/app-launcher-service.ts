/**
 * Where the apps somebody chose as favorites, and the order they arranged the
 * app menu in, are kept.
 *
 * On the account rather than in the browser, like the Overview arrangement
 * beside it: a favorite or an arrangement is a choice somebody made about their
 * own Polaris, and it should be there on the next machine they sign in on. How
 * much each app is used is the opposite - one browser's history - and never
 * reaches the server (see `app-usage`).
 *
 * Both live in the one column the favorites always had (see
 * `serializeLauncherPrefs` for the two shapes it holds).
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import { parseLauncherPrefs, serializeLauncherPrefs, type LauncherPrefs } from "@/lib/app-launcher";

export const getLauncherPrefs = cache(async (userId: string): Promise<LauncherPrefs> => {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { favoriteApps: true }
    });
    return parseLauncherPrefs(row?.favoriteApps);
});

export async function saveLauncherPrefs(userId: string, prefs: LauncherPrefs): Promise<void> {
    await prisma.user.update({
        where: { id: userId },
        data: { favoriteApps: serializeLauncherPrefs(prefs) }
    });
}
