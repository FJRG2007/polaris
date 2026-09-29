/**
 * How a rule is said in words, and what the editor's selects offer.
 *
 * One module because the same rule is written twice on this screen - as a sentence in
 * the list and as the labels on the editor's own controls - and two copies drift. It
 * is pure and has no "use client" for the same reason: the list renders it, the editor
 * renders it, and a test can assert on it without a DOM.
 *
 * The expression form lives in @polaris/core, not here. It is parsed as well as
 * rendered now - an operator can edit it and a managed rule can be copied out of - so
 * it is the server's business as much as the screen's, and the round trip is held by
 * the same tests the engine is.
 */

import * as core from "@polaris/core";
import type { NamespaceTranslator } from "@/lib/i18n/types";

type WafCondition = core.WafCondition;
type WafCustomRule = core.WafCustomRule;
type WafLeafCondition = core.WafLeafCondition;
type WafRuleField = core.WafRuleField;
type WafRuleOperator = core.WafRuleOperator;
type WafRuleSignal = core.WafRuleSignal;

type Words = NamespaceTranslator<"firewall">;

const FIELDS = ["ip", "host", "path", "method", "user_agent", "query"] as const satisfies readonly WafRuleField[];
const SIGNALS = ["sql_injection", "xss", "browser_integrity"] as const satisfies readonly WafRuleSignal[];
const OPERATORS = [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "not_starts_with",
    "ends_with",
    "not_ends_with"
] as const satisfies readonly WafRuleOperator[];

/** What each field is called where an operator reads it, rather than where it is
 *  stored. */
export function fieldLabel(t: Words, field: WafRuleField): string {
    return t(`rules.fields.${field}`);
}

/** The signature checks, named as the managed rule that owns them is - so somebody
 *  who turned "Block SQL injection" on recognises it in the field list. */
export function signalLabel(t: Words, signal: WafRuleSignal): string {
    return t(`rules.signals.${signal}`);
}

export function operatorLabel(t: Words, operator: WafRuleOperator): string {
    return t(`rules.operators.${operator}`);
}

/** An address is matched by containment, not by string, so the operators that read a
 *  value as text have nothing to do there. */
export const IP_OPERATORS: WafRuleOperator[] = ["equals", "not_equals"];

/** A signature check has no value, so its two operators are the whole choice. */
export function signalOperators(t: Words) {
    return [
        { value: "matches", label: t("rules.signalOperators.matches") },
        { value: "not_matches", label: t("rules.signalOperators.notMatches") }
    ];
}

/** An example of the value that field takes, so the field says what it wants. */
export function valuePlaceholder(t: Words, field: WafRuleField): string {
    return field === "ip" ? t("rules.ipExample") : VALUE_EXAMPLES[field];
}

/** Examples of input, the same in every language. */
const VALUE_EXAMPLES: Record<Exclude<WafRuleField, "ip">, string> = {
    host: "admin.example.com",
    path: "/wp-admin",
    method: "POST",
    user_agent: "curl",
    query: "debug=1"
};

/**
 * The Field select: the request's own facts first, then the checks.
 *
 * A signal is offered as a field rather than hidden behind a second control, because
 * from where an operator is standing "SQL injection check" is the same kind of answer
 * to "what should this rule look at?" as "User agent" is.
 */
export function fieldOptions(t: Words) {
    return [
        ...FIELDS.map((field) => ({ value: field as string, label: fieldLabel(t, field) })),
        ...SIGNALS.map((signal) => ({ value: `signal:${signal}`, label: signalLabel(t, signal) }))
    ];
}

/** The value the Field select shows for one condition. */
export function fieldValue(condition: WafLeafCondition | core.WafSignalCondition): string {
    return core.isWafSignalCondition(condition) ? `signal:${condition.signal}` : condition.field;
}

/** The operators that field accepts, so an operator that cannot apply is never
 *  offered rather than being offered and quietly ignored. */
export function operatorOptions(field: WafRuleField, t: Words) {
    const operators = field === "ip" ? IP_OPERATORS : OPERATORS;
    return operators.map((operator) => ({ value: operator, label: operatorLabel(t, operator) }));
}

/** The rule as a sentence, for the list's Description column. Long value lists are
 *  cut with a count rather than a bare ellipsis: "and 12 more" tells the reader how
 *  much they are not seeing, which is the thing an ellipsis leaves out. */
export function ruleDescription(rule: Pick<WafCustomRule, "conditions">, t: Words): string {
    return rule.conditions.map((condition) => describeCondition(condition, t)).join(t("rules.and"));
}

const VALUES_SHOWN = 3;

function describeCondition(condition: WafCondition, t: Words): string {
    if (core.isWafSignalCondition(condition)) {
        const label = signalLabel(t, condition.signal);
        return condition.negate ? t("rules.signalOff", { label }) : t("rules.signalOn", { label });
    }
    if (core.isWafConditionGroup(condition)) {
        const joiner = condition.match === "any" ? t("rules.or") : t("rules.and");
        return `(${condition.conditions.map((inner) => describeCondition(inner, t)).join(joiner)})`;
    }
    const field = fieldLabel(t, condition.field);
    const operator = operatorLabel(t, condition.operator);
    if (condition.values.length === 0) return `${field} ${operator} ...`;
    const shown = condition.values.slice(0, VALUES_SHOWN).join(", ");
    const rest = condition.values.length - VALUES_SHOWN;
    return rest > 0 ? t("rules.moreValues", { field, operator, shown, rest }) : `${field} ${operator} ${shown}`;
}

/** A test with nothing in it yet. */
export function emptyCondition(): WafLeafCondition {
    return { field: "path", operator: "contains", values: [] };
}
