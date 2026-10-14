/**
 * Finding the records a new or changed one looks like: the same email, the
 * same domain, the same name. One query for a whole import batch, narrowed to
 * what the reader can see; a record in the trash is not one.
 *
 * Server-only.
 */

import { table } from "./columns";
import type { CrmObject } from "../model/objects";
import { recordWhere, type CrmActor } from "./access";
import {
    DUPLICATE_FIELDS,
    MAX_DUPLICATES,
    duplicateKeys,
    sharedKey,
    type Duplicate
} from "../model/duplicates";

/** The most rows one look for duplicates reads. */
const MAX_FOUND = 200;

const SELECT: Readonly<Record<CrmObject, Record<string, true>>> = {
    companies: { id: true, name: true, domain: true },
    people: { id: true, firstName: true, lastName: true, email: true },
    opportunities: { id: true, name: true }
};

/** A row read back as the values its keys are taken from. */
function valuesOf(object: CrmObject, row: Record<string, unknown>): Record<string, unknown> {
    if (object === "people") {
        return {
            name: { first: row.firstName ?? "", last: row.lastName ?? "" },
            email: row.email
        };
    }
    return { name: row.name, domain: row.domain };
}

function nameOf(object: CrmObject, row: Record<string, unknown>): string {
    if (object !== "people") return typeof row.name === "string" ? row.name : "";
    return [row.firstName, row.lastName]
        .filter((part) => typeof part === "string" && part)
        .join(" ");
}

/** The `where` that finds a stored value; email and domain are stored lower case. */
function clauseOf(object: CrmObject, key: string, value: unknown): Record<string, unknown> | null {
    if (key === "name" && object === "people") {
        const name = value as { first?: unknown; last?: unknown } | null;
        if (!name || typeof name !== "object") return null;
        const first = String(name.first ?? "").trim();
        const last = String(name.last ?? "").trim();
        if (!first && !last) return null;
        return {
            firstName: { equals: first, mode: "insensitive" },
            lastName: { equals: last, mode: "insensitive" }
        };
    }
    if (typeof value !== "string" || !value.trim()) return null;
    if (key === "name") return { name: { equals: value.trim(), mode: "insensitive" } };
    return { [key]: value.trim().toLowerCase() };
}

/**
 * For each set of values, the records already there that share a key with it,
 * leaving out `exclude` (the record itself, once made). Empty for a reader who
 * may not see this kind of record.
 */
export async function findDuplicates(
    actor: CrmActor,
    object: CrmObject,
    rows: readonly Readonly<Record<string, unknown>>[],
    exclude: readonly string[] = []
): Promise<Duplicate[][]> {
    const none = rows.map((): Duplicate[] => []);
    if (!actor.can[object].read) return none;
    const hidden = actor.rules?.[object].hidden ?? [];
    const clauses = new Map<string, Record<string, unknown>>();
    for (const values of rows) {
        for (const key of DUPLICATE_FIELDS[object]) {
            if (hidden.includes(key)) continue;
            const clause = clauseOf(object, key, values[key]);
            if (clause) clauses.set(JSON.stringify(clause), clause);
        }
    }
    if (clauses.size === 0) return none;
    const found = (await table(object).findMany({
        where: {
            ...recordWhere(actor, object),
            deletedAt: null,
            ...(exclude.length > 0 ? { id: { notIn: [...exclude] } } : {}),
            OR: [...clauses.values()]
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: MAX_FOUND,
        select: SELECT[object]
    })) as Record<string, unknown>[];
    const known = found.map((row) => ({
        row,
        keys: duplicateKeys(object, valuesOf(object, row), hidden)
    }));
    return rows.map((values) => {
        const wanted = duplicateKeys(object, values, hidden);
        const matches: Duplicate[] = [];
        for (const { row, keys } of known) {
            const key = sharedKey(wanted, keys);
            if (key) matches.push({ id: String(row.id), name: nameOf(object, row), key });
            if (matches.length === MAX_DUPLICATES) break;
        }
        return matches;
    });
}
