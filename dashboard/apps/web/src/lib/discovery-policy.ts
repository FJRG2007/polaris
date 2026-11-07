/**
 * How somebody who is not a friend or a colleague can find an account.
 *
 * The operator's half of the discovery rule. Friends and the people an account
 * already works with are found by part of their name or handle whatever this
 * says; this decides which identifiers find everybody else. Each account's own
 * "who can find me" setting and every block still apply on top - this can only
 * widen what a search may match, never what a person has refused.
 *
 * Pure, so the admin screen and the server read the same shape and the same
 * defaults. The defaults are the behavior before the setting existed - the whole
 * username and nothing else - so an install that never opens the screen is
 * unchanged.
 */

import { z } from "zod";

export const DISCOVERY_POLICY_KEY = "people.discovery";

export const discoveryPolicySchema = z
    .object({
        /** The whole username, "@ada" or "ada". */
        usernameExact: z.boolean(),
        /** Part of a username. */
        usernamePartial: z.boolean(),
        /** Part of a display name. */
        namePartial: z.boolean(),
        /** The whole email address. Never printed back because of it. */
        emailExact: z.boolean()
    })
    .strict();

export type DiscoveryPolicy = z.infer<typeof discoveryPolicySchema>;

export const DISCOVERY_RULES = [
    "usernameExact",
    "usernamePartial",
    "namePartial",
    "emailExact"
] as const;

export const DEFAULT_DISCOVERY_POLICY: DiscoveryPolicy = {
    usernameExact: true,
    usernamePartial: false,
    namePartial: false,
    emailExact: false
};

/**
 * A stored value as a policy. Anything unreadable falls back field by field to
 * the defaults, so a value written before a rule existed keeps the rules it had
 * and gets the default for the new one.
 */
export function readDiscoveryPolicy(stored: string | null): DiscoveryPolicy {
    if (!stored) return DEFAULT_DISCOVERY_POLICY;
    let raw: unknown;
    try {
        raw = JSON.parse(stored);
    } catch {
        return DEFAULT_DISCOVERY_POLICY;
    }
    const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const policy = { ...DEFAULT_DISCOVERY_POLICY };
    for (const rule of DISCOVERY_RULES) {
        if (typeof value[rule] === "boolean") policy[rule] = value[rule];
    }
    return policy;
}
