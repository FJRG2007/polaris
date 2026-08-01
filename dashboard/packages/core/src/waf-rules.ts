/**
 * Evaluating the firewall's custom rules.
 *
 * A rule is a list of conditions over facts the edge already has about a request -
 * where it came from, what it asked for, what it said it was - and an action to take
 * when they all hold. Rules are tried in order and the first match decides, so a
 * narrow `allow` above a broad `block` is an exception rather than a contradiction.
 *
 * Deliberately pure and I/O-free: the same function runs in the co-located edge
 * guard, where there is no database to consult, and in tests, where there is nothing
 * to stub. That is also why no field needs a lookup - no geolocation, no reputation,
 * nothing that would turn a request into a network call and the firewall into
 * something that stops working when Polaris does.
 */

import { ipAllowed } from "./cidr.js";
import type { WafCondition, WafCustomRule, WafRuleAction } from "./schemas/deploy.js";

/** The request as the edge forwards it. Any fact can be missing - a client is not
 *  obliged to send a user agent, and a proxy may not forward an address. */
export interface WafRequestFacts {
    readonly ip?: string | null;
    readonly host?: string | null;
    readonly path?: string | null;
    readonly method?: string | null;
    readonly userAgent?: string | null;
    readonly query?: string | null;
}

/** The operators that mean "none of the values match" rather than "one does". */
const NEGATIVE = new Set(["not_equals", "not_contains"]);

/**
 * The fact a condition reads, lowercased where case is not meaningful. A path and a
 * query string are compared as sent; a hostname, a method and a user agent are not
 * case-sensitive in any way an operator would expect to have to think about.
 */
function factFor(field: WafCondition["field"], facts: WafRequestFacts): string | null {
    switch (field) {
        case "ip":
            return facts.ip ?? null;
        case "host":
            return facts.host?.toLowerCase() ?? null;
        case "path":
            return facts.path ?? null;
        case "method":
            return facts.method?.toUpperCase() ?? null;
        case "user_agent":
            return facts.userAgent?.toLowerCase() ?? null;
        case "query":
            return facts.query ?? null;
    }
}

/** The value as it is compared, matching how the fact was normalized. */
function normalizeValue(field: WafCondition["field"], value: string): string {
    const trimmed = value.trim();
    if (field === "host" || field === "user_agent") return trimmed.toLowerCase();
    if (field === "method") return trimmed.toUpperCase();
    return trimmed;
}

/** Whether one value satisfies the operator against the fact. */
function matchesValue(operator: WafCondition["operator"], fact: string, value: string): boolean {
    switch (operator) {
        case "equals":
        case "not_equals":
            return fact === value;
        case "contains":
        case "not_contains":
            return fact.includes(value);
        case "starts_with":
            return fact.startsWith(value);
        case "ends_with":
            return fact.endsWith(value);
    }
}

/**
 * Whether one condition holds.
 *
 * A missing fact never satisfies a condition, including a negative one: "the user
 * agent is not curl" must not become true for a request that sent no user agent at
 * all, because that is exactly what a client avoiding the rule would send. The
 * address is the one field with its own comparison - an entry there is an IP or a
 * CIDR range, so it is matched by containment rather than by string.
 */
function conditionHolds(condition: WafCondition, facts: WafRequestFacts): boolean {
    const fact = factFor(condition.field, facts);
    if (fact === null || fact === "") return false;

    if (condition.field === "ip") {
        const inRange = ipAllowed(fact, condition.values.map((value) => value.trim()));
        return NEGATIVE.has(condition.operator) ? !inRange : inRange;
    }

    const values = condition.values.map((value) => normalizeValue(condition.field, value));
    const anyMatch = values.some((value) => matchesValue(condition.operator, fact, value));
    return NEGATIVE.has(condition.operator) ? !anyMatch : anyMatch;
}

/** Whether every one of a rule's conditions holds. */
export function ruleMatches(rule: WafCustomRule, facts: WafRequestFacts): boolean {
    if (rule.enabled === false) return false;
    return rule.conditions.every((condition) => conditionHolds(condition, facts));
}

/** What matched, so a block can say which rule did it. */
export interface WafRuleVerdict {
    readonly action: WafRuleAction;
    readonly rule: WafCustomRule;
}

/** The first rule that matches, or null when none does and the request carries on
 *  through whatever else the route is protected by. */
export function evaluateWafRules(
    rules: readonly WafCustomRule[],
    facts: WafRequestFacts
): WafRuleVerdict | null {
    for (const rule of rules) {
        if (ruleMatches(rule, facts)) return { action: rule.action, rule };
    }
    return null;
}
