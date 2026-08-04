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

type WafCondition = core.WafCondition;
type WafCustomRule = core.WafCustomRule;
type WafLeafCondition = core.WafLeafCondition;
type WafRuleField = core.WafRuleField;
type WafRuleOperator = core.WafRuleOperator;
type WafRuleSignal = core.WafRuleSignal;

/** What each field is called where an operator reads it, rather than where it is
 *  stored. */
export const FIELD_LABELS: Record<WafRuleField, string> = {
    ip: "Client address",
    host: "Hostname",
    path: "URL path",
    method: "Request method",
    user_agent: "User agent",
    query: "Query string"
};

/** The signature checks, named as the managed rule that owns them is - so somebody
 *  who turned "Block SQL injection" on recognises it in the field list. */
export const SIGNAL_LABELS: Record<WafRuleSignal, string> = {
    sql_injection: "SQL injection check",
    xss: "Cross-site scripting check",
    browser_integrity: "Browser integrity check"
};

export const OPERATOR_LABELS: Record<WafRuleOperator, string> = {
    equals: "equals",
    not_equals: "does not equal",
    contains: "contains",
    not_contains: "does not contain",
    starts_with: "starts with",
    not_starts_with: "does not start with",
    ends_with: "ends with",
    not_ends_with: "does not end with"
};

/** An address is matched by containment, not by string, so the operators that read a
 *  value as text have nothing to do there. */
export const IP_OPERATORS: WafRuleOperator[] = ["equals", "not_equals"];

/** A signature check has no value, so its two operators are the whole choice. */
export const SIGNAL_OPERATORS = [
    { value: "matches", label: "would refuse the request" },
    { value: "not_matches", label: "would not refuse the request" }
];

/** An example of the value that field takes, so the field says what it wants. */
export const VALUE_PLACEHOLDER: Record<WafRuleField, string> = {
    ip: "203.0.113.4 or 203.0.113.0/24",
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
export const FIELD_OPTIONS = [
    ...(Object.keys(FIELD_LABELS) as WafRuleField[]).map((field) => ({
        value: field,
        label: FIELD_LABELS[field]
    })),
    ...(Object.keys(SIGNAL_LABELS) as WafRuleSignal[]).map((signal) => ({
        value: `signal:${signal}`,
        label: SIGNAL_LABELS[signal]
    }))
];

/** The value the Field select shows for one condition. */
export function fieldValue(condition: WafLeafCondition | core.WafSignalCondition): string {
    return core.isWafSignalCondition(condition) ? `signal:${condition.signal}` : condition.field;
}

/** The operators that field accepts, so an operator that cannot apply is never
 *  offered rather than being offered and quietly ignored. */
export function operatorOptions(field: WafRuleField) {
    const operators = field === "ip" ? IP_OPERATORS : (Object.keys(OPERATOR_LABELS) as WafRuleOperator[]);
    return operators.map((operator) => ({ value: operator, label: OPERATOR_LABELS[operator] }));
}

/** The rule as a sentence, for the list's Description column. Long value lists are
 *  cut with a count rather than a bare ellipsis: "and 12 more" tells the reader how
 *  much they are not seeing, which is the thing an ellipsis leaves out. */
export function ruleDescription(rule: Pick<WafCustomRule, "conditions">): string {
    return rule.conditions.map(describeCondition).join(" and ");
}

const VALUES_SHOWN = 3;

function describeCondition(condition: WafCondition): string {
    if (core.isWafSignalCondition(condition)) {
        const label = SIGNAL_LABELS[condition.signal];
        return condition.negate ? `${label} does not fire` : `${label} fires`;
    }
    if (core.isWafConditionGroup(condition)) {
        const joiner = condition.match === "any" ? " or " : " and ";
        return `(${condition.conditions.map(describeCondition).join(joiner)})`;
    }
    const field = FIELD_LABELS[condition.field];
    const operator = OPERATOR_LABELS[condition.operator];
    if (condition.values.length === 0) return `${field} ${operator} ...`;
    const shown = condition.values.slice(0, VALUES_SHOWN).join(", ");
    const rest = condition.values.length - VALUES_SHOWN;
    return rest > 0 ? `${field} ${operator} ${shown} and ${rest} more` : `${field} ${operator} ${shown}`;
}

/** A test with nothing in it yet. */
export function emptyCondition(): WafLeafCondition {
    return { field: "path", operator: "contains", values: [] };
}
