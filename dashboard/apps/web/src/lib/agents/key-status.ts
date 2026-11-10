/**
 * Where a key stands with Polar's router, as a key screen says it: ready,
 * cooling down after a refusal, refused outright, out of credit, or past its
 * own day or month allowance.
 *
 * Client-safe: the derivation is pure, and the server read that feeds it lives
 * in `key-status-read.ts`.
 */

import type { KeyHealthView, KeyState } from "@/lib/agents/key-limits";

/** What one key spent, as `keySpend` counts it. */
export interface KeySpendView {
    requestsToday: number;
    tokensToday: number;
    tokensThisMonth: number;
}

const NOTHING: KeySpendView = { requestsToday: 0, tokensToday: 0, tokensThisMonth: 0 };

/** The state a cooling refusal reads as: a refused key and an empty account are
 *  said as such, every other refusal is a cool-down that ends on its own. */
function coolingState(reason: string | null): KeyState {
    if (reason === "key") return "refused";
    if (reason === "credit" || reason === "paid") return "no_credit";
    return "cooling";
}

/**
 * One key's standing. A cool-down still running wins over the allowance: it is
 * what the router acts on first, and it ends at a time the screen can name.
 * `allowance` is the router's own verdict on the key's day and month limits
 * (`router/limits.ts` `allowanceState`), so the screen and the router cannot
 * disagree about when a limit is reached. Pure.
 */
export function keyStatus(
    key: { coolingUntil: string | null; coolingReason: string | null },
    spend: KeySpendView | undefined,
    allowance: KeyState,
    now = Date.now()
): KeyHealthView {
    const spent = spend ?? NOTHING;
    const cooling = key.coolingUntil !== null && new Date(key.coolingUntil).getTime() > now;
    return {
        state: cooling ? coolingState(key.coolingReason) : allowance,
        until: cooling ? key.coolingUntil : null,
        reason: cooling ? key.coolingReason : null,
        requestsToday: spent.requestsToday,
        tokensToday: spent.tokensToday,
        tokensThisMonth: spent.tokensThisMonth
    };
}

/** The standing a key reads as once it is put back in rotation, until the
 *  server's next read says whether a limit still holds it. Pure. */
export function revivedStatus(view: KeyHealthView): KeyHealthView {
    return { ...view, state: "ready", until: null, reason: null };
}

/** Whether a state is one "Put back in rotation" ends. Pure. */
export function isCoolingState(state: KeyState): boolean {
    return state === "cooling" || state === "refused" || state === "no_credit";
}
