/**
 * Where the apps somebody pinned to the switcher are kept.
 *
 * On the account rather than in the browser, like the Overview arrangement
 * beside it: a pin is a choice somebody made about their own Polaris, and it
 * should be there on the next machine they sign in on. The recent apps that fill
 * the rest of the row are the opposite - one browser's history - and never reach
 * the server (see `app-launcher`).
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import { parseFavoriteApps } from "@/lib/app-launcher";

export const getFavoriteApps = cache(async (userId: string): Promise<string[]> => {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { favoriteApps: true }
    });
    return parseFavoriteApps(row?.favoriteApps);
});

export async function saveFavoriteApps(
    userId: string,
    favorites: readonly string[]
): Promise<void> {
    await prisma.user.update({
        where: { id: userId },
        data: { favoriteApps: favorites.length > 0 ? JSON.stringify(favorites) : null }
    });
}
