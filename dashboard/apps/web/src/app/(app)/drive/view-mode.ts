/**
 * The layout a folder was last shown in, remembered per folder on this device.
 *
 * In the browser rather than in the person's Drive settings: it is a viewing
 * convenience - which way this screen shows this folder - and a row per folder
 * anybody ever opened has no business in the database. Bounded, so a person who
 * browses thousands of folders keeps the most recent ones and nothing grows
 * without end. Every read and write survives storage being unavailable (a
 * private window, blocked site data): the folder then simply opens in its
 * default layout.
 */

export type DriveViewMode = "list" | "grid" | "photos";

const KEY = "polaris.drive.viewModes";

/** How many folders are remembered. The oldest choice is dropped first. */
export const REMEMBERED_FOLDERS = 300;

const MODES: readonly DriveViewMode[] = ["list", "grid", "photos"];

function folderKey(connectionId: string, path: string): string {
    return `${connectionId}:${path}`;
}

function readAll(): [string, DriveViewMode][] {
    try {
        const raw = window.localStorage.getItem(KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (pair): pair is [string, DriveViewMode] =>
                Array.isArray(pair) &&
                typeof pair[0] === "string" &&
                MODES.includes(pair[1] as DriveViewMode)
        );
    } catch {
        return [];
    }
}

/** The layout this folder was last left in, or null when nobody chose one. */
export function rememberedViewMode(connectionId: string, path: string): DriveViewMode | null {
    const key = folderKey(connectionId, path);
    return readAll().find(([folder]) => folder === key)?.[1] ?? null;
}

/** Remember a layout chosen for this folder, most recent last. */
export function rememberViewMode(connectionId: string, path: string, mode: DriveViewMode): void {
    const key = folderKey(connectionId, path);
    const kept = readAll().filter(([folder]) => folder !== key);
    kept.push([key, mode]);
    try {
        window.localStorage.setItem(KEY, JSON.stringify(kept.slice(-REMEMBERED_FOLDERS)));
    } catch {
        // Storage refused: the choice lasts as long as this page does.
    }
}
