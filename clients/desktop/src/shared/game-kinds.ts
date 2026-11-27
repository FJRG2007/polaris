/**
 * What somebody said a listed program is, game or application, from a
 * launcher row's actions (Raycast's "Treat as Game" and "Treat as
 * Application", manual.raycast.com/games). What they said wins over how the
 * launcher sorts it by itself: a game is listed and drawn as one and found by
 * "games"; an application is not, and is left out of the game watcher, so it
 * never pauses the launcher's key in Game Mode.
 *
 * Kept by the program's listed `path` (a shortcut's path, a store's
 * `store:id`), which is unique per program and stable across listings.
 */

import { z } from "zod";

export type GameKind = "game" | "app";

/** A row's actions besides opening it, by id: what the page sends back, never a path. */
export const LAUNCHER_ROW_ACTIONS = ["treat-as-game", "treat-as-app"] as const;

export type LauncherRowAction = (typeof LAUNCHER_ROW_ACTIONS)[number];

/** The kind each action sets. */
export const ACTION_KIND: Readonly<Record<LauncherRowAction, GameKind>> = {
    "treat-as-game": "game",
    "treat-as-app": "app"
};

/** The most programs kept, so the file stays small whatever it is fed. */
export const MAX_GAME_KINDS = 2000;

/** The longest program path kept, as long as a listed path can be. */
const MAX_PATH_CHARS = 2048;

const entrySchema = z.tuple([z.string().min(1).max(MAX_PATH_CHARS), z.enum(["game", "app"])]);

/** The saved file, read without trusting it: a malformed entry is dropped, not the whole file. */
export function readGameKinds(raw: unknown): Map<string, GameKind> {
    const kinds = new Map<string, GameKind>();
    const file = z.object({ kinds: z.record(z.string(), z.unknown()) }).safeParse(raw);
    if (!file.success) return kinds;
    for (const entry of Object.entries(file.data.kinds)) {
        if (kinds.size >= MAX_GAME_KINDS) break;
        const parsed = entrySchema.safeParse(entry);
        if (parsed.success) kinds.set(parsed.data[0], parsed.data[1]);
    }
    return kinds;
}

/** What is written back: the same shape `readGameKinds` reads. */
export function writeGameKinds(kinds: ReadonlyMap<string, GameKind>): { version: 1; kinds: Record<string, GameKind>; } {
    return { version: 1, kinds: Object.fromEntries([...kinds].slice(0, MAX_GAME_KINDS)) };
}

/**
 * The kinds after one choice. A choice that matches what the program is by
 * itself drops its entry, so going back is going back to automatic, and the
 * newest choice is kept when the map is full (the oldest goes).
 */
export function withGameKind(kinds: ReadonlyMap<string, GameKind>, path: string, kind: GameKind, automatic: GameKind): Map<string, GameKind> {
    const next = new Map(kinds);
    next.delete(path);
    if (kind !== automatic) next.set(path, kind);
    while (next.size > MAX_GAME_KINDS) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
    }
    return next;
}

/** Whether a program is a game: what somebody said, else what the launcher found by itself. */
export function treatedAsGame(automatic: boolean, kind: GameKind | undefined): boolean {
    return kind ? kind === "game" : automatic;
}

/** The action a row offers: the other kind from the one it is drawn as. */
export function kindAction(game: boolean): LauncherRowAction {
    return game ? "treat-as-app" : "treat-as-game";
}
