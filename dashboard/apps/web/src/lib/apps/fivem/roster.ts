/**
 * One row per person, out of four lists that do not agree about who a person is.
 *
 * The players screen has to draw somebody who is playing right now, somebody who
 * is allowed in and has never turned up, somebody who is banned, and somebody who
 * administers the server - and the same person is very often three of those. Only
 * one of the four carries a name (the live list, and the name is theirs to
 * choose); the other three carry an identifier and a label somebody typed. So the
 * fold is on the identifier, and the name shown is the best of what is available:
 * what they are called on the server right now, else what they were labelled as.
 *
 * A connected player presents several identifiers at once, so a row is matched by
 * any of them - somebody allowed in by their Discord id is the same row as the
 * player whose licence the server is reporting.
 *
 * Pure and client-safe: the table renders these in the browser.
 */

import type { FivemAllowedPlayer, FivemBan, FivemAdmin } from "@/lib/apps/fivem/access";
import { normalizeIdentifier, primaryIdentifier, type FivemPlayer } from "@/lib/apps/fivem/players";

export interface FivemPlayerEntry {
    /** What a rule about them is written against. Null only for a connected
     *  client that presented nothing at all, which the game does not do. */
    readonly identifier: string | null;
    readonly name: string;
    readonly online: boolean;
    /**
     * Their slot, which is what the console's commands take.
     *
     * Null when they are not connected - the number is reused the moment they
     * leave - and also null for somebody the live stream reported, which carries
     * a name and an identifier and no slot. A verb that needs one is not offered
     * against a row that has none, rather than sent with a number that addresses
     * whoever is in that slot now.
     */
    readonly playerId: number | null;
    readonly ping: number | null;
    readonly allowed: boolean;
    /** On Polaris' list, and the server has not been handed it yet. */
    readonly waiting: boolean;
    readonly banned: FivemBan | null;
    readonly admin: boolean;
    /** When they were put on the list, for the row that has nothing better to say
     *  about somebody nobody has ever seen play. */
    readonly addedAt: string | null;
    /** Everything they presented, for the row that shows how they are known. */
    readonly identifiers: readonly string[];
}

interface Draft {
    identifier: string | null;
    name: string;
    online: boolean;
    playerId: number | null;
    ping: number | null;
    allowed: boolean;
    waiting: boolean;
    banned: FivemBan | null;
    admin: boolean;
    addedAt: string | null;
    identifiers: string[];
}

/** Everyone the screen has anything to say about, online first and then by name. */
export function foldFivemPlayers(
    live: readonly FivemPlayer[],
    access: {
        readonly allowList: readonly FivemAllowedPlayer[];
        readonly bans: readonly FivemBan[];
        readonly admins: readonly FivemAdmin[];
    }
): FivemPlayerEntry[] {
    const rows: Draft[] = [];
    /** Which row holds one identifier, so a person known three ways is one row. */
    const byIdentifier = new Map<string, Draft>();

    const claim = (identifiers: readonly string[]): Draft | null => {
        for (const entry of identifiers) {
            const found = byIdentifier.get(normalizeIdentifier(entry));
            if (found) return found;
        }
        return null;
    };
    const remember = (row: Draft): void => {
        for (const entry of row.identifiers) byIdentifier.set(normalizeIdentifier(entry), row);
    };

    for (const player of live) {
        const row: Draft = {
            identifier: primaryIdentifier(player),
            name: player.name,
            online: true,
            // Negative is how a reading that has no slot at all says so.
            playerId: player.id >= 0 ? player.id : null,
            ping: player.ping,
            allowed: false,
            waiting: false,
            banned: null,
            admin: false,
            addedAt: null,
            identifiers: player.identifiers.map(normalizeIdentifier)
        };
        rows.push(row);
        remember(row);
    }

    const attach = (identifier: string, label: string, apply: (row: Draft) => void): void => {
        const wanted = normalizeIdentifier(identifier);
        const found = claim([wanted]);
        if (found) {
            apply(found);
            return;
        }
        const row: Draft = {
            identifier: wanted,
            name: label || wanted,
            online: false,
            playerId: null,
            ping: null,
            allowed: false,
            waiting: false,
            banned: null,
            admin: false,
            addedAt: null,
            identifiers: [wanted]
        };
        apply(row);
        rows.push(row);
        remember(row);
    };

    for (const player of access.allowList) {
        attach(player.identifier, player.label, (row) => {
            row.allowed = true;
            row.waiting = player.appliedAt === null;
            row.addedAt = player.addedAt;
        });
    }
    for (const ban of access.bans) {
        attach(ban.identifier, ban.label, (row) => {
            row.banned = ban;
        });
    }
    for (const admin of access.admins) {
        attach(admin.identifier, admin.label, (row) => {
            row.admin = true;
        });
    }

    return rows
        .map((row) => ({ ...row, identifiers: [...row.identifiers] }))
        .sort((left, right) => {
            if (left.online !== right.online) return left.online ? -1 : 1;
            return left.name.localeCompare(right.name);
        });
}

/** Whether a row matches what somebody typed into the search box: their name, or
 *  any identifier they are known by. */
export function matchesFivemPlayer(entry: FivemPlayerEntry, query: string): boolean {
    const wanted = query.trim().toLowerCase();
    if (wanted.length === 0) return true;
    return (
        entry.name.toLowerCase().includes(wanted) ||
        entry.identifiers.some((identifier) => identifier.toLowerCase().includes(wanted))
    );
}

/** Which of the players screen's cuts a row falls into. */
export function matchesFivemFilter(entry: FivemPlayerEntry, filter: string): boolean {
    switch (filter) {
        case "online":
            return entry.online;
        case "allowed":
            return entry.allowed;
        case "operators":
            return entry.admin;
        case "banned":
            return entry.banned !== null;
        default:
            return true;
    }
}
