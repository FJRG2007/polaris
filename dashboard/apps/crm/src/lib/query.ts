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
import { readFilter, type ViewFilter } from "../model/filters";
import { ownClause, shelfWhere, type CrmActor, type Shelf } from "./access";
import { slotOf, type CrmObject, type FieldDef } from "../model/objects";
import { columnOf, type ColumnSpec } from "./columns";

/** The text fields the search box looks in, per kind of record. */
const SEARCHED: Readonly<Record<CrmObject, readonly string[]>> = {
    companies: ["name", "domain"],
    people: ["name", "email", "jobTitle"],
    opportunities: ["name"]
};

/** The columns the search looks in, leaving out the fields kept hidden. */
function searchedColumns(object: CrmObject, hidden: readonly string[]): string[] {
    return SEARCHED[object]
        .filter((key) => !hidden.includes(key))
        .flatMap((key) => {
            const spec = columnOf(object, key);
            if (spec.type === "name") return [spec.first, spec.last];
            return spec.type === "scalar" ? [spec.column] : [];
        });
}

/** The longest search worth sending to the database. */
export const MAX_SEARCH = 200;

/**
 * Every word of the search found in one of the searched columns: "ana garcia"
 * finds Ana García's first and last names, wherever each word landed.
 */
export function searchWhere(
    object: CrmObject,
    search: string,
    hidden: readonly string[] = []
): Record<string, unknown> {
    const words = search.trim().slice(0, MAX_SEARCH).split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length === 0) return {};
    const columns = searchedColumns(object, hidden);
    if (columns.length === 0) return { id: { in: [] } };
    return {
        AND: words.map((word) => ({
            OR: columns.map((column) => ({ [column]: contains(word) }))
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
    /** The fields added on the shelf, so the filter can name them. */
    readonly custom?: readonly FieldDef[];
}

/** The rows a list reads: this shelf, in or out of the trash, matching the
 *  search and the filter, in one group when it is grouped - and, read for a
 *  reader whose role is held to their own records, only those. */
export function listWhere(
    object: CrmObject,
    scope: Shelf | CrmActor,
    options: ListScope
): Record<string, unknown> {
    const actor = "user" in scope ? scope : null;
    const shelf = actor ? actor.shelf : (scope as Shelf);
    const narrowed = [
        (actor && ownClause(actor, object)) ?? {},
        searchWhere(object, options.search ?? "", actor?.rules?.[object].hidden ?? []),
        options.filter
            ? filterWhere(
                  object,
                  readFilter(object, options.filter, options.custom),
                  options.custom
              )
            : {},
        options.group ? groupWhere(object, options.group) : {}
    ].filter((part) => Object.keys(part).length > 0);
    return {
        ...shelfWhere(shelf),
        deletedAt: options.deleted ? { not: null } : null,
        ...(narrowed.length > 0 ? { AND: narrowed } : {})
    };
}

/** The column a list is grouped on. */
export function groupColumn(object: CrmObject, key: string): string {
    const spec = columnOf(object, key);
    if (spec.type !== "scalar") throw new Error(`crm: ${object} cannot group by ${key}`);
    return spec.column;
}

/** The records of one group. */
export function groupWhere(object: CrmObject, group: GroupScope): Record<string, unknown> {
    return { [groupColumn(object, group.key)]: group.value };
}

/** Columns that may hold null, so a sort puts their empty rows last. */
const NULLABLE = new Set(["employees", "annualRevenue", "amount", "closeDate"]);

/** A number or a day somebody added holds nothing until it is set. */
function nullableSlot(column: string): boolean {
    const family = slotOf(column);
    return family === "cNum" || family === "cDate";
}

function order(column: string, direction: "asc" | "desc"): Record<string, unknown> {
    return {
        [column]:
            NULLABLE.has(column) || nullableSlot(column)
                ? { sort: direction, nulls: "last" }
                : direction
    };
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
        // A list of linked records has no one name to order by.
        case "refs":
            return [];
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

/**
 * Whether a cursor can follow this order: every entry a plain column read in
 * one direction. A column that may be null (sorted with its empty rows last)
 * or a linked record's name has no single value to resume after, so a list
 * ordered by one is paged by offset instead.
 */
export function keysetOrder(orderBy: readonly Record<string, unknown>[]): boolean {
    return orderBy.every((entry) => {
        const values = Object.values(entry);
        return values.length === 1 && (values[0] === "asc" || values[0] === "desc");
    });
}

type KeyValue = string | number | boolean | { readonly at: string };

/** The column and direction of each entry of an order a cursor can follow. */
function keyColumns(orderBy: readonly Record<string, unknown>[]): [string, "asc" | "desc"][] {
    return orderBy.map((entry) => Object.entries(entry)[0] as [string, "asc" | "desc"]);
}

/**
 * Where the next page starts: the values the last row of a page was read with,
 * in the order's columns. It is taken from the row as the database ordered it,
 * so an edit made to that row afterwards does not move it, and it names no row,
 * so nothing outside the list's own `where` is ever looked up through it.
 */
export function pageCursor(
    orderBy: readonly Record<string, unknown>[],
    row: Readonly<Record<string, unknown>>
): string | null {
    if (!keysetOrder(orderBy)) return null;
    const values: KeyValue[] = [];
    for (const [column] of keyColumns(orderBy)) {
        const value = row[column];
        if (value instanceof Date) values.push({ at: value.toISOString() });
        else if (typeof value === "string" || typeof value === "boolean") values.push(value);
        else if (typeof value === "number" && Number.isFinite(value)) values.push(value);
        else return null;
    }
    return Buffer.from(JSON.stringify(values)).toString("base64url");
}

function readCursor(cursor: string, length: number): unknown[] | null {
    let values: unknown;
    try {
        values = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if (!Array.isArray(values) || values.length !== length) return null;
    const read: unknown[] = [];
    for (const value of values) {
        if (typeof value === "string" || typeof value === "boolean") read.push(value);
        else if (typeof value === "number" && Number.isFinite(value)) read.push(value);
        else if (
            value !== null &&
            typeof value === "object" &&
            typeof (value as { at?: unknown }).at === "string" &&
            !Number.isNaN(Date.parse((value as { at: string }).at))
        )
            read.push(new Date((value as { at: string }).at));
        else return null;
    }
    return read;
}

/** The rows of one column that come after `value` in `direction`, or null when
 *  none can (a yes/no column already at its last value). */
function beyond(
    column: string,
    direction: "asc" | "desc",
    value: unknown
): Record<string, unknown> | null {
    if (typeof value === "boolean") {
        const next = direction === "asc" ? true : false;
        return value === next ? null : { [column]: next };
    }
    return { [column]: { [direction === "asc" ? "gt" : "lt"]: value } };
}

/**
 * The rows after a page's cursor (`pageCursor`), as a `where` to add to the
 * list's own: for an order (a, b, id), `a` past the cursor's, or `a` equal and
 * `b` past it, and so on. The first column is also bounded on its own so the
 * database starts the read inside its index. Null when the cursor does not fit
 * this order - the caller pages by offset instead.
 */
export function afterCursor(
    orderBy: readonly Record<string, unknown>[],
    cursor: string
): Record<string, unknown> | null {
    if (!keysetOrder(orderBy)) return null;
    const columns = keyColumns(orderBy);
    const values = readCursor(cursor, columns.length);
    if (!values) return null;
    const branches: Record<string, unknown>[] = [];
    columns.forEach(([column, direction], at) => {
        const past = beyond(column, direction, values[at]);
        if (!past) return;
        const tied = columns
            .slice(0, at)
            .map(([earlier], before) => ({ [earlier]: values[before] }));
        branches.push(tied.length > 0 ? { AND: [...tied, past] } : past);
    });
    if (branches.length === 0) return { id: { in: [] } };
    const [first, direction] = columns[0]!;
    const start = values[0];
    const bound =
        typeof start === "boolean"
            ? []
            : [{ [first]: { [direction === "asc" ? "gte" : "lte"]: start } }];
    return { AND: [...bound, { OR: branches }] };
}
