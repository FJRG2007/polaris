/**
 * What somebody has decided about their game servers: which are kept at the top,
 * and which are put away.
 *
 * Per viewer, never per server. The same server is the one its owner lives in and
 * one of four somebody else was invited to help with, so "favourite" and
 * "archived" are statements about a list rather than about a machine - and a
 * server put away by one person goes on running, and goes on being listed, for
 * everyone else.
 *
 * A row exists only where somebody has said something. Saying nothing is the
 * default, so nothing is written when a server is created, and an opinion put back
 * to nothing takes its row with it rather than leaving a row of two falses behind.
 */

import { prisma } from "@polaris/db";

/** One person's standing opinion of one server. */
export interface GameServerPrefs {
    readonly favorite: boolean;
    readonly archived: boolean;
}

/** What a server nobody has said anything about is. */
export const NO_GAME_SERVER_PREFS: GameServerPrefs = { favorite: false, archived: false };

/**
 * The opinions this person holds about these servers, keyed by install id.
 *
 * Read for the whole list at once rather than per row, and never a reason to fail
 * the page: a list with no favourites in it is a worse answer than the right list,
 * but it is a far better one than no list at all.
 */
export async function readGameServerPrefs(
    userId: string,
    installedAppIds: readonly string[]
): Promise<Map<string, GameServerPrefs>> {
    if (installedAppIds.length === 0) return new Map();
    const rows = await prisma.gameServerPref
        .findMany({
            where: { userId, installedAppId: { in: [...installedAppIds] } },
            select: { installedAppId: true, favorite: true, archived: true }
        })
        .catch(() => []);
    return new Map(rows.map((row) => [row.installedAppId, { favorite: row.favorite, archived: row.archived }]));
}

/** One person's opinion of one server, for a caller holding a single id. */
export async function readGameServerPref(userId: string, installedAppId: string): Promise<GameServerPrefs> {
    return (await readGameServerPrefs(userId, [installedAppId])).get(installedAppId) ?? NO_GAME_SERVER_PREFS;
}

/**
 * Record part of an opinion, leaving the rest of it alone.
 *
 * Merged rather than replaced, because the two halves are set from different
 * controls: starring a server from the row must not quietly take it out of the
 * archive, and putting one away must not unstar it.
 */
export async function setGameServerPref(
    userId: string,
    installedAppId: string,
    patch: Partial<GameServerPrefs>
): Promise<GameServerPrefs> {
    const current = await readGameServerPref(userId, installedAppId);
    const next: GameServerPrefs = { ...current, ...patch };
    // An opinion put back to nothing is not an opinion. Keeping the row would
    // leave a table of falses that mean exactly what no row means.
    if (!next.favorite && !next.archived) {
        await prisma.gameServerPref.deleteMany({ where: { userId, installedAppId } });
        return NO_GAME_SERVER_PREFS;
    }
    await prisma.gameServerPref.upsert({
        where: { userId_installedAppId: { userId, installedAppId } },
        create: { userId, installedAppId, ...next },
        update: next
    });
    return next;
}

/** Forget every opinion of a server that no longer exists. */
export async function clearGameServerPrefs(installedAppId: string): Promise<void> {
    await prisma.gameServerPref.deleteMany({ where: { installedAppId } }).catch(() => undefined);
}
