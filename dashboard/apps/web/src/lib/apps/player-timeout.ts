/**
 * A ban that lifts itself, and the part of it a browser may hold.
 *
 * No game has one. Minecraft's `ban` is forever and `pardon` is a person
 * remembering; ARK's `BanPlayer` is the same bargain. So a timeout is the game's
 * own ban plus a note of when it ends, and something that comes back to lift it -
 * which is the shape an operator actually wants for "cool off for ten minutes",
 * and the reason a moderation screen ends up with a ban list full of people
 * nobody meant to exclude for good.
 *
 * The note lives in the install's config beside the server's other settings, so
 * there is no second store to keep true and nothing to migrate.
 *
 * Shared by every game rather than written per game: what a player is called
 * differs - a username in Minecraft, a Steam id in ARK - and nothing else here
 * does. The key is whatever that game bans by, compared case-insensitively so a
 * name typed back in a different case still finds its own note.
 *
 * Pure on purpose: the players tables read these in the browser, and none of it
 * may drag the database into a client bundle. Granting and lifting live in
 * `player-timeout-service.ts`.
 */

import type { InstallConfig } from "@/lib/apps/install-config";

/** Where the notes live inside the install's config. */
export const TIMEOUTS_KEY = "playerTimeouts";

/** The longest a timeout can run. Past a week it is not a cool-off, it is a ban,
 *  and it should be one that says so on the ban list. */
export const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;

export interface PlayerTimeout {
    /** Whatever the game bans by, as it was written to the ban list. */
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

/** How much of a timeout is left, in the same shape as how long ago. Shared so a
 *  badge reads identically whichever game drew it. */
export function timeoutRemaining(iso: string, now = Date.now()): string {
    const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
    if (minutes < 1) return "lifting now";
    if (minutes < 60) return `${minutes}m left`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours}h left` : `${Math.round(hours / 24)}d left`;
}
