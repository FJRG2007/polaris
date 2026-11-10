/**
 * The allowance a person sets on one provider key, and the state the router
 * keeps about it. A free tier is a per-key allowance - so many requests a
 * minute, so many tokens a day - and a key that has spent it is stepped over
 * for the next one rather than asked until the provider refuses.
 *
 * Every limit is optional; an empty object is "no limit of my own", and the
 * provider's own refusals still cool the key down (`key-health.ts`).
 *
 * Client-safe.
 */

import { z } from "zod";

const count = (most: number) => z.number().int().min(1).max(most).nullable().default(null);

export const keyLimitsSchema = z
    .object({
        /** Calls started in any rolling minute. */
        requestsPerMinute: count(100_000),
        /** Calls in flight at once. */
        concurrency: count(1_000),
        /** Calls per UTC day. */
        requestsPerDay: count(10_000_000),
        /** Input plus output tokens per UTC day. */
        tokensPerDay: count(1_000_000_000_000),
        /** Input plus output tokens per UTC calendar month. */
        tokensPerMonth: count(1_000_000_000_000)
    })
    .strict();
export type KeyLimits = z.infer<typeof keyLimitsSchema>;

export const KEY_LIMIT_FIELDS = [
    "requestsPerMinute",
    "concurrency",
    "requestsPerDay",
    "tokensPerDay",
    "tokensPerMonth"
] as const satisfies readonly (keyof KeyLimits)[];

export const NO_KEY_LIMITS: KeyLimits = keyLimitsSchema.parse({});

/** A stored value read whole: anything unreadable is no limit. Pure. */
export function keyLimitsOf(value: unknown): KeyLimits {
    let source = value;
    if (typeof value === "string") {
        try {
            source = JSON.parse(value);
        } catch {
            return NO_KEY_LIMITS;
        }
    }
    const parsed = keyLimitsSchema.safeParse(source ?? {});
    return parsed.success ? parsed.data : NO_KEY_LIMITS;
}

/** Whether any limit is set. Pure. */
export function hasKeyLimits(limits: KeyLimits): boolean {
    return KEY_LIMIT_FIELDS.some((field) => limits[field] !== null);
}

/** Why the router is stepping over a key right now. */
export const KEY_STATES = [
    "ready",
    "cooling",
    "refused",
    "no_credit",
    "limit_day",
    "limit_month"
] as const;
export type KeyState = (typeof KEY_STATES)[number];

/** What a key screen shows about one key. */
export interface KeyHealthView {
    state: KeyState;
    /** When the router asks it again, for a cooling key. */
    until: string | null;
    /** The refusal that cooled it, as a failure kind. */
    reason: string | null;
    requestsToday: number;
    tokensToday: number;
    tokensThisMonth: number;
}
