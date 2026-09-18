/**
 * What has recently been handed out on a game server, most recent first.
 *
 * A picker's default used to be every item the game has, in whatever order the
 * catalogue lists them, which is a hundred-odd tiles that answer nobody's
 * question. What an operator reaches for is nearly always what they or somebody
 * else reached for last on this same server - a kit for a new player, the thing
 * being tested this evening - so that is what a picker opens on.
 *
 * Read from the audit log, which already records every give: a second table for
 * this would be a duplicate of a record that has to exist anyway. Shared by the
 * games rather than written per game, because only the name of the action and the
 * shape of an item id differ between them.
 */

import { prisma } from "@polaris/db";

export async function recentlyGivenItems(
    /** The audited action to read, `minecraft.give` or `games.ark.give`. */
    action: string,
    installedAppId: string,
    /** The id in the form the caller uses it, or null for one it does not
     *  recognise - an item from a build before a rename, say. */
    normalize: (raw: string) => string | null,
    limit = 12
): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
        where: { action, targetId: installedAppId },
        orderBy: { at: "desc" },
        // Enough history that a handful of repeats of one item still leave room
        // for the ones before it, without reading the whole log.
        take: limit * 12,
        select: { metadata: true }
    });
    const seen: string[] = [];
    for (const row of rows) {
        if (!row.metadata) continue;
        let item: unknown;
        try {
            item = (JSON.parse(row.metadata) as { item?: unknown }).item;
        } catch {
            continue;
        }
        if (typeof item !== "string") continue;
        const id = normalize(item);
        if (!id || seen.includes(id)) continue;
        seen.push(id);
        if (seen.length === limit) break;
    }
    return seen;
}
