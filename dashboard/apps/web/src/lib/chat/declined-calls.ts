/**
 * The calls each account declined a moment ago, so a device that missed the
 * frame saying so still stops ringing.
 *
 * Declining publishes `call-settled` to every open stream of the account, and a
 * frame is gone the instant it is sent: a device whose stream was reconnecting
 * then - a laptop waking, a phone's tab coming back, the tab holding the shared
 * connection handing it to another - never heard it, and rang on for the whole
 * ring while the desktop that hung up was silent. Every ringing device already
 * asks `api/chat/meetings/elsewhere` every few seconds; this is what that answer
 * now carries too.
 *
 * In process memory, like the stream it backs (`live`), and only for as long as
 * a call rings: after that nothing is ringing to stop.
 */

import { setBounded } from "@/lib/bounded-map";

/** Longer than any ring (`RING_FOR_MS`, 45 s), with room for a slow device. */
export const DECLINE_KEPT_MS = 90_000;

/** Accounts remembered at once; a burst beyond it forgets the oldest. */
const MAX_ACCOUNTS = 5_000;
/** Calls remembered per account: more than anybody declines in 90 seconds. */
const MAX_PER_ACCOUNT = 20;

const REGISTRY = Symbol.for("polaris.chat.declined-calls");

type Declines = Map<string, Map<string, number>>;

function declines(): Declines {
    const holder = globalThis as { [REGISTRY]?: Declines };
    holder[REGISTRY] ??= new Map();
    return holder[REGISTRY];
}

/** Note that this account declined this call, on whichever device. */
export function rememberDecline(userId: string, meetingId: string, now = Date.now()): void {
    const all = declines();
    const mine = new Map(
        [...(all.get(userId) ?? new Map<string, number>())].filter(
            ([, at]) => now - at < DECLINE_KEPT_MS
        )
    );
    setBounded(mine, meetingId, now, { maxEntries: MAX_PER_ACCOUNT });
    setBounded(all, userId, mine, { maxEntries: MAX_ACCOUNTS });
}

/** The calls this account declined within the ring, newest last. */
export function declinedCalls(userId: string, now = Date.now()): string[] {
    const mine = declines().get(userId);
    if (!mine) return [];
    return [...mine].filter(([, at]) => now - at < DECLINE_KEPT_MS).map(([meetingId]) => meetingId);
}
