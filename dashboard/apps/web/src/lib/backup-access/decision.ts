/**
 * When backup access takes the domain over, and when it hands it back.
 *
 * Pure: it is handed the stored state, one check's verdict and the clock, and
 * answers the next state and the one move to make, if any. The service persists
 * the state only after the move succeeded, so a restart or a failed DNS write
 * simply decides the same thing again on the next pass.
 *
 * Hysteresis, so one lost probe never moves DNS and a line that comes and goes
 * does not flap: `failToFlip` failed checks in a row to leave the direct path,
 * and `okToReturn` good ones in a row, spread over at least `returnWindowMs`, to
 * come back.
 */

import { z } from "zod";

export const BACKUP_MODES = ["automatic", "always", "manual"] as const;
export type BackupMode = (typeof BACKUP_MODES)[number];

/**
 * The ways in. Phase 2 adds a phone hotspot: a third kind that changes how the
 * house gets an uplink rather than where DNS points, so it slots in here and in
 * `pathReady` without touching the decision itself.
 */
export const BACKUP_PATHS = ["tunnel", "relay"] as const;
export type BackupPath = (typeof BACKUP_PATHS)[number];

/** One check's verdict. `no-uplink`: nothing gets out, so nothing can be changed. */
export type Verdict = "up" | "down" | "no-uplink" | "unknown";

export const FAIL_TO_FLIP = 3;
export const OK_TO_RETURN = 5;
export const RETURN_WINDOW_MS = 5 * 60 * 1000;

export const flipSchema = z.object({
    at: z.string(),
    to: z.enum(["backup", "direct"]),
    reason: z.enum(["outage", "recovered", "always", "manual", "unconfigured"])
});
export type Flip = z.infer<typeof flipSchema>;

export const flipStateSchema = z.object({
    serving: z.enum(["direct", "backup"]),
    failStreak: z.number().int().min(0),
    okStreak: z.number().int().min(0),
    okSince: z.string().nullable(),
    since: z.string().nullable(),
    uplink: z.boolean(),
    lastFlip: flipSchema.nullable()
});
export type FlipState = z.infer<typeof flipStateSchema>;

export const INITIAL_STATE: FlipState = {
    serving: "direct",
    failStreak: 0,
    okStreak: 0,
    okSince: null,
    since: null,
    uplink: true,
    lastFlip: null
};

export interface DecideInput {
    readonly mode: BackupMode;
    /** Manual mode: whether the operator asked for the backup path. */
    readonly manualOn: boolean;
    /** A path is configured and its connector is up, so a flip can land. */
    readonly pathReady: boolean;
    readonly verdict: Verdict;
    readonly now: Date;
    readonly failToFlip?: number;
    readonly okToReturn?: number;
    readonly returnWindowMs?: number;
}

export interface Decision {
    readonly state: FlipState;
    readonly move: "to-backup" | "to-direct" | null;
}

export function decide(previous: FlipState, input: DecideInput): Decision {
    const failToFlip = input.failToFlip ?? FAIL_TO_FLIP;
    const okToReturn = input.okToReturn ?? OK_TO_RETURN;
    const windowMs = input.returnWindowMs ?? RETURN_WINDOW_MS;
    const at = input.now.toISOString();
    const state = counted(previous, input.verdict, at);

    const flip = (to: "backup" | "direct", reason: Flip["reason"]): Decision => ({
        state: {
            ...state,
            serving: to,
            since: at,
            failStreak: 0,
            okStreak: 0,
            okSince: null,
            lastFlip: { at, to, reason }
        },
        move: to === "backup" ? "to-backup" : "to-direct"
    });

    // Nothing reaches Cloudflare or the relay without an uplink: hold still.
    if (input.verdict === "no-uplink") return { state, move: null };

    if (!input.pathReady)
        return state.serving === "backup" ? flip("direct", "unconfigured") : { state, move: null };

    if (input.mode === "always")
        return state.serving === "direct" ? flip("backup", "always") : { state, move: null };

    if (input.mode === "manual") {
        if (input.manualOn && state.serving === "direct") return flip("backup", "manual");
        if (!input.manualOn && state.serving === "backup") return flip("direct", "manual");
        return { state, move: null };
    }

    if (state.serving === "direct" && state.failStreak >= failToFlip)
        return flip("backup", "outage");
    if (
        state.serving === "backup" &&
        state.okStreak >= okToReturn &&
        state.okSince !== null &&
        input.now.getTime() - Date.parse(state.okSince) >= windowMs
    )
        return flip("direct", "recovered");
    return { state, move: null };
}

/** The streaks after one verdict. `unknown` and `no-uplink` count for neither. */
function counted(previous: FlipState, verdict: Verdict, at: string): FlipState {
    switch (verdict) {
        case "up":
            return {
                ...previous,
                uplink: true,
                failStreak: 0,
                okStreak: previous.okStreak + 1,
                okSince: previous.okSince ?? at
            };
        case "down":
            return {
                ...previous,
                uplink: true,
                failStreak: previous.failStreak + 1,
                okStreak: 0,
                okSince: null
            };
        case "no-uplink":
            return { ...previous, uplink: false, okStreak: 0, okSince: null };
        default:
            return previous;
    }
}

/** Read a stored state, falling back to the start for anything unreadable. */
export function readState(raw: string | null): FlipState {
    if (!raw) return INITIAL_STATE;
    try {
        const parsed = flipStateSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : INITIAL_STATE;
    } catch {
        return INITIAL_STATE;
    }
}
