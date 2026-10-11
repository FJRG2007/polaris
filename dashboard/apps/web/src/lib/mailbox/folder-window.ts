/**
 * Keeping a folder's cached window whole.
 *
 * The cache only ever learns about mail by uid: a pass fetches what arrived past
 * the last uid it read, and drops a row the server no longer answers for. So a
 * row dropped by mistake - a search answered short, a move that the server said
 * yes to and did nothing with - is never fetched again, because its uid is behind
 * the cursor. An inbox of three thousand messages showed two that way.
 *
 * Pure, so the two decisions are asserted in a test rather than on a live
 * server: which rows a pass may really drop, and which uids of the newest window
 * are missing here.
 */

/**
 * The rows that are really gone: the ones a uid search did not list AND a fetch
 * of exactly those uids did not return. Two different commands have to agree
 * before a row is dropped, because a dropped row never comes back on its own.
 */
export function confirmedGone<T extends { uid: bigint | number }>(
    candidates: readonly T[],
    stillThere: ReadonlySet<number>
): T[] {
    return candidates.filter((row) => !stillThere.has(Number(row.uid)));
}

/**
 * The uids among the server's newest `window` that are not held here, newest
 * first. `serverUids` is what the server lists for the newest window, in any
 * order; `held` is what the cache has for the folder.
 */
export function missingFromWindow(
    serverUids: readonly number[],
    held: ReadonlySet<number>,
    window: number
): number[] {
    return [...new Set(serverUids)]
        .sort((left, right) => right - left)
        .slice(0, window)
        .filter((uid) => !held.has(uid));
}

/**
 * Whether a list that came back with nothing after it should reach the server
 * for older mail. Only the plain newest-first list of a folder or of a kind of
 * folder: a search, a filter or another order is a question about what is held,
 * not a request for more of it.
 */
export function reachesForOlder(list: {
    folderId: string | null;
    role: string | null;
    query: string;
    sort: string;
    labelId: string | null;
    unreadOnly: boolean;
    readOnly: boolean;
    starredOnly: boolean;
    importantOnly: boolean;
    snoozedOnly: boolean;
    withAttachments: boolean;
    category: string;
}): boolean {
    return (
        (list.folderId !== null || list.role !== null) &&
        list.query.trim() === "" &&
        list.sort === "newest" &&
        list.labelId === null &&
        !list.unreadOnly &&
        !list.readOnly &&
        !list.starredOnly &&
        !list.importantOnly &&
        !list.snoozedOnly &&
        !list.withAttachments &&
        list.category === ""
    );
}
