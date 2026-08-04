/**
 * Evaluating the firewall's custom rules.
 *
 * A rule is a list of conditions over facts the edge already has about a request -
 * where it came from, what it asked for, what it said it was - and an action to take
 * when they all hold. A condition is either one test or a group of them read as an
 * `all` or an `any`, which is what lets one rule say "from this network, and asking
 * for either of these two things". Rules are tried in order and the first one to
 * decide wins, so a narrow `allow` above a broad `block` is an exception rather than a
 * contradiction. A `skip` does not decide - it records what the request no longer has
 * to pass and lets the walk carry on, which is the precise version of the same
 * exception.
 *
 * A test can also read one of the signature checks directly (`sql_injection`, `xss`,
 * `browser_integrity`). Those are managed rules with a switch of their own, and making
 * them conditions is what lets a rule narrow one to a hostname instead of turning it
 * off for a whole scope - and what gives every managed rule an expression that can be
 * copied into a rule of your own.
 *
 * Deliberately pure and I/O-free: the same function runs in the co-located edge
 * guard, where there is no database to consult, and in tests, where there is nothing
 * to stub. That is also why no field needs a lookup - no geolocation, no reputation,
 * nothing that would turn a request into a network call and the firewall into
 * something that stops working when Polaris does.
 */

import { ipAllowed } from "./cidr.js";
import { injectionFailure } from "./waf-injection.js";
import { browserIntegrityFailure } from "./waf-integrity.js";
import { isWafConditionGroup, isWafSignalCondition } from "./schemas/deploy.js";
import type {
    WafCondition,
    WafCustomRule,
    WafLeafCondition,
    WafRuleAction,
    WafSignalCondition,
    WafSkipComponent
} from "./schemas/deploy.js";

/** The request as the edge forwards it. Any fact can be missing - a client is not
 *  obliged to send a user agent, and a proxy may not forward an address. */
export interface WafRequestFacts {
    readonly ip?: string | null;
    readonly host?: string | null;
    readonly path?: string | null;
    readonly method?: string | null;
    readonly userAgent?: string | null;
    readonly query?: string | null;
    /** Read only by the browser integrity signal, which is about the shape of the
     *  request rather than about what it asked for. Absent everywhere else, and a
     *  rule that tests the signal without them simply finds a request that fails it. */
    readonly accept?: string | null;
    readonly acceptLanguage?: string | null;
    readonly acceptEncoding?: string | null;
}

/** The operators that mean "none of the values match" rather than "one does". */
const NEGATIVE = new Set(["not_equals", "not_contains", "not_starts_with", "not_ends_with"]);

/**
 * The fact a condition reads, lowercased where case is not meaningful. A path and a
 * query string are compared as sent; a hostname, a method and a user agent are not
 * case-sensitive in any way an operator would expect to have to think about.
 */
function factFor(field: WafLeafCondition["field"], facts: WafRequestFacts): string | null {
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
function normalizeValue(field: WafLeafCondition["field"], value: string): string {
    const trimmed = value.trim();
    if (field === "host" || field === "user_agent") return trimmed.toLowerCase();
    if (field === "method") return trimmed.toUpperCase();
    return trimmed;
}

/** Whether one value satisfies the operator against the fact. */
function matchesValue(operator: WafLeafCondition["operator"], fact: string, value: string): boolean {
    switch (operator) {
        case "equals":
        case "not_equals":
            return fact === value;
        case "contains":
        case "not_contains":
            return fact.includes(value);
        case "starts_with":
        case "not_starts_with":
            return fact.startsWith(value);
        case "ends_with":
        case "not_ends_with":
            return fact.endsWith(value);
    }
}

/**
 * Whether one test holds.
 *
 * A missing fact never satisfies a condition, including a negative one: "the user
 * agent is not curl" must not become true for a request that sent no user agent at
 * all, because that is exactly what a client avoiding the rule would send. The
 * address is the one field with its own comparison - an entry there is an IP or a
 * CIDR range, so it is matched by containment rather than by string.
 */
function leafHolds(condition: WafLeafCondition, facts: WafRequestFacts): boolean {
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

/**
 * Whether a signature check would refuse this request.
 *
 * The same functions the guard runs as managed rules, called here so a hand-written
 * rule can talk about them: "a SQL payload, but only on this hostname" is one rule
 * rather than a protection switched off for a whole scope. Only the class being asked
 * about is scanned, so testing for XSS does not pay for the SQL signatures.
 */
function signalHolds(condition: WafSignalCondition, facts: WafRequestFacts): boolean {
    const hit =
        condition.signal === "browser_integrity"
            ? browserIntegrityFailure({
                  userAgent: facts.userAgent,
                  accept: facts.accept,
                  acceptLanguage: facts.acceptLanguage,
                  acceptEncoding: facts.acceptEncoding
              }) !== null
            : injectionFailure(
                  { path: facts.path, query: facts.query, userAgent: facts.userAgent },
                  { sql: condition.signal === "sql_injection", xss: condition.signal === "xss" }
              ) !== null;
    return condition.negate ? !hit : hit;
}

/**
 * Whether one condition holds - a test, or a group read as its own `all`/`any`.
 *
 * Short-circuits the way the operators read, so a group whose answer is already
 * settled costs nothing more: a rule's cost is what its first few conditions decide,
 * not what it could look at.
 */
export function conditionHolds(condition: WafCondition, facts: WafRequestFacts): boolean {
    if (isWafSignalCondition(condition)) return signalHolds(condition, facts);
    if (!isWafConditionGroup(condition)) return leafHolds(condition, facts);
    return condition.match === "any"
        ? condition.conditions.some((entry) => conditionHolds(entry, facts))
        : condition.conditions.every((entry) => conditionHolds(entry, facts));
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

/** What the rule set had to say about one request. */
export interface WafRuleOutcome {
    /** The rule that decided it outright, or null when none did and the request
     *  carries on through whatever else the route is protected by. */
    readonly verdict: WafRuleVerdict | null;
    /** What the `skip` rules that matched on the way step over. Empty for almost
     *  every request, which is why the caller can test it and move on. */
    readonly skipped: ReadonlySet<WafSkipComponent>;
    /** The names of those rules, so a skipped check can say what skipped it. */
    readonly skippedBy: readonly string[];
}

const NOTHING_SKIPPED: ReadonlySet<WafSkipComponent> = new Set();

/**
 * Run the rule set over one request.
 *
 * `block` and `allow` decide and stop, the way first-match-wins has always worked
 * here. `skip` does not decide: it notes what the request no longer has to pass and
 * carries on, so "this SDK is not an attacker" can step over the injection checks
 * without also stepping over the address denylist or the login. A skip that names the
 * remaining custom rules stops the walk as well, which is the one that reads like
 * Cloudflare's - everything below this rule is off for this request.
 */
export function evaluateWafRules(rules: readonly WafCustomRule[], facts: WafRequestFacts): WafRuleOutcome {
    let skipped: Set<WafSkipComponent> | null = null;
    const skippedBy: string[] = [];

    for (const rule of rules) {
        if (!ruleMatches(rule, facts)) continue;
        if (rule.action !== "skip") {
            return { verdict: { action: rule.action, rule }, skipped: skipped ?? NOTHING_SKIPPED, skippedBy };
        }
        skipped ??= new Set();
        for (const component of rule.skip ?? []) skipped.add(component);
        skippedBy.push(rule.name);
        if (skipped.has("custom_rules")) break;
    }
    return { verdict: null, skipped: skipped ?? NOTHING_SKIPPED, skippedBy };
}
