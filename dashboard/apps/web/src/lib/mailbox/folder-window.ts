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
 *
 * Nothing at or past `cursor` - the uid the arrivals pass reads from next. That
 * mail has not arrived here yet, and whatever stores it decides whether the
 * filters, the junk check and the away reply ever see it: put back as old mail,
 * a message that came in between two passes was filed by nothing.
 */
export function missingFromWindow(
    serverUids: readonly number[],
    held: ReadonlySet<number>,
    window: number,
    cursor: number = Number.POSITIVE_INFINITY
): number[] {
    return [...new Set(serverUids)]
        .sort((left, right) => right - left)
        .slice(0, window)
        .filter((uid) => !held.has(uid) && uid < cursor);
}

/**
 * Where the arrivals pass reads from next: past what it fetched, and past what
 * the server said was next when the pass began - never past a message it has
 * not stored. The server's own count moves while a pass runs, and moving the
 * cursor to it would step over whatever came in after the fetch, which then
 * only ever came back as old mail.
 */
export function nextCursor(seenAtStart: number, fetchedUids: readonly number[]): number {
    return fetchedUids.reduce((next, uid) => Math.max(next, uid + 1), seenAtStart);
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
