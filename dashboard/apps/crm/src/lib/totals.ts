/**
 * The totals under a table's columns, counted by the database over the same
 * rows the table lists - the whole match, not the page on screen.
 *
 * Server-only.
 */

import { listWhere } from "./query";
import { requireCan, type CrmActor } from "./access";
import { aggregatesFor, type Aggregate } from "../model/views";
import { columnOf, dayText, table, type ColumnSpec } from "./columns";
import { fieldOf, type CrmObject, type Money } from "../model/objects";

/** One total, ready to draw. */
export interface Total {
    readonly key: string;
    readonly aggregate: Aggregate;
    /** A count, a percentage (0-100) or a plain number; null when nothing to count. */
    readonly value: number | null;
    /** Sums and averages of an amount, one per currency in the rows. */
    readonly money?: readonly Money[];
    /** The earliest or latest day or moment. */
    readonly date?: string | null;
    /** A distinct count stopped counting here; the real one is higher. */
    readonly capped?: boolean;
}

/** Where a distinct count stops: past this the exact figure is not worth a
 *  scan of every value. */
export const UNIQUE_CAP = 10_000;

/** The rows where a field holds nothing, as a `where`; null for a kind of
 *  field that is never empty. */
function emptyWhere(
    object: CrmObject,
    key: string,
    spec: ColumnSpec
): Record<string, unknown> | null {
    const kind = fieldOf(object, key)?.kind;
    if (kind === "dateTime" || kind === "boolean") return null;
    switch (spec.type) {
        case "scalar":
            return NULLABLE_SCALARS.has(spec.column)
                ? { [spec.column]: null }
                : { [spec.column]: "" };
        case "day":
            return { [spec.column]: null };
        case "name":
            return { [spec.first]: "", [spec.last]: "" };
        case "money":
            return { [spec.amount]: null };
        case "ref":
            return { [spec.column]: null };
    }
}

const NULLABLE_SCALARS = new Set(["employees"]);

/** The columns a distinct count groups by. */
function groupColumns(spec: ColumnSpec): string[] {
    switch (spec.type) {
        case "scalar":
        case "day":
        case "ref":
            return [spec.column];
        case "name":
            return [spec.first, spec.last];
        case "money":
            return [spec.amount, spec.currency];
    }
}

/** The one column a sum, an average or an extreme is taken over. */
function measured(spec: ColumnSpec): string {
    if (spec.type === "money") return spec.amount;
    if (spec.type === "scalar" || spec.type === "day") return spec.column;
    throw new Error("crm: nothing to measure on this field");
}

const AGGREGATE_KEY: Partial<Record<Aggregate, "_sum" | "_avg" | "_min" | "_max">> = {
    sum: "_sum",
    avg: "_avg",
    min: "_min",
    max: "_max",
    earliest: "_min",
    latest: "_max"
};

async function one(
    object: CrmObject,
    where: Record<string, unknown>,
    all: () => Promise<number>,
    key: string,
    aggregate: Aggregate
): Promise<Total> {
    const spec = columnOf(object, key);
    const delegate = table(object);
    const empty = emptyWhere(object, key, spec);
    const blank = async () =>
        empty === null ? 0 : ((await delegate.count({ where: { AND: [where, empty] } })) as number);
    switch (aggregate) {
        case "countAll":
            return { key, aggregate, value: await all() };
        case "countEmpty":
            return { key, aggregate, value: await blank() };
        case "countNotEmpty":
            return { key, aggregate, value: (await all()) - (await blank()) };
        case "percentEmpty":
        case "percentNotEmpty": {
            const [count, empty] = [await all(), await blank()];
            if (count === 0) return { key, aggregate, value: null };
            const share = (aggregate === "percentEmpty" ? empty : count - empty) / count;
            return { key, aggregate, value: Math.round(share * 1000) / 10 };
        }
        case "countUnique": {
            const groups = (await delegate.groupBy({
                by: groupColumns(spec),
                where: empty === null ? where : { AND: [where, { NOT: empty }] },
                orderBy: groupColumns(spec).map((column) => ({ [column]: "asc" })),
                take: UNIQUE_CAP + 1
            })) as unknown[];
            return {
                key,
                aggregate,
                value: Math.min(groups.length, UNIQUE_CAP),
                capped: groups.length > UNIQUE_CAP
            };
        }
        default: {
            const operation = AGGREGATE_KEY[aggregate]!;
            const column = measured(spec);
            if (spec.type === "money") {
                const groups = (await delegate.groupBy({
                    by: [spec.currency],
                    where: { AND: [where, { NOT: { [column]: null } }] },
                    [operation]: { [column]: true },
                    orderBy: { [spec.currency]: "asc" }
                })) as Record<string, Record<string, unknown> | string>[];
                const money = groups.map((group) => {
                    const raw = (group[operation] as Record<string, unknown>)[column];
                    const amount = raw === null || raw === undefined ? null : Number(raw);
                    return {
                        currency: String(group[spec.currency]),
                        amount: amount === null ? null : Math.round(amount * 100) / 100
                    };
                });
                return { key, aggregate, value: null, money };
            }
            const result = (await delegate.aggregate({
                where,
                [operation]: { [column]: true }
            })) as Record<string, Record<string, unknown>>;
            const raw = result[operation]?.[column];
            if (aggregate === "earliest" || aggregate === "latest") {
                const date = raw instanceof Date ? raw : null;
                return {
                    key,
                    aggregate,
                    value: null,
                    date: date ? (spec.type === "day" ? dayText(date) : date.toISOString()) : null
                };
            }
            const value = raw === null || raw === undefined ? null : Number(raw);
            return {
                key,
                aggregate,
                value: value === null ? null : Math.round(value * 100) / 100
            };
        }
    }
}

/**
 * The totals a view asks for, over what the table lists. Asked one after the
 * other rather than all at once: a wide view with a total under every column
 * must not take a whole connection pool for one screen.
 */
export async function computeTotals(
    actor: CrmActor,
    object: CrmObject,
    asked: readonly { readonly key: string; readonly aggregate: Aggregate }[],
    options: { readonly search?: string; readonly deleted?: boolean }
): Promise<Total[]> {
    await requireCan(actor, object, "read");
    const where = listWhere(object, actor.shelf, options);
    let counted: Promise<number> | null = null;
    const all = () => (counted ??= table(object).count({ where }) as Promise<number>);
    const totals: Total[] = [];
    for (const { key, aggregate } of asked.slice(0, 64)) {
        const field = fieldOf(object, key);
        if (!field || !aggregatesFor(field.kind).includes(aggregate)) continue;
        totals.push(await one(object, where, all, key, aggregate));
    }
    return totals;
}
