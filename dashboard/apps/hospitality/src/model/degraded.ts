/**
 * What a Hospitality screen tells the people using it about the connection:
 * everything live, work waiting to be sent, or no server at all. Pure, so the
 * banner and the tests agree on it.
 *
 * - `live`: the server answered last time and nothing waits.
 * - `syncing`: the server answers, and queued work is still going out.
 * - `offline`: the network is gone or the server did not answer (restarting,
 *   updating, down). The screen keeps what it last showed, orders and payments
 *   are kept on the device and sent, in order, once it answers again.
 */

export type Degraded = "live" | "syncing" | "offline";

export interface ConnectionFacts {
    /** What the browser says about the network (`navigator.onLine`). */
    readonly online: boolean;
    /** Whether the last call to the server got an answer, either way. */
    readonly reachable: boolean;
    /** Operations queued on this device, not yet answered. */
    readonly waiting: number;
}

export function degradedState(facts: ConnectionFacts): Degraded {
    if (!facts.online || !facts.reachable) return "offline";
    return facts.waiting > 0 ? "syncing" : "live";
}
