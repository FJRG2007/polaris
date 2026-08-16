/**
 * A restart somebody has asked for but does not want yet.
 *
 * Some settings cannot be applied to a running game server - ARK reads all of its
 * at start, and a container's environment is only read when it boots - so changing
 * one leaves the server correct on disk and stale in memory until it comes back.
 * The panel used to offer exactly two answers to that: restart now and disconnect
 * whoever is playing, or say nothing and hope somebody remembers.
 *
 * This is the third answer. A restart can be asked for and left to happen when
 * nobody is on, or at a time, and until then the change simply waits - which is
 * also what happens if nothing is ever asked for, because the next start applies
 * it whenever that is. Nothing here restarts anything by itself that was not
 * asked for.
 *
 * Pure: the screen offers exactly what the sweep will honour.
 */

/** When a waiting restart should happen. */
export type RestartWhen = "empty" | "at";

export interface PendingRestart {
    /** When it should happen: as soon as the server is empty, or at a moment. */
    readonly when: RestartWhen;
    /** The moment, for `at`. ISO, and always in the future when it was recorded. */
    readonly at: string | null;
    /** What changed, in the operator's language, so the card can say why a restart
     *  is waiting a day after somebody set it up. */
    readonly reason: string;
    readonly requestedAt: string;
    /** Who asked, for the audit line the restart itself will write. */
    readonly requestedBy: string;
}

/** Where it lives on the install's own settings blob. */
export const PENDING_RESTART_KEY = "pendingRestart";

/** How far ahead a restart may be booked. Longer than this is not a plan, it is a
 *  forgotten checkbox that reboots a server in June. */
export const MAX_RESTART_DAYS = 30;

export const MAX_RESTART_REASON = 80;

/** The restart an install is waiting on, or null. Anything unreadable is null
 *  rather than repaired: a restart is disruptive, and a half-read instruction is
 *  not one anybody gave. */
export function readPendingRestart(config: Record<string, unknown>): PendingRestart | null {
    const raw = config[PENDING_RESTART_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const when = row.when === "empty" || row.when === "at" ? row.when : null;
    if (!when) return null;
    const at = typeof row.at === "string" && !Number.isNaN(Date.parse(row.at)) ? row.at : null;
    if (when === "at" && at === null) return null;
    return {
        when,
        at,
        reason: typeof row.reason === "string" ? row.reason.slice(0, MAX_RESTART_REASON) : "",
        requestedAt: typeof row.requestedAt === "string" ? row.requestedAt : new Date(0).toISOString(),
        requestedBy: typeof row.requestedBy === "string" ? row.requestedBy : ""
    };
}

/**
 * A restart request, or null when it is not one anybody could honour.
 *
 * A time in the past is refused rather than run immediately: somebody who typed
 * yesterday's date meant tomorrow, and a server that restarted the instant they
 * pressed save is the one outcome they were trying to avoid.
 */
export function newPendingRestart(input: {
    when: RestartWhen;
    at?: string | null;
    reason?: string;
    requestedBy: string;
    now: Date;
}): PendingRestart | null {
    const now = input.now.getTime();
    let at: string | null = null;
    if (input.when === "at") {
        const parsed = input.at ? Date.parse(input.at) : Number.NaN;
        if (Number.isNaN(parsed) || parsed <= now) return null;
        if (parsed > now + MAX_RESTART_DAYS * 24 * 3600 * 1000) return null;
        at = new Date(parsed).toISOString();
    }
    return {
        when: input.when,
        at,
        reason: (input.reason ?? "").trim().slice(0, MAX_RESTART_REASON),
        requestedAt: input.now.toISOString(),
        requestedBy: input.requestedBy
    };
}

/**
 * Whether a waiting restart should happen now.
 *
 * `playersOnline` is null when nobody could be asked - a server that is not
 * answering. That is deliberately not treated as empty: a server Polaris cannot
 * reach is one it knows nothing about, and restarting it on that basis would
 * disconnect a full server the moment its RCON hiccupped.
 */
export function restartDue(
    pending: PendingRestart | null,
    now: Date,
    playersOnline: number | null
): boolean {
    if (!pending) return false;
    if (pending.when === "at") return pending.at !== null && Date.parse(pending.at) <= now.getTime();
    return playersOnline === 0;
}
