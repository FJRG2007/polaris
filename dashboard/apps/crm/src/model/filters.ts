/**
 * A view's filter: rules on fields, joined by "all of" or "any of", with groups
 * of rules one level down - "stage is Proposal, and (amount over 10 000 or the
 * owner is Ana)".
 *
 * A rule being written is kept as it is - a field and an operator chosen, the
 * value not typed yet - and narrows nothing until it is whole, so the panel
 * never loses what somebody is halfway through. `ruleComplete` is the one test
 * of "whole", read by the server that applies a rule and by the screen that
 * counts the active ones.
 *
 * Client-safe.
 */

import { z } from "zod";
import { isCalendarDay } from "./values";
import { fieldOf, type CrmObject, type FieldKind, type Ref } from "./objects";

export const FILTER_OPERATORS = [
    "contains",
    "notContains",
    "is",
    "greaterThan",
    "lessThan",
    "before",
    "after",
    "isAnyOf",
    "isNoneOf",
    "isTrue",
    "isFalse",
    "isEmpty",
    "isNotEmpty"
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const CONJUNCTIONS = ["and", "or"] as const;

export type Conjunction = (typeof CONJUNCTIONS)[number];

/** The most rules one filter holds, counting the ones inside groups. */
export const MAX_RULES = 30;
/** The most choices one "is any of" rule holds. */
export const MAX_CHOICES = 50;
/** The longest text a rule compares against. */
export const MAX_FILTER_TEXT = 200;

const TEXT_OPERATORS: readonly FilterOperator[] = [
    "contains",
    "notContains",
    "isEmpty",
    "isNotEmpty"
];

/** The operators that make sense for a kind of field, the first one the default. */
export function operatorsFor(kind: FieldKind): readonly FilterOperator[] {
    switch (kind) {
        case "number":
        case "currency":
            return ["is", "greaterThan", "lessThan", "isEmpty", "isNotEmpty"];
        case "date":
            return ["is", "before", "after", "isEmpty", "isNotEmpty"];
        // Never empty: a moment Polaris wrote.
        case "dateTime":
            return ["is", "before", "after"];
        // Always one of its options.
        case "select":
            return ["isAnyOf", "isNoneOf"];
        case "boolean":
            return ["isTrue", "isFalse"];
        case "member":
        case "relation":
            return ["isAnyOf", "isNoneOf", "isEmpty", "isNotEmpty"];
        default:
            return TEXT_OPERATORS;
    }
}

/** What an operator compares against: nothing, a text, a number, a day or a set. */
export type OperandKind = "none" | "text" | "number" | "day" | "choices";

export function operandOf(kind: FieldKind, operator: FilterOperator): OperandKind {
    switch (operator) {
        case "isEmpty":
        case "isNotEmpty":
        case "isTrue":
        case "isFalse":
            return "none";
        case "contains":
        case "notContains":
            return "text";
        case "isAnyOf":
        case "isNoneOf":
            return "choices";
        case "before":
        case "after":
            return "day";
        case "is":
        case "greaterThan":
        case "lessThan":
            return kind === "date" || kind === "dateTime" ? "day" : "number";
    }
}

const refSchema = z.object({ id: z.string().min(1).max(64), name: z.string().max(200) });

const valueSchema = z.union([
    z.string().max(MAX_FILTER_TEXT),
    z.number().finite(),
    z.array(refSchema).max(MAX_CHOICES),
    z.null()
]);

export type FilterValue = z.infer<typeof valueSchema>;

const ruleSchema = z.object({
    id: z.string().min(1).max(40),
    key: z.string().min(1).max(64),
    operator: z.enum(FILTER_OPERATORS),
    value: valueSchema
});

export type FilterRule = z.infer<typeof ruleSchema>;

const groupSchema = z.object({
    id: z.string().min(1).max(40),
    conjunction: z.enum(CONJUNCTIONS),
    rules: z.array(ruleSchema).max(MAX_RULES)
});

export type FilterGroup = z.infer<typeof groupSchema>;

export type FilterItem = FilterRule | FilterGroup;

export const filterSchema = z.object({
    conjunction: z.enum(CONJUNCTIONS),
    rules: z.array(z.union([groupSchema, ruleSchema])).max(MAX_RULES)
});

export type ViewFilter = z.infer<typeof filterSchema>;

export const EMPTY_FILTER: ViewFilter = { conjunction: "and", rules: [] };

export function isGroup(item: FilterItem): item is FilterGroup {
    return "rules" in item;
}

/** A value read for what an operator needs, or null when it does not hold it. */
function operand(kind: FieldKind, operator: FilterOperator, value: FilterValue): FilterValue {
    switch (operandOf(kind, operator)) {
        case "none":
            return null;
        case "text":
            return typeof value === "string" ? value : null;
        case "number":
            return typeof value === "number" ? value : null;
        case "day":
            return typeof value === "string" && isCalendarDay(value) ? value : null;
        case "choices":
            return Array.isArray(value) ? value : null;
    }
}

/** Whether a rule narrows anything yet: its value is there when it needs one. */
export function ruleComplete(object: CrmObject, rule: FilterRule): boolean {
    const field = fieldOf(object, rule.key);
    if (!field || !operatorsFor(field.kind).includes(rule.operator)) return false;
    switch (operandOf(field.kind, rule.operator)) {
        case "none":
            return true;
        case "text":
            return typeof rule.value === "string" && rule.value.trim() !== "";
        case "number":
            return typeof rule.value === "number" && Number.isFinite(rule.value);
        case "day":
            return typeof rule.value === "string" && isCalendarDay(rule.value);
        case "choices":
            return Array.isArray(rule.value) && rule.value.length > 0;
    }
}

/** How many whole rules a filter holds, inside groups too. */
export function activeRules(object: CrmObject, filter: ViewFilter): number {
    return filter.rules.reduce(
        (sum, item) =>
            sum +
            (isGroup(item)
                ? item.rules.filter((rule) => ruleComplete(object, rule)).length
                : ruleComplete(object, item)
                  ? 1
                  : 0),
        0
    );
}

/** A choice of a select field, as a filter holds it. */
export function optionChoice(option: string): Ref {
    return { id: option, name: "" };
}

function readRule(object: CrmObject, raw: unknown): FilterRule | null {
    const rule = ruleSchema.safeParse(raw);
    if (!rule.success) return null;
    const field = fieldOf(object, rule.data.key);
    if (!field || !operatorsFor(field.kind).includes(rule.data.operator)) return null;
    let value = operand(field.kind, rule.data.operator, rule.data.value);
    // A choice of a select is one of its options, whatever was stored.
    if (Array.isArray(value) && field.kind === "select") {
        value = value.filter((choice) => field.options?.includes(choice.id));
    }
    // A person or a record is chosen by its id, which is a UUID.
    if (Array.isArray(value) && (field.kind === "member" || field.kind === "relation")) {
        value = value.filter((choice) => z.string().uuid().safeParse(choice.id).success);
    }
    return { ...rule.data, value };
}

/**
 * A stored or sent filter made whole for today's fields: a rule on a field that
 * is gone, or with an operator its field no longer has, is dropped; a value the
 * operator cannot use is emptied, so the rule waits for one; a group left with
 * no rules is dropped. Anything unreadable is no filter.
 */
export function readFilter(object: CrmObject, raw: unknown): ViewFilter {
    const parsed = z
        .object({ conjunction: z.enum(CONJUNCTIONS), rules: z.array(z.unknown()) })
        .safeParse(raw);
    if (!parsed.success) return EMPTY_FILTER;
    const rules: FilterItem[] = [];
    let count = 0;
    for (const entry of parsed.data.rules) {
        if (count >= MAX_RULES) break;
        const group = groupSchema
            .omit({ rules: true })
            .extend({ rules: z.array(z.unknown()) })
            .safeParse(entry);
        if (group.success) {
            const inner: FilterRule[] = [];
            for (const one of group.data.rules) {
                const rule = readRule(object, one);
                if (rule && count < MAX_RULES) {
                    inner.push(rule);
                    count += 1;
                }
            }
            if (inner.length > 0) rules.push({ ...group.data, rules: inner });
            continue;
        }
        const rule = readRule(object, entry);
        if (rule) {
            rules.push(rule);
            count += 1;
        }
    }
    return { conjunction: parsed.data.conjunction, rules };
}

/** The filter with its unfinished rules and emptied groups taken out: what a
 *  read is keyed by, so typing half a rule does not read the list again. */
export function completeFilter(object: CrmObject, filter: ViewFilter): ViewFilter {
    const rules: FilterItem[] = [];
    for (const item of filter.rules) {
        if (isGroup(item)) {
            const inner = item.rules.filter((rule) => ruleComplete(object, rule));
            if (inner.length > 0) rules.push({ ...item, rules: inner });
        } else if (ruleComplete(object, item)) {
            rules.push(item);
        }
    }
    return { conjunction: filter.conjunction, rules };
}
