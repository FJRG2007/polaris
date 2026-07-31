/**
 * Evaluation of an account's or an API key's network allowlist against a request.
 * One evaluator so a sign-in and a key are judged identically, and so the rules a
 * user sees in one dialog mean the same thing in the other.
 *
 * The two dimensions are independent and both must pass, matching how shares and
 * drop points already enforce theirs: an IP allowlist is a hard boundary (no
 * address means no entry), while a geo allowlist fails open on an unresolved
 * location, because a geolocation provider outage must not lock people out.
 */

import { resolveEnforcedRules } from "@polaris/auth";
import { geoAllowed, ipAllowed, type EffectiveAccessRules } from "@polaris/core";
import { resolveGeo } from "@/lib/geo-service";

export interface NetworkDecision {
    allowed: boolean;
    /** Which dimension refused, for the audit record. */
    reason: "ip" | "geo" | null;
    /** The resolved country, when a lookup happened. Stored alongside sessions. */
    country: string | null;
}

/** True when the rules impose no restriction at all. */
function rulesAreEmpty(rules: EffectiveAccessRules): boolean {
    return (
        rules.allowedCidrs.length === 0 &&
        rules.allowedCountries.length === 0 &&
        rules.allowedContinents.length === 0
    );
}

/** Judge one client address against a resolved allowlist. */
export async function evaluateNetworkRules(
    rules: EffectiveAccessRules,
    ip: string | undefined
): Promise<NetworkDecision> {
    if (rulesAreEmpty(rules)) return { allowed: true, reason: null, country: null };

    if (rules.allowedCidrs.length > 0) {
        // No resolvable address with an IP allowlist in force is a refusal: the
        // rule exists precisely to name where access may come from.
        if (!ip || !ipAllowed(ip, rules.allowedCidrs)) {
            return { allowed: false, reason: "ip", country: null };
        }
    }

    if (rules.allowedCountries.length === 0 && rules.allowedContinents.length === 0) {
        return { allowed: true, reason: null, country: null };
    }

    const { countryCode } = ip ? await resolveGeo(ip) : { countryCode: null };
    const allowed = geoAllowed(countryCode, rules.allowedCountries, rules.allowedContinents);
    return { allowed, reason: allowed ? null : "geo", country: countryCode };
}

/**
 * Judge one address against everything that governs an account: the limits an
 * administrator imposed, and the account's own rules. Both are allowlists in
 * their own right and both must pass - an account cannot widen an imposed limit
 * by adding rules of its own, and an administrator who imposed nothing leaves
 * the account exactly as free as it was.
 */
export async function evaluateAccountAccess(
    userId: string,
    ip: string | undefined,
    ownRules: EffectiveAccessRules
): Promise<NetworkDecision> {
    const enforced = await evaluateNetworkRules(await resolveEnforcedRules(userId), ip);
    if (!enforced.allowed) return enforced;
    const own = await evaluateNetworkRules(ownRules, ip);
    // Either pass may have been the one that resolved the location; the caller
    // stores it against the session and should not have to look it up again.
    return { ...own, country: own.country ?? enforced.country };
}
