/**
 * Keeping the number beside a folder honest between syncs.
 *
 * `MailFolder.unread` holds what the mail server itself last said, and it is
 * kept rather than counted here for a reason that has not changed: Polaris
 * caches a window of a mailbox, so counting the rows it happens to hold would
 * report a folder with nine thousand unread as the nine hundred that were
 * downloaded.
 *
 * But a number only a sync can move is a number that is wrong for as long as a
 * sync is away. Somebody opens a message, the row stops being bold, and the rail
 * beside it still says three - until the page is reloaded, which is exactly how
 * it was reported. A count that disagrees with the list next to it is worse than
 * a count that is a little behind the server, because the reader can see both.
 *
 * So the stored number is *nudged* by what this server just did - read one and
 * the folder is one fewer, move an unread message and the folder it left is one
 * fewer and the folder it arrived in is one more - rather than recomputed. The
 * base stays the server's own figure, the window problem stays solved, and the
 * next sync overwrites the whole thing with the truth either way.
 */

import { prisma } from "@polaris/db";

/** How many unread each folder gained or lost, keyed by folder id. */
export type UnreadDeltas = ReadonlyMap<string, number>;

/** Build one from a set of messages that were all moved the same way. */
export function unseenByFolder(
    messages: readonly { folderId: string; seen: boolean }[],
    sign: 1 | -1
): Map<string, number> {
    const deltas = new Map<string, number>();
    for (const message of messages) {
        if (message.seen) continue;
        deltas.set(message.folderId, (deltas.get(message.folderId) ?? 0) + sign);
    }
    return deltas;
}

/** Add one folder's change into a running map, dropping the zero. */
export function addDelta(deltas: Map<string, number>, folderId: string, by: number): void {
    if (by === 0) return;
    const next = (deltas.get(folderId) ?? 0) + by;
    if (next === 0) deltas.delete(folderId);
    else deltas.set(folderId, next);
}

/**
 * Apply them.
 *
 * Read then written rather than incremented in the statement, because the number
 * has a floor: a folder cannot hold minus one unread, and a mailbox whose window
 * disagrees with the server by a message would drive it there and leave it
 * there. Prisma has no portable clamp, and this table is small enough that a
 * read costs nothing worth trading correctness for.
 *
 * Never throws. This is the number beside a folder name; failing it must not
 * turn somebody's delete into an error.
 */
export async function nudgeFolderUnread(deltas: UnreadDeltas): Promise<void> {
    if (deltas.size === 0) return;
    try {
        const rows = await prisma.mailFolder.findMany({
            where: { id: { in: [...deltas.keys()] } },
            select: { id: true, unread: true }
        });
        await Promise.all(
            rows.map((row) => {
                const wanted = Math.max(0, row.unread + (deltas.get(row.id) ?? 0));
                if (wanted === row.unread) return null;
                return prisma.mailFolder.update({
                    where: { id: row.id },
                    data: { unread: wanted }
                });
            })
        );
    } catch (caught) {
        console.error(caught);
    }
}
