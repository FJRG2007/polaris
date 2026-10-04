/**
 * Flags written here and not yet on the mail server.
 *
 * Marking a message read writes the row first and tells the mail server after
 * the answer has gone (`setFlag` in `messages`). Between the two, a sync pass
 * that asks the server for flags hears the old ones - the server has not been
 * told yet - and used to write them back over the row: a message somebody had
 * just read went back to unread, and stayed so until the next pass after the
 * push landed. That is one of the ways "I opened it and it did not go read"
 * happened.
 *
 * So a flag is held from the moment it is written until its push has finished,
 * and a sync keeps the held value instead of the server's for that message and
 * that flag. Once the push is done - whether the server took it or not - the
 * hold goes, and the next pass reads the server's truth as always. A hold that
 * is never released (a push that hangs) lapses on its own.
 *
 * Process-wide, on `globalThis`, because the action that writes and the job that
 * syncs can be in different bundles of the same server.
 */

export type HeldFlagColumn = "seen" | "flagged" | "important";

/** How long a hold lasts if its push never reports back. */
export const FLAG_HOLD_MS = 5 * 60 * 1000;

type Holds = Map<string, Map<HeldFlagColumn, { value: boolean; until: number; token: symbol }>>;

const KEY = Symbol.for("polaris.mail.pending-flags");

function holds(): Holds {
    const slot = globalThis as unknown as Record<symbol, Holds | undefined>;
    slot[KEY] ??= new Map();
    return slot[KEY]!;
}

/**
 * Hold `column` at `value` on these messages until the returned release is
 * called. A newer hold on the same message and flag replaces this one, and this
 * one's release then leaves the newer one alone.
 */
export function holdFlag(
    messageIds: readonly string[],
    column: HeldFlagColumn,
    value: boolean,
    now: number = Date.now()
): () => void {
    const token = Symbol("hold");
    const all = holds();
    for (const id of messageIds) {
        const mine = all.get(id) ?? new Map();
        mine.set(column, { value, until: now + FLAG_HOLD_MS, token });
        all.set(id, mine);
    }
    return () => {
        for (const id of messageIds) {
            const mine = all.get(id);
            if (mine?.get(column)?.token !== token) continue;
            mine.delete(column);
            if (mine.size === 0) all.delete(id);
        }
    };
}

/** The flags held on one message right now, by column. */
export function heldFlags(
    messageId: string,
    now: number = Date.now()
): Partial<Record<HeldFlagColumn, boolean>> {
    const mine = holds().get(messageId);
    if (!mine) return {};
    const out: Partial<Record<HeldFlagColumn, boolean>> = {};
    for (const [column, hold] of mine) {
        if (hold.until > now) out[column] = hold.value;
        else mine.delete(column);
    }
    if (mine.size === 0) holds().delete(messageId);
    return out;
}
