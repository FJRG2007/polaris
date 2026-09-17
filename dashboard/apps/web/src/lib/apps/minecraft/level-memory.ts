/**
 * The last experience level each player was seen on.
 *
 * A level can only be asked of somebody standing on the server, so it is kept
 * from the last time they were: the table shows it for everyone, and says how
 * old it is for somebody who is not on.
 */

import { prisma } from "@polaris/db";

/** A level Polaris remembers, and when the server said it. */
export interface RememberedLevel {
    readonly level: number;
    readonly at: string;
}

/** How long an unchanged level goes without its date being written again. The
 *  screen polls every twelve seconds per reader, so a poll must not be a write
 *  per player, and the date under somebody who just left is out by at most this. */
const REFRESH_MS = 10 * 60 * 1000;

/** Write what the server just answered. Only players it answered for, and only
 *  those whose level changed or whose date has gone stale. */
export async function rememberLevels(
    installedAppId: string,
    levels: Readonly<Record<string, number>>,
    at: Date = new Date()
): Promise<void> {
    const entries = Object.entries(levels).filter(
        ([, level]) => Number.isInteger(level) && level >= 0
    );
    if (entries.length === 0) return;
    const kept = await prisma.gamePlayerStat.findMany({
        where: { installedAppId, username: { in: entries.map(([username]) => username) } },
        select: { username: true, level: true, levelAt: true }
    });
    const known = new Map(kept.map((row) => [row.username, row]));
    const changed = entries.filter(([username, level]) => {
        const row = known.get(username);
        return !row || row.level !== level || at.getTime() - row.levelAt.getTime() >= REFRESH_MS;
    });
    await Promise.all(
        changed.map(([username, level]) =>
            prisma.gamePlayerStat.upsert({
                where: { installedAppId_username: { installedAppId, username } },
                create: { installedAppId, username, level, levelAt: at },
                update: { level, levelAt: at }
            })
        )
    );
}

/** Every level remembered for this server, by name as the server reported it. */
export async function rememberedLevels(
    installedAppId: string
): Promise<Record<string, RememberedLevel>> {
    const rows = await prisma.gamePlayerStat.findMany({
        where: { installedAppId },
        select: { username: true, level: true, levelAt: true }
    });
    return Object.fromEntries(
        rows.map((row) => [row.username, { level: row.level, at: row.levelAt.toISOString() }])
    );
}
