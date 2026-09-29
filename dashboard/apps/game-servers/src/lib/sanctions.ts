/**
 * A ban, timeout or kick a game server put on a player, and which of them a
 * linked account's standing page shows.
 *
 * Pure: the rule for "still in force" is the one thing the page and the tests
 * both need, and it must not bring the database with it.
 */

export const SANCTION_KINDS = ["ban", "timeout", "kick"] as const;

export type SanctionKind = (typeof SANCTION_KINDS)[number];

/** How far back a sanction that is over is still listed. The same window the
 *  account's own standing counts over, so the page reads as one period. */
export const SANCTION_HISTORY_DAYS = 90;

export function isSanctionKind(value: string): value is SanctionKind {
    return (SANCTION_KINDS as readonly string[]).includes(value);
}

/** The part of a stored sanction that decides whether it still applies. */
export interface SanctionState {
    readonly kind: string;
    readonly at: Date;
    readonly until: Date | null;
    readonly liftedAt: Date | null;
}

/**
 * Whether it still keeps them out. A kick is over the moment it happens; a
 * timeout until its end; a ban until somebody pardons it.
 */
export function sanctionActive(row: SanctionState, now: Date): boolean {
    if (row.liftedAt !== null) return false;
    if (row.kind === "timeout") return row.until !== null && row.until > now;
    return row.kind === "ban";
}

/** Whether the standing page lists it: anything in force, and anything else
 *  from inside the window. */
export function shownOnStanding(row: SanctionState, now: Date): boolean {
    if (!isSanctionKind(row.kind)) return false;
    if (sanctionActive(row, now)) return true;
    return row.at.getTime() >= now.getTime() - SANCTION_HISTORY_DAYS * 24 * 60 * 60 * 1000;
}

/** One sanction as the account it concerns is shown it. */
export interface StandingSanction {
    readonly id: string;
    readonly kind: SanctionKind;
    /** The game, as people call it: "Minecraft". */
    readonly game: string;
    /** The server, as its owner named it. */
    readonly server: string;
    /** The player it was put on, as the link spells it. */
    readonly player: string;
    readonly at: Date;
    readonly until: Date | null;
    readonly active: boolean;
    readonly reason: string | null;
}
