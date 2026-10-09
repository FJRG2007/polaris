/**
 * How a list of records is narrowed and ordered in the database: the shelf, the
 * trash, the search box and the sorts, as one Prisma `where` and `orderBy`.
 *
 * Nothing here filters or sorts in memory - a table of fifty thousand people is
 * paged by the database, the same `where` its totals are counted over.
 *
 * Server-only.
 */

import type { ViewSort } from "../model/views";
import { shelfWhere, type Shelf } from "./access";
import type { CrmObject } from "../model/objects";
import { columnOf, type ColumnSpec } from "./columns";

/** Case-insensitive `contains`. SQLite has no `mode` and its LIKE already
 *  ignores ASCII case; Postgres needs to be asked. */
export function contains(term: string): { contains: string; mode?: "insensitive" } {
    return process.env.POLARIS_DB_PROVIDER === "sqlite"
        ? { contains: term }
        : { contains: term, mode: "insensitive" };
}

/** The text columns the search box looks in, per kind of record. */
const SEARCHED: Readonly<Record<CrmObject, readonly string[]>> = {
    companies: ["name", "domain"],
    people: ["firstName", "lastName", "email", "jobTitle"],
    opportunities: ["name"]
};

/** The longest search worth sending to the database. */
export const MAX_SEARCH = 200;

/**
 * Every word of the search found in one of the searched columns: "ana garcia"
 * finds Ana García's first and last names, wherever each word landed.
 */
export function searchWhere(object: CrmObject, search: string): Record<string, unknown> {
    const words = search.trim().slice(0, MAX_SEARCH).split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length === 0) return {};
    return {
        AND: words.map((word) => ({
            OR: SEARCHED[object].map((column) => ({ [column]: contains(word) }))
        }))
    };
}

/** The rows a list reads: this shelf, in or out of the trash, matching the search. */
export function listWhere(
    object: CrmObject,
    shelf: Shelf,
    options: { readonly search?: string; readonly deleted?: boolean }
): Record<string, unknown> {
    return {
        ...shelfWhere(shelf),
        deletedAt: options.deleted ? { not: null } : null,
        ...searchWhere(object, options.search ?? "")
    };
}

/** Columns that may hold null, so a sort puts their empty rows last. */
const NULLABLE = new Set(["employees", "annualRevenue", "amount", "closeDate"]);

function order(column: string, direction: "asc" | "desc"): Record<string, unknown> {
    return { [column]: NULLABLE.has(column) ? { sort: direction, nulls: "last" } : direction };
}

const REF_ORDER: Readonly<Record<string, string>> = {
    companies: "name",
    opportunities: "name",
    people: "firstName",
    user: "name"
};

/** One sort as Prisma `orderBy` entries. */
function sortOrder(spec: ColumnSpec, direction: "asc" | "desc"): Record<string, unknown>[] {
    switch (spec.type) {
        case "scalar":
        case "day":
            return [order(spec.column, direction)];
        case "name":
            return [order(spec.first, direction), order(spec.last, direction)];
        case "money":
            return [order(spec.amount, direction)];
        case "ref":
            return [{ [spec.relation]: { [REF_ORDER[spec.target]!]: direction } }];
    }
}

/**
 * The order a list is read in: the view's sorts, then newest first, then the
 * id - so two rows that tie on everything still come back in one order and a
 * page boundary never shows a row twice.
 */
export function listOrder(object: CrmObject, sorts: readonly ViewSort[]): Record<string, unknown>[] {
    return [
        ...sorts.flatMap((sort) => sortOrder(columnOf(object, sort.key), sort.direction)),
        { createdAt: "desc" },
        { id: "desc" }
    ];
}
