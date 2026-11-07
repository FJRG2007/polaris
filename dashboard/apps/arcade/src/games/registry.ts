/**
 * Every game the app offers. A game is one folder under `src/games` with its
 * definition, and one line here; its code is never part of the app's screens -
 * it is loaded into a frame only when somebody opens it.
 */

import type { GameDefinition } from "./types";
import { newYork } from "./new-york/definition";

export const GAMES: readonly GameDefinition[] = [newYork];

/** The game with this id, or null. */
export function findGame(id: string): GameDefinition | null {
    return GAMES.find((game) => game.id === id) ?? null;
}

/** Where a game's page is served, from the app's bundle. */
export function gameFrameSrc(game: GameDefinition): string {
    return `/api/app-bundles/arcade/current/assets/${game.id}/index.html`;
}

/** Where a game's cover is served, from the same folder as its page; null for a game without one. */
export function gameCoverSrc(game: GameDefinition): string | null {
    return game.cover ? `/api/app-bundles/arcade/current/assets/${game.id}/${game.cover}` : null;
}
