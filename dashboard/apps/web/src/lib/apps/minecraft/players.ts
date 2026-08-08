/**
 * The five lists a game server keeps a player in, folded into one.
 *
 * Who is on, who is registered here, who is an operator, who is whitelisted, who
 * is banned - the game keeps them apart, and a screen that keeps them apart too
 * makes "what is going on with this person" a question you answer by reading five
 * lists and acting in whichever one happens to hold the verb. So they are folded
 * into a row per name carrying every state it is in.
 *
 * Pure on purpose, and split from `player-access.ts` for the same reason
 * `access.ts` is: this runs in the browser, on data the panel has already polled,
 * and none of it may drag the database or a session into a client bundle.
 */

import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import type { MinecraftRoster, MinecraftStatus } from "@/lib/apps/minecraft/service";

/** One person, with every list this server holds them in. */
export interface PlayerEntry {
    /** As the server spells it, which is whichever list named them first. */
    readonly name: string;
    readonly online: boolean;
    readonly operator: boolean;
    readonly whitelisted: boolean;
    /** The address they are registered to here, or null when they are not
     *  registered at all - a name the game knows and Polaris does not. */
    readonly address: string | null;
    readonly note: string | null;
    readonly banReason: string | null;
    readonly banned: boolean;
}

/**
 * Fold the server's lists into one row per player.
 *
 * Case-insensitively, because the lists do not agree: RCON echoes what the client
 * sent, the whitelist file holds what Mojang returned, and the access rules hold
 * what an operator typed. Three spellings of one person would be three rows, each
 * missing two thirds of what is true about them - and an operator would ban the
 * one that says "banned" while the player carried on under the one that does not.
 */
export function foldPlayers(
    status: MinecraftStatus | null,
    roster: MinecraftRoster | null,
    access: PlayerAccessView | null
): PlayerEntry[] {
    const byKey = new Map<string, PlayerEntry>();
    const upsert = (name: string, patch: Partial<PlayerEntry>): void => {
        const key = name.toLowerCase();
        const current = byKey.get(key) ?? {
            name,
            online: false,
            operator: false,
            whitelisted: false,
            address: null,
            note: null,
            banReason: null,
            banned: false
        };
        byKey.set(key, { ...current, ...patch });
    };

    for (const player of status?.players.players ?? []) upsert(player, { online: true });
    for (const rule of access?.rules ?? []) upsert(rule.username, { address: rule.address, note: rule.note });
    for (const player of roster?.ops ?? []) upsert(player, { operator: true });
    for (const player of roster?.whitelist ?? []) upsert(player, { whitelisted: true });
    for (const ban of roster?.bans ?? []) upsert(ban.name, { banned: true, banReason: ban.reason });

    // Online first - they are the ones something can be done about right now -
    // then alphabetically, so the list does not reshuffle as people come and go.
    return [...byKey.values()].sort((left, right) => {
        if (left.online !== right.online) return left.online ? -1 : 1;
        return left.name.localeCompare(right.name);
    });
}
