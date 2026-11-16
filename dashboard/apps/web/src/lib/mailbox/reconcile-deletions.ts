/**
 * Messages that are no longer there.
 *
 * A uid search over the folder is one command and answers with numbers only, so
 * it is cheap enough to run every pass. Without it a message deleted from a
 * phone stays in this list for ever, which is the single most common complaint
 * about a mail client that caches.
 *
 * **Every row held, not only the newest window.** The sync keeps the newest
 * `WINDOW` of a folder, but scrolling to the bottom of a list brings older mail
 * down too, and those rows are just as cached. This used to check the newest
 * 400 rows alone, so a mailbox somebody had scrolled through kept every older
 * message they then deleted on their phone or in the provider's webmail - an
 * inbox showing mail deleted the day before, on every server and in every
 * language. The rows are walked in pages so a folder holding thousands costs a
 * few commands rather than one unbounded read.
 */

import { prisma } from "@polaris/db";
import type { ImapFlow } from "imapflow";
import { confirmedGone } from "./folder-window";

/** Rows compared per page: one SEARCH and at most one FETCH each. */
export const RECONCILE_PAGE = 2000;

/** Drop the rows of a folder whose message the server no longer holds there.
 *  Answers how many were dropped. */
export async function reconcileDeletions(
    client: Pick<ImapFlow, "search" | "fetch">,
    folder: { readonly id: string }
): Promise<number> {
    let dropped = 0;
    /** The lowest uid of the page before, so the next page reads below it. */
    let below: bigint | null = null;
    for (;;) {
        const held: { id: string; uid: bigint }[] = await prisma.mailMessage.findMany({
            where: { folderId: folder.id, ...(below === null ? {} : { uid: { lt: below } }) },
            select: { id: true, uid: true },
            orderBy: { uid: "desc" },
            take: RECONCILE_PAGE
        });
        if (held.length === 0) return dropped;
        const highest = held[0]?.uid ?? 0n;
        const lowest = held.at(-1)?.uid ?? highest;
        // The newest page reads to the end of the folder, so nothing arriving
        // in the meantime is mistaken for a gap.
        const range = below === null ? `${lowest}:*` : `${lowest}:${highest}`;
        const gone = await goneFromPage(client, held, range);
        if (gone === null) return dropped;
        if (gone.length > 0) {
            await prisma.mailMessage.deleteMany({ where: { id: { in: gone } } });
            dropped += gone.length;
        }
        if (held.length < RECONCILE_PAGE) return dropped;
        below = lowest;
    }
}

/** The ids of one page's rows the server confirms are gone, or null when it
 *  would not say - in which case nothing is dropped. */
async function goneFromPage(
    client: Pick<ImapFlow, "search" | "fetch">,
    held: readonly { id: string; uid: bigint }[],
    range: string
): Promise<string[] | null> {
    let present: number[] | false;
    try {
        present = await client.search({ uid: range }, { uid: true });
    } catch {
        return null;
    }
    if (present === false) return null;
    const alive = new Set(present);
    const candidates = held.filter((row) => !alive.has(Number(row.uid)));
    if (candidates.length === 0) return [];

    // A second opinion before anything is dropped: a fetch of exactly those
    // uids, a different command from the search. A search answered short would
    // otherwise empty the cache, and a dropped row is behind the cursor - no
    // later pass fetches it again.
    const stillThere = new Set<number>();
    try {
        const uids = candidates.map((row) => Number(row.uid)).join(",");
        for await (const message of client.fetch(uids, { uid: true }, { uid: true })) {
            stillThere.add(message.uid);
        }
    } catch {
        return null;
    }
    return confirmedGone(candidates, stillThere).map((row) => row.id);
}
