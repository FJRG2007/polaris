/**
 * A ban that lifts itself, and the part of it a browser may hold.
 *
 * Minecraft has no such thing: `ban` is forever and `pardon` is a person
 * remembering. So a timeout is the game's own ban plus a note of when it ends,
 * and something that comes back to lift it - which is the shape an operator
 * actually wants for "cool off for ten minutes", and the reason a moderation
 * screen ends up with a ban list full of people nobody meant to exclude for good.
 *
 * The note lives in the install's config beside the server's other settings, so
 * there is no second store to keep true and nothing to migrate.
 *
 * Pure on purpose, like `players.ts` and `sessions.ts` beside it: the players
 * table reads these in the browser, and none of it may drag the database into a
 * client bundle. Granting and lifting live in `timeout-service.ts`.
 */

import type { InstallConfig } from "@/lib/apps/install-config";

/** Where the notes live inside the install's config. */
export const TIMEOUTS_KEY = "playerTimeouts";

/** The longest a timeout can run. Past a week it is not a cool-off, it is a ban,
 *  and it should be one that says so on the ban list. */
export const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;

export interface PlayerTimeout {
    /** As it was typed, which is what the ban list holds. */
    readonly player: string;
    /** When it lifts, ISO 8601. */
    readonly until: string;
}

/** The timeouts recorded on this install. Anything malformed is dropped rather
 *  than thrown over: it is a settings blob, and one bad entry must not take the
 *  players screen down with it. */
export function readTimeouts(config: InstallConfig): PlayerTimeout[] {
    const raw = config[TIMEOUTS_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const { player, until } = entry as { player?: unknown; until?: unknown };
        if (typeof player !== "string" || typeof until !== "string") return [];
        return Number.isNaN(Date.parse(until)) ? [] : [{ player, until }];
    });
}

/** The timeout on one player, when they are under one. */
export function timeoutFor(timeouts: readonly PlayerTimeout[], player: string): PlayerTimeout | null {
    const key = player.toLowerCase();
    return timeouts.find((entry) => entry.player.toLowerCase() === key) ?? null;
}

