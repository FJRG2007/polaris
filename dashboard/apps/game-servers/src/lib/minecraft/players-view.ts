/**
 * The players table between one read and the next.
 *
 * Its rows are folded from several reads that land one after another - who is
 * on, the server's lists, who may connect - and each one landing re-sorted the
 * table: everybody offline first, then the ones on jumping to the top, then the
 * registered ones appearing in between. So until every read is in, the table
 * shows the last whole list it drew, kept for a short while, and only swaps it
 * once the new one is whole. The order then moves only when the players do.
 *
 * Pure.
 */

import type { PlayerEntry } from "./players";

/** How long the last whole list is worth showing before a fresh read. */
export const KEPT_PLAYERS_MS = 60_000;

/** The most rows a kept list carries: the first screenfuls are what a reload
 *  needs, and a server of thousands must not fill the browser's storage. */
export const MAX_KEPT_PLAYERS = 500;

/** Rows drawn at a time; more are drawn on request. */
export const PLAYER_ROWS_STEP = 200;

/** Whether every read the table folds has answered. A stopped server answers
 *  no roster at all, which is a whole answer rather than a missing one. */
export function playersComplete(input: {
    readonly status: { readonly answering: boolean } | null;
    readonly roster: unknown;
    readonly access: unknown;
}): boolean {
    if (input.status === null || input.access === null) return false;
    return input.roster !== null || !input.status.answering;
}

/** A list worth keeping: the first rows, without the session history that only
 *  the history dialog reads, and which a fresh read brings back anyway. */
export function keptPlayers(players: readonly PlayerEntry[]): PlayerEntry[] {
    return players.slice(0, MAX_KEPT_PLAYERS).map((player) => ({ ...player, sessions: [] }));
}

/** The rows to draw: the fresh fold once it is whole, the kept one before. */
export function playersOnScreen(
    fresh: readonly PlayerEntry[],
    kept: readonly PlayerEntry[] | null,
    complete: boolean
): readonly PlayerEntry[] {
    return complete || !kept || kept.length === 0 ? fresh : kept;
}
