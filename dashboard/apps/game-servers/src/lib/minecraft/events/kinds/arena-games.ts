/**
 * Every kind played in an arena through `ArenaGame` (`arena-game.ts`), by kind.
 * A kind not here - the team duel, the build battle, the king of the ring -
 * is played by `arena-service`'s own branches.
 */

import type { EventKind } from "../catalog";
import type { ArenaGame } from "./arena-game";
import { captureTheFlag } from "./capture-the-flag-service";
import { hotPotato } from "./hot-potato-service";

const GAMES: Partial<Record<EventKind, ArenaGame>> = {
    "capture-the-flag": captureTheFlag,
    "hot-potato": hotPotato
};

/** The kind's own game, or null for one `arena-service` plays itself. */
export function gameOf(kind: EventKind): ArenaGame | null {
    return GAMES[kind] ?? null;
}
