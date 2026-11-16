/**
 * Which messages the trash auto-empty may destroy.
 *
 * Two answers have to agree. The server's `SEARCH BEFORE` compares the date a
 * message arrived (INTERNALDATE, which a move keeps), so on its own it named an
 * old message binned this morning as a month in the bin. Polaris' own row knows
 * when the message entered the trash (`trashedAt`). A uid is due only when both
 * say so: the server still has it and it is old, and the row here says it has
 * been in the trash for the whole period.
 *
 * A uid with no row here, or a row with no date, is never due - it waits. That
 * is the direction a mistake has to fall in: a message kept a month too long is
 * a full trash, one destroyed early is gone.
 */
export function sweepableUids(
    serverOld: readonly number[],
    held: readonly { uid: bigint | number; trashedAt: Date | null }[],
    before: Date
): number[] {
    const binnedLongAgo = new Set(
        held
            .filter((row) => row.trashedAt !== null && row.trashedAt < before)
            .map((row) => Number(row.uid))
    );
    return [...new Set(serverOld)].filter((uid) => binnedLongAgo.has(uid));
}
