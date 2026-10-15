/**
 * How a login rule's principal lists answer one signed-in visitor. Pure (no Buffer, no
 * crypto), so it lives outside the Node-only "@polaris/core/waf" codec and the
 * client-safe barrel can carry it to code a browser bundle also reaches.
 */

import type { WafPrincipalGrant } from "./schemas/deploy.js";

/** How a login rule answers one signed-in visitor. */
export type PrincipalVerdict = "admitted" | "refused" | "not-admitted";

/**
 * Whether a visitor holding `held` gets past a rule's principal lists at `now`
 * (unix seconds).
 *
 * Deny first and final, then the allowlists: each one ANDs and its own entries OR, so a
 * scope names who it admits and every scope that named anybody gets a veto - which is
 * what lets a narrower scope restrict a broader one's list and never widen it. An entry
 * outside its window is not there at all, on either side. No lists and no denials is the
 * "any account" case and passes, so this is safe to call unconditionally.
 *
 * Lives here rather than in either caller because both the guard (deciding a request)
 * and Polaris (deciding whether to mint a token for one) have to answer it the same way.
 * Two implementations of this are two answers, and the disagreement would show up as a
 * redirect loop between them rather than as a wrong page.
 */
export function principalVerdict(
    rule: {
        readonly loginAllowLists?: readonly (readonly WafPrincipalGrant[])[];
        readonly loginDeny?: readonly WafPrincipalGrant[];
    },
    held: ReadonlySet<string>,
    now: number
): PrincipalVerdict {
    const applies = (grant: WafPrincipalGrant): boolean =>
        held.has(grant.ref) &&
        (grant.from === undefined || now >= grant.from) &&
        (grant.until === undefined || now < grant.until);

    if ((rule.loginDeny ?? []).some(applies)) return "refused";
    const lists = rule.loginAllowLists ?? [];
    if (lists.length === 0) return "admitted";
    return lists.every((list) => list.some(applies)) ? "admitted" : "not-admitted";
}
