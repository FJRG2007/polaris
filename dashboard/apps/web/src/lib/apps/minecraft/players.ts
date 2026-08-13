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
import { playerActivity, sessionsByPlayer, type PlayerPresence, type PlayerSessionEvent } from "./sessions";

/** One person, with every list this server holds them in. */
export interface PlayerEntry {
    /** As the server spells it, which is whichever list named them first. */
    readonly name: string;
    readonly online: boolean;
    readonly operator: boolean;
    readonly whitelisted: boolean;
    /** Every address they are registered to here, oldest first. Empty when they
     *  are not registered at all - a name the game knows and Polaris does not. A
     *  person plays from more than one place, so this is a list. */
    readonly addresses: readonly string[];
    readonly note: string | null;
    readonly banReason: string | null;
    readonly banned: boolean;
    /** What they are doing, from the server's answer and its log. */
    readonly presence: PlayerPresence;
    /** When they last arrived or left, ISO 8601, as far back as the log reaches. */
    readonly lastSeen: string | null;
    /** Their own arrivals and departures, oldest first. */
    readonly sessions: readonly PlayerSessionEvent[];
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
    access: PlayerAccessView | null,
    /** The joins and leaves the log still holds, for what each player is doing
     *  and when they were last here. */
    sessions: readonly PlayerSessionEvent[] = [],
    /** The clock the log's timestamps are compared against. The server's, passed
     *  in with the reading, because a browser whose clock is minutes out would
     *  otherwise decide somebody is still arriving an hour after they left. */
    now: number = Date.now()
): PlayerEntry[] {
    const byKey = new Map<string, PlayerEntry>();
    const upsert = (name: string, patch: Partial<PlayerEntry>): void => {
        const key = name.toLowerCase();
        const current = byKey.get(key) ?? {
            name,
            online: false,
            operator: false,
            whitelisted: false,
            addresses: [],
            note: null,
            banReason: null,
            banned: false,
            presence: "never" as PlayerPresence,
            lastSeen: null,
            sessions: []
        };
        byKey.set(key, { ...current, ...patch });
    };

    for (const player of status?.players.players ?? []) upsert(player, { online: true });
    // One rule per address, so a player with three of them arrives here three
    // times and the addresses accumulate rather than the last one winning.
    for (const rule of access?.rules ?? []) {
        const held = byKey.get(rule.username.toLowerCase())?.addresses ?? [];
        upsert(rule.username, {
            addresses: held.includes(rule.address) ? held : [...held, rule.address],
            ...(rule.note ? { note: rule.note } : {})
        });
    }
    for (const player of roster?.ops ?? []) upsert(player, { operator: true });
    for (const player of roster?.whitelist ?? []) upsert(player, { whitelisted: true });
    for (const ban of roster?.bans ?? []) upsert(ban.name, { banned: true, banReason: ban.reason });
    // Somebody who has been on this server is somebody it knows, whether or not
    // any of its lists still mentions them.
    for (const event of sessions) upsert(event.name, {});

    const history = sessionsByPlayer(sessions);
    for (const [key, entry] of byKey) {
        const own = history.get(key) ?? [];
        byKey.set(key, { ...entry, ...playerActivity(own, entry.online, now), sessions: own });
    }

    // Online first - they are the ones something can be done about right now -
    // then alphabetically, so the list does not reshuffle as people come and go.
    return [...byKey.values()].sort((left, right) => {
        if (left.online !== right.online) return left.online ? -1 : 1;
        return left.name.localeCompare(right.name);
    });
}

/**
 * The four modes the game has, in the order a menu should offer them.
 *
 * Here rather than beside the action that sends them, because a server-actions
 * module may only export async functions: a constant exported from one reaches the
 * browser as a reference to an action, and the screen that tried to list it got
 * "map is not a function" and took the page down with it.
 */
export const GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;
