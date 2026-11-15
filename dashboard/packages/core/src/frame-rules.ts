/**
 * Framing decided per request: which sites may embed a page, given who asked for it.
 *
 * `frame-ancestors` takes a list of sites and nothing else, so a condition - "only from
 * the office network", "only on this hostname" - cannot be written into the header. The
 * guard's proxy can still pick WHICH list it sends for each response, and that is what
 * this file decides: the scope's static list, plus the sites of every `allow` rule whose
 * conditions hold, unless a `refuse` rule holds, which shuts every frame out.
 *
 * Pure and I/O-free like the custom rules it borrows its conditions from, so the guard
 * runs it with nothing to consult and the tests run it with nothing to stub.
 */

import type { WafFrameRule } from "./schemas/deploy.js";
import { conditionHolds, type WafRequestFacts } from "./waf-rules.js";
import { FRAME_ANCESTORS_MAX, protectFrameHeaders } from "./frame-protection.js";

/** Most origins one response may name: the scope's own list plus as many again from
 *  the rules that matched. A header is sent on every response. */
export const FRAME_DECISION_MAX = FRAME_ANCESTORS_MAX * 2;

/** What one response says about framing. */
export type FrameDecision =
    | { readonly refuse: true }
    | { readonly refuse: false; readonly allowed: readonly string[] };

/** Whether every condition of an enabled framing rule holds. */
function frameRuleMatches(rule: WafFrameRule, facts: WafRequestFacts): boolean {
    if (rule.enabled === false) return false;
    return rule.conditions.every((condition) => conditionHolds(condition, facts));
}

/**
 * The framing answer for one request.
 *
 * A matching `refuse` wins over everything, wherever it sits in the list: a refusal is
 * the rule an operator writes to be sure, and an `allow` elsewhere must not be able to
 * undo it. Matching `allow` rules add their sites to the base list, deduplicated and
 * capped at FRAME_DECISION_MAX.
 */
export function decideFraming(
    base: readonly string[],
    rules: readonly WafFrameRule[],
    facts: WafRequestFacts
): FrameDecision {
    const allowed = new Set(base.slice(0, FRAME_DECISION_MAX));
    for (const rule of rules) {
        if (!frameRuleMatches(rule, facts)) continue;
        if (rule.action === "refuse") return { refuse: true };
        for (const origin of rule.ancestors) {
            if (allowed.size >= FRAME_DECISION_MAX) break;
            allowed.add(origin);
        }
    }
    return { refuse: false, allowed: [...allowed] };
}

type NodeHeaders = Record<string, string | string[] | undefined>;

/**
 * The response headers for a framing decision.
 *
 * A refusal appends its own `frame-ancestors 'none'` policy rather than replacing the
 * app's: several CSP headers are several policies and a browser enforces all of them,
 * so it holds over whatever the app allowed without touching its other directives.
 * `X-Frame-Options: DENY` goes beside it for browsers that predate the directive.
 * Anything else is the ordinary merge in `protectFrameHeaders`.
 */
export function frameHeadersFor(headers: NodeHeaders, decision: FrameDecision): NodeHeaders {
    if (!decision.refuse) return protectFrameHeaders(headers, decision.allowed);
    const existing = headers["content-security-policy"];
    const policies = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    return {
        ...headers,
        "content-security-policy": [...policies, "frame-ancestors 'none'"],
        "x-frame-options": "DENY"
    };
}
