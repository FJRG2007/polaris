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

/** Write what the server just answered. Only players it answered for. */
export async function rememberLevels(
    installedAppId: string,
    levels: Readonly<Record<string, number>>,
    at: Date = new Date()
): Promise<void> {
    const entries = Object.entries(levels).filter(
        ([, level]) => Number.isInteger(level) && level >= 0
    );
    await Promise.all(
        entries.map(([username, level]) =>
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
