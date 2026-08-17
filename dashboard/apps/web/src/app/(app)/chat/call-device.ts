"use client";

/**
 * Which browser this is, for the length of a call.
 *
 * An account has one seat in a call - a second device rejoining reuses the same
 * participant row, because a person is one person in a room. That is the right
 * model and it left a hole: two browsers of one account both believed they held
 * it, both kept a microphone open, and nothing anywhere said which was live.
 *
 * This is the smallest thing that closes it. A value the browser makes up for
 * itself, sent with a claim, and compared - never trusted, never stored on the
 * server, and worth nothing to anybody who copies it. Whoever claimed the seat
 * last is on the call; everybody else hangs up.
 *
 * Per tab rather than per browser, deliberately. Two tabs of Polaris on one
 * computer are as much "two places holding one call" as a phone and a desk are,
 * and the older one going quiet when the newer one joins is what a person
 * pressing the button in a second tab meant to happen.
 */

const KEY = "polaris.call.device";

let held: string | null = null;

export function callDeviceId(): string {
    if (held) return held;
    if (typeof window === "undefined") return "";

    // Session storage rather than local: it is per tab, and a value that
    // outlived the tab would let a browser reopened tomorrow claim to be the
    // one that was on a call today.
    const stored = window.sessionStorage?.getItem(KEY);
    held = stored ?? crypto.randomUUID();
    try {
        window.sessionStorage?.setItem(KEY, held);
    } catch {
        // Private browsing, or storage that is full. The value still works for
        // as long as this page is open, which is as long as a call lasts.
    }
    return held;
}
