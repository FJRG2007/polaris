/**
 * Read a move's destination until what was moved is there.
 *
 * Seen on IONOS: a message put in the trash often showed in the trash only when
 * the next one was binned. The read of the destination right after the move
 * opened it on a fresh connection, and that session was not yet shown the
 * message - a clustered server answers the new session from before the move
 * landed - so it stored nothing and the trash waited for the next pass.
 *
 * Where the server said which uids the move gave the messages (COPYUID, RFC
 * 4315), the read is repeated a few times, a moment apart, until every one of
 * them is stored. Without that answer there is nothing to wait for and the read
 * runs once, as before.
 */

/** Reads of the destination, the first included. */
export const LANDING_TRIES = 4;

/** Between two reads. */
export const LANDING_WAIT_MS = 1500;

export async function readUntilLanded(
    expected: readonly number[],
    /** One read of the destination; answers which of `expected` are stored. */
    read: (attempt: number) => Promise<ReadonlySet<number>>,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<boolean> {
    for (let attempt = 0; attempt < LANDING_TRIES; attempt += 1) {
        if (attempt > 0) await wait(LANDING_WAIT_MS);
        const stored = await read(attempt);
        if (expected.every((uid) => stored.has(uid))) return true;
    }
    return false;
}
