/**
 * How a rule is said in words and in expression form.
 *
 * One module because the same rule is written three times on this screen - as a
 * sentence in the list, as an expression under the editor, and as the labels on the
 * editor's own selects - and three copies drift. It is also why this is pure and has
 * no "use client": the list renders it, the editor renders it, and a test can assert
 * on it without a DOM.
 *
 * The expression is not a second source of truth. It is a rendering of the same
 * `WafCustomRule` the engine evaluates, in the shape an operator who has used a WAF
 * before already reads: values within a condition are an `or`, conditions are joined
 * by `and`. It is deliberately not editable - a text expression the engine cannot
 * parse back would be a second rule format to keep in step with the first.
 */

import type { WafCondition, WafCustomRule, WafRuleField, WafRuleOperator } from "@polaris/core";

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

/** The field as an expression names it. Modelled on the wirefilter-style names a
 *  Cloudflare user already knows, so the preview reads as a rule rather than as our
 *  column names in a different font. */
const FIELD_TOKENS: Record<WafRuleField, string> = {
    ip: "ip.src",
    host: "http.host",
    path: "http.request.uri.path",
    method: "http.request.method",
    user_agent: "http.user_agent",
    query: "http.request.uri.query"
};

const OPERATOR_TOKENS: Record<WafRuleOperator, string> = {
    equals: "eq",
    not_equals: "ne",
    contains: "contains",
    not_contains: "not contains",
    starts_with: "starts_with",
    not_starts_with: "not starts_with",
    ends_with: "ends_with",
    not_ends_with: "not ends_with"
};

/** An address is matched by containment, not by string, so the operators that read a
 *  value as text have nothing to do there. */
export const IP_OPERATORS: WafRuleOperator[] = ["equals", "not_equals"];

/** An example of the value that field takes, so the field says what it wants. */
export const VALUE_PLACEHOLDER: Record<WafRuleField, string> = {
    ip: "203.0.113.4 or 203.0.113.0/24",
    host: "admin.example.com",
    path: "/wp-admin",
    method: "POST",
    user_agent: "curl",
    query: "debug=1"
};

export const FIELD_OPTIONS = (Object.keys(FIELD_LABELS) as WafRuleField[]).map((field) => ({
    value: field,
    label: FIELD_LABELS[field]
}));

/** The operators that field accepts, so an operator that cannot apply is never
 *  offered rather than being offered and quietly ignored. */
export function operatorOptions(field: WafRuleField) {
    const operators = field === "ip" ? IP_OPERATORS : (Object.keys(OPERATOR_LABELS) as WafRuleOperator[]);
    return operators.map((operator) => ({ value: operator, label: OPERATOR_LABELS[operator] }));
}

/** A value as the expression quotes it. Backslashes first, or escaping the quote
 *  would then escape its own escape. */
function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One condition as an expression. Several values are an `or` over the same field,
 *  which is what the engine does with them. */
function conditionExpression(condition: WafCondition): string {
    const field = FIELD_TOKENS[condition.field];
    const operator = OPERATOR_TOKENS[condition.operator];
    if (condition.values.length === 0) return `${field} ${operator} ...`;
    const parts = condition.values.map((value) => `${field} ${operator} ${quote(value)}`);
    return parts.length === 1 ? parts[0]! : `(${parts.join(" or ")})`;
}

/** The whole rule as one expression, in the same order the engine reads it. */
export function ruleExpression(rule: Pick<WafCustomRule, "conditions">): string {
    if (rule.conditions.length === 0) return "";
    const parts = rule.conditions.map(conditionExpression);
    return parts.length === 1 ? `(${parts[0]!})` : parts.map((part) => `(${part})`).join(" and ");
}

/** The rule as a sentence, for the list's Description column. Long value lists are
 *  cut with a count rather than a bare ellipsis: "and 12 more" tells the reader how
 *  much they are not seeing, which is the thing an ellipsis leaves out. */
export function ruleDescription(rule: Pick<WafCustomRule, "conditions">): string {
    return rule.conditions.map(describeCondition).join(" and ");
}

const VALUES_SHOWN = 3;

function describeCondition(condition: WafCondition): string {
    const field = FIELD_LABELS[condition.field];
    const operator = OPERATOR_LABELS[condition.operator];
    if (condition.values.length === 0) return `${field} ${operator} ...`;
    const shown = condition.values.slice(0, VALUES_SHOWN).join(", ");
    const rest = condition.values.length - VALUES_SHOWN;
    return rest > 0 ? `${field} ${operator} ${shown} and ${rest} more` : `${field} ${operator} ${shown}`;
}
