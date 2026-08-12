/**
 * What this instance has that an Overview card can be about.
 *
 * Separate from the catalogue because the catalogue is read in the browser - it
 * carries the labels and the icons - and this asks the database. A card that
 * names a feature is offered only where that feature exists, so an instance that
 * has never installed a game server neither draws the card nor lists it in the
 * customize panel.
 *
 * The permission is asked separately and means something different: whether this
 * account may know. Both have to pass, and it is the permission that takes a card
 * away from somebody who had it.
 */

import { prisma } from "@polaris/db";
import { isGameServerApp } from "@/lib/apps/games-service";
import type { OverviewFeatures } from "@/lib/overview/catalog";

/**
 * Whether this account has any game server at all - one it owns, or one it was
 * given. Read as ids and catalog ids rather than through the game-server listing,
 * which resolves addresses and machines for every install: the question here is
 * only whether the answer would be empty.
 */
async function hasGameServer(userId: string): Promise<boolean> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId: userId, status: { not: "removed" } },
        select: { catalogId: true }
    });
    return installs.some((install) => isGameServerApp(install.catalogId));
}

export async function overviewFeatures(userId: string): Promise<OverviewFeatures> {
    return { games: await hasGameServer(userId) };
}
