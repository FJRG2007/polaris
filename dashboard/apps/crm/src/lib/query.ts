/**
 * How a list of records is narrowed and ordered in the database: the shelf, the
 * trash, the search box, the view's filter, one group of a grouped list and the
 * sorts, as one Prisma `where` and `orderBy`.
 *
 * Nothing here filters or sorts in memory - a table of fifty thousand people is
 * paged by the database, the same `where` its totals are counted over.
 *
 * Server-only.
 */

import type { ViewSort } from "../model/views";
import { contains, filterWhere } from "./filters";
import type { ViewFilter } from "../model/filters";
import { shelfWhere, type Shelf } from "./access";
import type { CrmObject } from "../model/objects";
import { columnOf, type ColumnSpec } from "./columns";

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

/** One group of a grouped list or one column of a board: the records whose
 *  field holds this choice. */
export interface GroupScope {
    readonly key: string;
    readonly value: string;
}

export interface ListScope {
    readonly search?: string;
    readonly deleted?: boolean;
    readonly filter?: ViewFilter;
    readonly group?: GroupScope;
}

/** The rows a list reads: this shelf, in or out of the trash, matching the
 *  search and the filter, in one group when it is grouped. */
export function listWhere(
    object: CrmObject,
    shelf: Shelf,
    options: ListScope
): Record<string, unknown> {
    const narrowed = [
        searchWhere(object, options.search ?? ""),
        options.filter ? filterWhere(object, options.filter) : {},
        options.group ? groupWhere(object, options.group) : {}
    ].filter((part) => Object.keys(part).length > 0);
    return {
        ...shelfWhere(shelf),
        deletedAt: options.deleted ? { not: null } : null,
        ...(narrowed.length > 0 ? { AND: narrowed } : {})
    };
}

/** The records of one group. */
export function groupWhere(object: CrmObject, group: GroupScope): Record<string, unknown> {
    const spec = columnOf(object, group.key);
    if (spec.type !== "scalar") throw new Error(`crm: ${object} cannot group by ${group.key}`);
    return { [spec.column]: group.value };
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
 *
 * A board with no sorts is read in the order its cards were put in
 * (`byPosition`), so a card dragged between two others stays there.
 */
export function listOrder(
    object: CrmObject,
    sorts: readonly ViewSort[],
    byPosition = false
): Record<string, unknown>[] {
    return [
        ...sorts.flatMap((sort) => sortOrder(columnOf(object, sort.key), sort.direction)),
        ...(byPosition && sorts.length === 0 ? [{ position: "asc" }] : []),
        { createdAt: "desc" },
        { id: "desc" }
    ];
}
