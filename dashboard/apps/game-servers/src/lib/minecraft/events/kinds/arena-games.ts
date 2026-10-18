/**
 * Every kind played in an arena through `ArenaGame` (`arena-game.ts`), by kind.
 * A kind not here - the team duel, the build battle, the king of the ring -
 * is played by `arena-service`'s own branches.
 */

import type { EventKind } from "../catalog";
import type { ArenaGame } from "./arena-game";
import { captureTheFlag } from "./capture-the-flag-service";
import { hotPotato } from "./hot-potato-service";
import { hideAndSeek } from "./hide-and-seek-service";
import { impostor } from "./impostor-service";
import { glassBridge } from "./glass-bridge-service";
import { pillars } from "./pillars-service";
import { skyWars } from "./sky-wars-service";
import { tugOfWar } from "./tug-of-war-service";

const GAMES: Partial<Record<EventKind, ArenaGame>> = {
    "capture-the-flag": captureTheFlag,
    "hide-and-seek": hideAndSeek,
    "glass-bridge": glassBridge,
    "hot-potato": hotPotato,
    impostor,
    pillars,
    "sky-wars": skyWars,
    "tug-of-war": tugOfWar
};

/** The kind's own game, or null for one `arena-service` plays itself. */
export function gameOf(kind: EventKind): ArenaGame | null {
    return GAMES[kind] ?? null;
}
