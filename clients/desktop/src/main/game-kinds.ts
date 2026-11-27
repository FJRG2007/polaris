/**
 * The launcher's "Treat as Game" and "Treat as Application" choices on this
 * computer (`shared/game-kinds`): one small file, read once and written on
 * each choice. Kept on the computer, like the launcher's use ranking, since
 * every key is this machine's own program path.
 */

import { app } from "electron";
import { join } from "node:path";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readGameKinds, withGameKind, writeGameKinds, type GameKind } from "@/shared/game-kinds";

let kinds: Map<string, GameKind> | null = null;
/** Bumped on each change, so what is worked out from the kinds is worked out again only then. */
let revision = 0;
const listeners = new Set<() => void>();

function file(): string {
    return join(app.getPath("userData"), "launcher-game-kinds.json");
}

/** Every choice made, by program path. */
export function gameKinds(): ReadonlyMap<string, GameKind> {
    if (kinds) return kinds;
    try {
        kinds = readGameKinds(JSON.parse(readFileSync(file(), "utf8")));
    } catch {
        // Missing or unreadable: no choices yet, rather than a launcher that fails.
        kinds = new Map();
    }
    return kinds;
}

/** Which change the kinds are at. */
export function gameKindsRevision(): number {
    return revision;
}

/** Called after each change, for the game watcher to look again. */
export function onGameKindsChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Say what the program at `path` is. `automatic` is what the launcher finds
 * it to be by itself: choosing that drops the choice. Saved by a write to a
 * temporary file renamed over the last, so a failed write never empties it.
 */
export function setGameKind(path: string, kind: GameKind, automatic: GameKind, now = Date.now()): void {
    kinds = withGameKind(gameKinds(), path, kind, automatic);
    revision += 1;
    const target = file();
    const temp = `${target}.${process.pid}.${now}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify(writeGameKinds(kinds)), { mode: 0o600 });
        renameSync(temp, target);
    } catch {
        // Kept in memory for this run; the next choice tries the file again.
        rmSync(temp, { force: true });
    }
    for (const listener of listeners) listener();
}
