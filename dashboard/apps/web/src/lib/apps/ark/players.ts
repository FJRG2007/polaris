/**
 * Everyone an ARK server knows about, as one row per person.
 *
 * The server keeps two lists that answer different halves of the same question -
 * who is on right now, and who is allowed on at all - and a card per list means
 * reading both to work out what is going on with somebody, then acting in
 * whichever one happens to hold the verb. So they are folded into one row per
 * Steam id carrying every state it is in, the same shape the Minecraft table
 * settled on for its five.
 *
 * The Steam id is the identity and the name is decoration. A character can be
 * renamed at will and two people can pick the same one, so a row is keyed by the
 * number and shows whichever name it has - the one the server reported when they
 * are on, and the one whoever added them typed when they are not.
 */

import type { ArkPlayer } from "@/lib/apps/ark/parse";
import type { ArkAllowedPlayer } from "@/lib/apps/ark/access";

/** How far a player has got with the allow list. */
export type ArkStanding =
    /** Not on it. With the server closed, they cannot join. */
    | "not-allowed"
    /** On it here, but the server has not been told - it was down or still
     *  installing. The distinction is the whole reason this is three states. */
    | "waiting"
    /** On it, and the running server knows. */
    | "allowed";

export interface ArkPlayerEntry {
    readonly steamId: string;
    readonly name: string;
    readonly online: boolean;
    readonly standing: ArkStanding;
    /** When they were added to the list, for the rows that were. */
    readonly addedAt: string | null;
}

/** Everyone the server knows about, whoever is playing first and then by name -
 *  which is the order somebody scanning for a person actually needs. */
export function foldArkPlayers(
    online: readonly ArkPlayer[],
    allowList: readonly ArkAllowedPlayer[]
): ArkPlayerEntry[] {
    const byId = new Map<string, ArkPlayerEntry>();
    for (const player of allowList) {
        byId.set(player.steamId, {
            steamId: player.steamId,
            name: player.label || player.steamId,
            online: false,
            standing: player.appliedAt === null ? "waiting" : "allowed",
            addedAt: player.addedAt
        });
    }
    for (const player of online) {
        const known = byId.get(player.steamId);
        byId.set(player.steamId, {
            steamId: player.steamId,
            // The server's own name wins: it is the one they are playing under.
            name: player.name || known?.name || player.steamId,
            online: true,
            standing: known?.standing ?? "not-allowed",
            addedAt: known?.addedAt ?? null
        });
    }
    return [...byId.values()].sort((left, right) => {
        if (left.online !== right.online) return left.online ? -1 : 1;
        return left.name.localeCompare(right.name);
    });
}

/** Whether a row matches what somebody typed into the search box. The id counts:
 *  it is what a moderator has been handed when somebody reports a player. */
export function matchesArkPlayer(entry: ArkPlayerEntry, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return true;
    return entry.name.toLowerCase().includes(needle) || entry.steamId.includes(needle);
}
