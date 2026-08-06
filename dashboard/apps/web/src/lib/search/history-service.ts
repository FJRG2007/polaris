/**
 * The account's copy of what it last searched for.
 *
 * Written only when a search finishes - a result opened, or a query run and kept
 * - never per keystroke, so the whole feature is one small write per deliberate
 * act. Repeats collapse onto the same row through the key the browser also uses,
 * which is what keeps the list a handful of recognizable things instead of the
 * same task nine times.
 *
 * Reads and writes are always scoped to the account that asked. There is no role
 * that reads somebody else's search history.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

function toRecent(row: {
    kind: string;
    scope: string | null;
    term: string;
    label: string;
    href: string | null;
    usedAt: Date;
}): core.RecentSearch | null {
    // Stored rows are read back through the same schema the browser's copy goes
    // through: a row written by an older build, or one whose scope no longer
    // exists, is dropped rather than drawn.
    const parsed = core.recentSearchSchema.safeParse(row);
    return parsed.success ? { ...parsed.data, usedAt: row.usedAt.toISOString() } : null;
}

export async function listRecentSearches(userId: string): Promise<core.RecentSearch[]> {
    const rows = await prisma.searchHistory.findMany({
        where: { userId },
        orderBy: { usedAt: "desc" },
        take: core.MAX_RECENT_SEARCHES,
        select: { kind: true, scope: true, term: true, label: true, href: true, usedAt: true }
    });
    return rows.map(toRecent).filter((entry): entry is core.RecentSearch => entry !== null);
}

/** Remember one search, and forget whatever fell off the end. */
export async function recordSearch(userId: string, input: core.RecentSearchInput): Promise<void> {
    const key = core.recentSearchKey(input);
    const usedAt = new Date();
    await prisma.searchHistory.upsert({
        where: { userId_key: { userId, key } },
        create: { userId, key, ...input, usedAt },
        update: { ...input, usedAt }
    });

    // Cheaper than it looks: the index is on (userId, usedAt), and there are at
    // most a couple of rows past the cap on any one write.
    const stale = await prisma.searchHistory.findMany({
        where: { userId },
        orderBy: { usedAt: "desc" },
        skip: core.MAX_RECENT_SEARCHES,
        select: { id: true }
    });
    if (stale.length > 0) {
        await prisma.searchHistory.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }
}

export async function forgetSearch(userId: string, key: string): Promise<void> {
    await prisma.searchHistory.deleteMany({ where: { userId, key } });
}

export async function clearSearchHistory(userId: string): Promise<void> {
    await prisma.searchHistory.deleteMany({ where: { userId } });
}
