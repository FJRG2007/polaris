/**
 * What an organization's role is held to in its CRM beyond seeing, changing
 * and deleting a kind of record: whether it reaches every record or only the
 * ones its holder owns or made, which fields it never sees, and which it sees
 * but may not change.
 *
 * Pure: shared by the server, which enforces it, and the screens, which hide
 * and lock what the server would refuse.
 */

import { z } from "zod";
import { CRM_OBJECTS } from "@polaris/core";
import { fieldsOf, type CrmObject, type CrmRecord, type FieldDef } from "./objects";

export const ROW_SCOPES = ["all", "own"] as const;

export type RowScope = (typeof ROW_SCOPES)[number];

export interface ObjectRule {
    /** "own": only records the reader owns or made. */
    readonly rows: RowScope;
    /** Fields never sent to this role. */
    readonly hidden: readonly string[];
    /** Fields this role sees but may not change. */
    readonly readOnly: readonly string[];
}

export type RoleRules = Readonly<Record<CrmObject, ObjectRule>>;

export const OPEN_RULE: ObjectRule = { rows: "all", hidden: [], readOnly: [] };

export const OPEN_RULES: RoleRules = Object.fromEntries(
    CRM_OBJECTS.map((object) => [object, OPEN_RULE])
) as unknown as RoleRules;

const fieldKeys = z.array(z.string().min(1).max(64)).max(64);

export const ruleSchema = z.object({
    rows: z.enum(ROW_SCOPES),
    hidden: fieldKeys,
    readOnly: fieldKeys
});

export const roleRuleSchema = ruleSchema.extend({
    role: z.string().min(1).max(64),
    object: z.enum(CRM_OBJECTS)
});

export type RoleRuleInput = z.infer<typeof roleRuleSchema>;

export interface StoredRule {
    readonly object: string;
    readonly rows: string;
    readonly hidden: string;
    readonly readOnly: string;
}

function keyList(text: string): string[] | null {
    try {
        const parsed = fieldKeys.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Stored rows as rules: a kind of record without a row, or with a row that
 *  does not read, is left open. */
export function readRules(rows: readonly StoredRule[]): RoleRules {
    const rules: Record<string, ObjectRule> = { ...OPEN_RULES };
    for (const row of rows) {
        if (!(CRM_OBJECTS as readonly string[]).includes(row.object)) continue;
        const hidden = keyList(row.hidden);
        const readOnly = keyList(row.readOnly);
        if (!hidden || !readOnly || !(ROW_SCOPES as readonly string[]).includes(row.rows)) continue;
        rules[row.object] = { rows: row.rows as RowScope, hidden, readOnly };
    }
    return rules as RoleRules;
}

export type RuleCheck =
    | { readonly ok: true; readonly rule: ObjectRule }
    | { readonly ok: false; readonly reason: "unknownField" | "nameLocked" };

/**
 * A rule as it would be stored: each field named once, a hidden field not also
 * read-only (hidden already keeps it from being changed). A field the record
 * does not have is refused, and so is its name: a record nobody can name
 * cannot be listed.
 */
export function checkRule(
    object: CrmObject,
    rule: z.infer<typeof ruleSchema>,
    custom: readonly FieldDef[] = []
): RuleCheck {
    const fields = new Map(fieldsOf(object, custom).map((field) => [field.key, field]));
    for (const key of [...rule.hidden, ...rule.readOnly]) {
        const field = fields.get(key);
        if (!field) return { ok: false, reason: "unknownField" };
        if (field.primary) return { ok: false, reason: "nameLocked" };
    }
    const hidden = [...new Set(rule.hidden)];
    const readOnly = [...new Set(rule.readOnly)].filter((key) => !hidden.includes(key));
    return { ok: true, rule: { rows: rule.rows, hidden, readOnly } };
}

/** The column naming who a record belongs to, where it has one. */
const OWNER_COLUMN: Readonly<Record<CrmObject, string | null>> = {
    companies: "accountOwnerId",
    people: null,
    opportunities: "ownerId"
};

/** The records somebody owns or made, as a Prisma `where`. */
export function ownWhere(object: CrmObject, userId: string): Record<string, unknown> {
    const owner = OWNER_COLUMN[object];
    return owner ? { OR: [{ [owner]: userId }, { createdById: userId }] } : { createdById: userId };
}

/** A record without the values its reader may not see. */
export function hideValues(record: CrmRecord, hidden: readonly string[]): CrmRecord {
    if (hidden.length === 0) return record;
    const values = { ...record.values };
    for (const key of hidden) delete values[key];
    return { ...record, values };
}

/** The fields as a reader's role leaves them: hidden ones gone, read-only
 *  ones marked so. */
export function ruleFields(
    fields: readonly FieldDef[],
    rule: ObjectRule | null | undefined
): readonly FieldDef[] {
    if (!rule || (rule.hidden.length === 0 && rule.readOnly.length === 0)) return fields;
    return fields
        .filter((field) => !rule.hidden.includes(field.key))
        .map((field) => (rule.readOnly.includes(field.key) ? { ...field, readOnly: true } : field));
}

/** Every field a filter names, its nested groups included. */
export function filterKeys(filter: unknown): Set<string> {
    const keys = new Set<string>();
    const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const entry = node as { key?: unknown; rules?: unknown };
        if (typeof entry.key === "string") keys.add(entry.key);
        if (Array.isArray(entry.rules)) entry.rules.forEach(walk);
    };
    walk(filter);
    return keys;
}
