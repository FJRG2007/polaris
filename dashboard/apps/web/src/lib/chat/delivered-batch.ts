/**
 * The second tick, said by the live stream rather than by a request back.
 *
 * Every device used to answer a message landing with a POST to
 * `/api/chat/delivered`: one request per online device per message, the
 * largest share of what one message in a busy room cost. The stream already
 * knows the moment a message is on a device's wire, so it says it here, and
 * every reader's acknowledgement of the same moment is gathered into one pass
 * a little later. `markDelivered` is the same write the route makes, so the
 * rules are unchanged: only the reader's own rows, never their own messages,
 * never a mark moved backwards.
 */

import { markDelivered } from "./delivered";

/** How long acknowledgements are gathered before they are written. */
export const DELIVERED_BATCH_MS = 1_000;
/** Conversations one account is acknowledged for per pass, most - the route's
 *  own ceiling (`MAX_CHAT_DELIVERED`). The rest wait for the next pass. */
const MOST_PER_ACCOUNT = 100;
/** Accounts written per pass, most. A pass that has more leaves them queued. */
const MOST_ACCOUNTS = 2_000;

const queued = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let writing = false;

/** Note that these conversations' latest messages are on this account's device. */
export function queueDelivered(userId: string, channelIds: readonly string[]): void {
    if (channelIds.length === 0) return;
    let set = queued.get(userId);
    if (!set) queued.set(userId, (set = new Set()));
    for (const id of channelIds) set.add(id);
    schedule();
}

function schedule(): void {
    if (timer || writing) return;
    timer = setTimeout(() => void flushDelivered(), DELIVERED_BATCH_MS);
    timer.unref?.();
}

/** Write what is queued now. Exported for tests and shutdown. */
export async function flushDelivered(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (writing) return;
    writing = true;
    try {
        let accounts = 0;
        for (const [userId, set] of queued) {
            if (accounts >= MOST_ACCOUNTS) break;
            accounts += 1;
            const ids = [...set].slice(0, MOST_PER_ACCOUNT);
            for (const id of ids) set.delete(id);
            if (set.size === 0) queued.delete(userId);
            // One account at a time: a pass is a background write, and it must
            // not take the pool the readers' own requests wait on.
            await markDelivered(userId, ids).catch((caught: unknown) => {
                console.error("polaris: could not mark messages delivered:", caught);
            });
        }
    } finally {
        writing = false;
        if (queued.size > 0) schedule();
    }
}

/** How many accounts wait to be acknowledged. For tests. */
export function queuedDeliveries(): number {
    return queued.size;
}
