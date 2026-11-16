/**
 * Whether an agent that keeps its login in the sessions' home is signed in.
 *
 * Two sources, never mixed. A tool whose docs name a status command is asked,
 * in a container on that home, and the answer is labelled as checked. Every
 * other tool is shown what the last sign-in or sign-out run from Polaris ended
 * in, labelled as last known - because a login that expired on the vendor's side
 * since then is something only the tool could have said.
 *
 * Both stores are this process's memory: a restart forgets them and the rows
 * read "unknown" until somebody checks or signs in again. That is the honest
 * answer, and it needs no table for a value that goes stale on its own.
 *
 * Pure apart from the two maps, so the reading and the cache are tested
 * without a container.
 */

import { z } from "zod";

/** Signed in, signed out, or nothing Polaris can stand behind. */
export type SigninState = "in" | "out" | "unknown";

export interface SigninStatus {
    readonly state: SigninState;
    /** Recorded from the last sign-in or sign-out rather than asked of the tool. */
    readonly lastKnown: boolean;
}

export const UNKNOWN_STATUS: SigninStatus = { state: "unknown", lastKnown: false };

/** How long a checked answer is reused. A status check starts a container. */
export const STATUS_TTL_MS = 60_000;

/** The most remembered entries of each kind, oldest dropped first. */
const MAX_ENTRIES = 10_000;

/** The prefix of each line the status script prints, one per tool. */
export const STATUS_MARKER = "polaris-status";

/**
 * What one status command's exit code and output say.
 *
 * No vendor among those used documents the exit codes of its status command,
 * so the reading leans the safe way: only a clean exit that does not say
 * otherwise is "signed in". A tool that is not installed in the home (127) has
 * never run there, so nothing is signed in; a command that could not be run at
 * all is unknown. The phrases are a demotion only - they can turn a clean exit
 * into "signed out", never a failure into "signed in".
 */
export function readStatusResult(exitCode: number | null, output: string): SigninState {
    if (exitCode === null || exitCode === 126) return "unknown";
    if (exitCode === 127) return "out";
    if (exitCode !== 0) return "out";
    return /\b(not (logged|signed) in|not authenticated|unauthenticated|logged out|signed out|no (active )?(account|credentials))\b/i.test(
        output
    )
        ? "out"
        : "in";
}

const markerLine = z.object({
    env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    code: z.coerce.number().int().min(0).max(255),
    output: z.string().max(8192)
});

/**
 * The script's lines, by variable: `polaris-status <ENV> <code> <base64 output>`.
 * A line that is not exactly that shape is skipped, so a tool that printed
 * something of its own on a line starting with the marker reads as no answer.
 */
export function parseStatusLines(output: string): Map<string, SigninState> {
    const found = new Map<string, SigninState>();
    for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(" ");
        if (parts[0] !== STATUS_MARKER || parts.length < 3 || parts.length > 4) continue;
        const parsed = markerLine.safeParse({
            env: parts[1],
            code: parts[2],
            output: parts[3] ? Buffer.from(parts[3], "base64").toString("utf8") : ""
        });
        if (!parsed.success) continue;
        found.set(parsed.data.env, readStatusResult(parsed.data.code, parsed.data.output));
    }
    return found;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_ENTRIES) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

const outcomes = new Map<string, SigninState>();
const checked = new Map<string, { state: SigninState; at: number }>();

function keyOf(userId: string, env: string): string {
    return `${userId}:${env}`;
}

/**
 * What a sign-in or sign-out run from Polaris finished as. Only a clean finish
 * moves it: a login that failed says nothing about whether an older one is
 * still there. Drops the checked answer, so the next read asks again.
 */
export function recordSigninOutcome(userId: string, env: string, mode: "login" | "logout"): void {
    remember(outcomes, keyOf(userId, env), mode === "login" ? "in" : "out");
    checked.delete(keyOf(userId, env));
}

/** The last recorded outcome, as a status labelled last known. */
export function lastKnownStatus(userId: string, env: string): SigninStatus {
    const state = outcomes.get(keyOf(userId, env));
    return state ? { state, lastKnown: true } : UNKNOWN_STATUS;
}

/** A checked answer still inside the TTL, or null. */
export function cachedStatus(userId: string, env: string, now: number): SigninStatus | null {
    const hit = checked.get(keyOf(userId, env));
    if (!hit || now - hit.at >= STATUS_TTL_MS) return null;
    return { state: hit.state, lastKnown: false };
}

/** Keep a checked answer. An unknown is not kept, so a failed check is retried. */
export function cacheStatus(userId: string, env: string, state: SigninState, now: number): void {
    if (state === "unknown") return;
    remember(checked, keyOf(userId, env), { state, at: now });
}
