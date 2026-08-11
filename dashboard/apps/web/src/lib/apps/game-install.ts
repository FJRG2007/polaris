/**
 * Turning game servers on, and folding the old per-game apps into the one that
 * replaced them.
 *
 * Polaris used to install a manager per game: somebody who ran both had a
 * "Minecraft" app and an "ARK: Survival Evolved" app in their marketplace, both
 * of which ran nothing, next to the servers themselves. Now there is one app -
 * `game-servers` - and a game's own runtime arrives with the first server of it.
 *
 * The instances that already exist are the whole difficulty. Their manager rows
 * are what the Game servers page reads to decide it is on at all, and deleting
 * them would take the page away from people who are using it. So they are adopted
 * instead: the oldest one becomes the new app, keeping its id and therefore
 * whatever was granted on it, and the rest are retired. Nothing about the servers
 * themselves is touched - they are separate installs and always were.
 *
 * Idempotent, and cheap enough to run whenever one of those pages is opened,
 * which is how it reaches an instance whose owner never runs anything else.
 */

import { prisma } from "@polaris/db";
import { findApp } from "@/lib/apps/catalog";
import { installApp } from "@/lib/apps/install-service";
import { GAMES, GAME_SERVERS_APP_ID } from "@/lib/apps/games-catalog";

/** The apps that have ever meant "this Polaris can create game servers". */
function managerCatalogIds(): string[] {
    return [GAME_SERVERS_APP_ID, ...GAMES.map((game) => game.legacyManagerCatalogId)];
}

/**
 * The owner's Game servers install, adopting a per-game manager if that is all
 * they have. Null when they have never turned it on.
 *
 * Returns the install id rather than a boolean because it is also the answer to
 * "where does the marketplace's Open button go".
 */
export async function adoptGameServersApp(ownerId: string): Promise<string | null> {
    const rows = await prisma.installedApp.findMany({
        where: { ownerId, catalogId: { in: managerCatalogIds() }, status: { not: "removed" } },
        orderBy: { createdAt: "asc" },
        select: { id: true, catalogId: true }
    });
    const current = rows.find((row) => row.catalogId === GAME_SERVERS_APP_ID) ?? null;
    const legacy = rows.filter((row) => row.catalogId !== GAME_SERVERS_APP_ID);
    if (legacy.length === 0) return current?.id ?? null;

    // The oldest one is kept and becomes the new app, so an install that people
    // were given access to keeps the id those grants point at.
    const keep = current ?? legacy[0]!;
    if (current === null) {
        await prisma.installedApp.update({
            where: { id: keep.id },
            data: { catalogId: GAME_SERVERS_APP_ID, name: findApp(GAME_SERVERS_APP_ID)?.name ?? "Game servers" }
        });
    }
    const retired = legacy.filter((row) => row.id !== keep.id).map((row) => row.id);
    if (retired.length > 0) {
        // Marked removed rather than deleted, like every other uninstall here.
        // They ran nothing, so there is no container to tear down.
        await prisma.installedApp.updateMany({ where: { id: { in: retired } }, data: { status: "removed" } });
    }
    return keep.id;
}

/** Turn it on. Runs nothing: installing it is what makes this Polaris able to
 *  create servers, and each game's own runtime arrives with its first server. */
export async function installGameServersApp(ownerId: string, actorId: string): Promise<string> {
    const adopted = await adoptGameServersApp(ownerId);
    if (adopted) return adopted;
    const manifest = findApp(GAME_SERVERS_APP_ID);
    if (!manifest) throw new Error("Game servers is not in the catalog");
    const result = await installApp(ownerId, actorId, {
        catalogId: manifest.id,
        name: manifest.name,
        serverId: "local",
        storage: [],
        env: []
    });
    return result.installedAppId;
}
