"use client";

/**
 * Client-side attempt throttle backed by localStorage. A first line of defense
 * on public password gates: after a few failed guesses it imposes a short local
 * cooldown, giving instant feedback and sparing the server the request. It is a
 * convenience, not the security control - the server enforces the real limit
 * (see rate-limit-service). Cleared on success.
 */

const PREFIX = "polaris_attempts_";
const MAX_BEFORE_COOLDOWN = 5;
const COOLDOWN_MS = 30_000;

interface AttemptState {
    failures: number;
    lockedUntil: number;
}

function read(key: string): AttemptState {
    if (typeof window === "undefined") return { failures: 0, lockedUntil: 0 };
    try {
        const raw = window.localStorage.getItem(PREFIX + key);
        if (!raw) return { failures: 0, lockedUntil: 0 };
        const parsed = JSON.parse(raw) as AttemptState;
        return { failures: parsed.failures ?? 0, lockedUntil: parsed.lockedUntil ?? 0 };
    } catch {
        return { failures: 0, lockedUntil: 0 };
    }
}

function write(key: string, state: AttemptState): void {
    try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(state));
    } catch {
        // Storage unavailable (private mode / quota) - throttle silently no-ops.
    }
}

/** Seconds remaining in a local cooldown, or 0 when submitting is allowed. */
export function cooldownRemaining(key: string): number {
    const { lockedUntil } = read(key);
    const remaining = lockedUntil - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/** Record a failed attempt; starts a cooldown once the threshold is crossed. */
export function recordFailure(key: string): void {
    const state = read(key);
    const failures = state.failures + 1;
    write(key, {
        failures,
        lockedUntil: failures >= MAX_BEFORE_COOLDOWN ? Date.now() + COOLDOWN_MS : 0
    });
}

/** Clear the throttle for a key after a successful unlock. */
export function clearAttempts(key: string): void {
    try {
        window.localStorage.removeItem(PREFIX + key);
    } catch {
        // Ignore.
    }
}
