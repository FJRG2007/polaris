/**
 * A view's filter as a Prisma `where`, so the database narrows the rows - the
 * same `where` a list is paged by and its totals are counted over.
 *
 * Only whole rules narrow (`ruleComplete`); one being written is skipped. Days
 * are calendar days in UTC, the way a close date is stored; a "created on" day
 * is the UTC day too.
 *
 * Server-only.
 */

import { columnOf, dayDate } from "./columns";
import { fieldOf, type CrmObject, type FieldDef } from "../model/objects";
import {
    isGroup,
    ruleComplete,
    type FilterRule,
    type Conjunction,
    type ViewFilter
} from "../model/filters";

type Where = Record<string, unknown>;

/** Case-insensitive `contains`. SQLite has no `mode` and its LIKE already
 *  ignores ASCII case; Postgres needs to be asked. */
export function contains(term: string): { contains: string; mode?: "insensitive" } {
    return process.env.POLARIS_DB_PROVIDER === "sqlite"
        ? { contains: term }
        : { contains: term, mode: "insensitive" };
}

const DAY_MS = 86_400_000;

function nextDay(day: string): Date {
    return new Date(dayDate(day).getTime() + DAY_MS);
}

/** Every word somewhere in one of the columns: "ana gar" finds Ana García. */
function wordsIn(columns: readonly string[], text: string): Where {
    const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    return {
        AND: words.map((word) => ({ OR: columns.map((column) => ({ [column]: contains(word) })) }))
    };
}

/** A text-like rule over string columns that are "" when empty. */
function textRule(columns: readonly string[], rule: FilterRule): Where {
    const empty: Where = { AND: columns.map((column) => ({ [column]: "" })) };
    switch (rule.operator) {
        case "contains":
            return wordsIn(columns, rule.value as string);
        case "notContains":
            return { NOT: wordsIn(columns, rule.value as string) };
        case "isEmpty":
            return empty;
        default:
            return { NOT: empty };
    }
}

/** A number, an amount or a day compared, on a column that may be null. */
function compareRule(column: string, field: FieldDef, rule: FilterRule): Where {
    const day = field.kind === "date" || field.kind === "dateTime";
    const value = rule.value as string | number;
    switch (rule.operator) {
        case "isEmpty":
            return { [column]: null };
        case "isNotEmpty":
            return { [column]: { not: null } };
        case "is":
            if (field.kind === "dateTime") {
                return { [column]: { gte: dayDate(value as string), lt: nextDay(value as string) } };
            }
            return { [column]: day ? dayDate(value as string) : value };
        case "greaterThan":
            return { [column]: { gt: value } };
        case "lessThan":
            return { [column]: { lt: value } };
        case "before":
            return { [column]: { lt: dayDate(value as string) } };
        default:
            // "after" a day: from the start of the next one.
            return {
                [column]: field.kind === "dateTime" ? { gte: nextDay(value as string) } : { gt: dayDate(value as string) }
            };
    }
}

/** One whole rule as a `where`. */
export function ruleWhere(object: CrmObject, rule: FilterRule): Where | null {
    const field = fieldOf(object, rule.key);
    if (!field || !ruleComplete(object, rule)) return null;
    const spec = columnOf(object, field.key);
    const ids = Array.isArray(rule.value) ? rule.value.map((choice) => choice.id) : [];
    switch (spec.type) {
        case "name":
            return textRule([spec.first, spec.last], rule);
        case "money":
            return compareRule(spec.amount, field, rule);
        case "day":
            return compareRule(spec.column, field, rule);
        case "ref":
            switch (rule.operator) {
                case "isAnyOf":
                    return { [spec.column]: { in: ids } };
                // A record pointing at nothing is none of them too.
                case "isNoneOf":
                    return { OR: [{ [spec.column]: null }, { [spec.column]: { notIn: ids } }] };
                case "isEmpty":
                    return { [spec.column]: null };
                default:
                    return { [spec.column]: { not: null } };
            }
        case "scalar":
            switch (field.kind) {
                case "select":
                    return rule.operator === "isAnyOf"
                        ? { [spec.column]: { in: ids } }
                        : { [spec.column]: { notIn: ids } };
                case "boolean":
                    return { [spec.column]: rule.operator === "isTrue" };
                case "number": {
                    // A count is a whole number: "over 2.5" is "over 2", and
                    // nothing is exactly 2.5.
                    const value = rule.value as number;
                    if (Number.isInteger(value)) return compareRule(spec.column, field, rule);
                    if (rule.operator === "is") return { id: { in: [] } };
                    const whole = rule.operator === "greaterThan" ? Math.floor(value) : Math.ceil(value);
                    return compareRule(spec.column, field, { ...rule, value: whole });
                }
                case "dateTime":
                    return compareRule(spec.column, field, rule);
                default:
                    return textRule([spec.column], rule);
            }
    }
}

function joined(conjunction: Conjunction, parts: Where[]): Where | null {
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0]!;
    return conjunction === "and" ? { AND: parts } : { OR: parts };
}

/** A whole filter as a `where`; an empty object when it narrows nothing. */
export function filterWhere(object: CrmObject, filter: ViewFilter): Where {
    const parts: Where[] = [];
    for (const item of filter.rules) {
        if (isGroup(item)) {
            const inner = item.rules
                .map((rule) => ruleWhere(object, rule))
                .filter((where): where is Where => where !== null);
            const group = joined(item.conjunction, inner);
            if (group) parts.push(group);
        } else {
            const where = ruleWhere(object, item);
            if (where) parts.push(where);
        }
    }
    return joined(filter.conjunction, parts) ?? {};
}
