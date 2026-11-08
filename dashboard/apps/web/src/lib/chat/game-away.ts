/**
 * Who is in a game played together here but away from it.
 *
 * The playing browser says so when its tab is hidden or its window has been in
 * the background for a while (`useGameAway`), on the same renewal that keeps
 * the seat - and again the moment it comes back. Held in this process only: it
 * is a hint about the next few minutes, a restart forgets it until the next
 * renewal, and a mark older than a pass is ignored so a browser that stopped
 * saying anything can never stay "Idle" forever.
 */

import { PASS_TTL_MS } from "./call-activity";

const HOLDER = Symbol.for("polaris.chat.gameAway");

function marks(): Map<string, number> {
    const holder = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
    return (holder[HOLDER] ??= new Map());
}

/** Note whether this player is away from the game they are seated in. */
export function noteGameAway(userId: string, away: boolean, now: number = Date.now()): void {
    if (away) marks().set(userId, now);
    else marks().delete(userId);
}

/** Whether this player said they were away, within a pass. */
export function isGameAway(userId: string, now: number = Date.now()): boolean {
    const at = marks().get(userId);
    if (at === undefined) return false;
    if (now - at > PASS_TTL_MS) {
        marks().delete(userId);
        return false;
    }
    return true;
}
