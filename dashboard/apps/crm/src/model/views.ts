/**
 * A view: which columns a table shows, how wide, in what order, what total sits
 * under each, and how the rows are sorted.
 *
 * Stored as JSON on `CrmView.config`, so what is read back may be older than
 * this file - written before a field existed, or naming one that has gone.
 * `readConfig` turns whatever is stored into a whole config for today's fields
 * rather than trusting its shape.
 *
 * Client-safe.
 */

import { z } from "zod";
import { FIELDS, fieldOf, type CrmObject, type FieldKind } from "./objects";

/** The totals a column can show under it. */
export const AGGREGATES = [
    "countAll",
    "countEmpty",
    "countNotEmpty",
    "countUnique",
    "percentEmpty",
    "percentNotEmpty",
    "sum",
    "avg",
    "min",
    "max",
    "earliest",
    "latest"
] as const;

export type Aggregate = (typeof AGGREGATES)[number];

const COUNTS: readonly Aggregate[] = [
    "countAll",
    "countEmpty",
    "countNotEmpty",
    "countUnique",
    "percentEmpty",
    "percentNotEmpty"
];

/** The totals that mean something for a kind of field. */
export function aggregatesFor(kind: FieldKind): readonly Aggregate[] {
    if (kind === "number" || kind === "currency") return [...COUNTS, "sum", "avg", "min", "max"];
    if (kind === "date") return [...COUNTS, "earliest", "latest"];
    // Never empty: a moment Polaris wrote, a box that is ticked or not.
    if (kind === "dateTime") return ["countAll", "countUnique", "earliest", "latest"];
    if (kind === "boolean") return ["countAll"];
    if (kind === "fullName") return COUNTS.filter((total) => total !== "countUnique");
    return COUNTS;
}

/** Whether rows can be ordered by a kind of field. */
export function sortable(kind: FieldKind): boolean {
    return kind !== "member";
}

export const COLUMN_WIDTH = { min: 80, max: 640 } as const;

const columnSchema = z.object({
    key: z.string().min(1).max(64),
    width: z.number().int().min(COLUMN_WIDTH.min).max(COLUMN_WIDTH.max),
    hidden: z.boolean(),
    aggregate: z.enum(AGGREGATES).nullable()
});

export type ViewColumn = z.infer<typeof columnSchema>;

const sortSchema = z.object({
    key: z.string().min(1).max(64),
    direction: z.enum(["asc", "desc"])
});

export type ViewSort = z.infer<typeof sortSchema>;

/** At most this many sorts: past three the later ones decide nothing anyone sees. */
export const MAX_SORTS = 3;

export const viewConfigSchema = z.object({
    columns: z.array(columnSchema).max(64),
    sorts: z.array(sortSchema).max(MAX_SORTS)
});

export type ViewConfig = z.infer<typeof viewConfigSchema>;

/** The table a kind of record starts with: every field in its own order, the
 *  rarer ones hidden, a count under the name. */
export function defaultConfig(object: CrmObject): ViewConfig {
    return {
        columns: FIELDS[object].map((field) => ({
            key: field.key,
            width: field.width,
            hidden: Boolean(field.hiddenByDefault),
            aggregate: field.primary ? "countAll" : null
        })),
        sorts: []
    };
}

/**
 * A stored config made whole for today's fields.
 *
 * Columns keep their stored order, width and total; a field the stored config
 * does not mention is added at the end, hidden, so a field shipped later never
 * appears in somebody's table uninvited; a column for a field that is gone, a
 * total that field cannot have and a sort on something unsortable are dropped.
 * The name column is never hidden. Anything unreadable is the default.
 */
export function readConfig(object: CrmObject, raw: unknown): ViewConfig {
    const base = defaultConfig(object);
    const parsed = z
        .object({
            columns: z.array(z.unknown()).optional(),
            sorts: z.array(z.unknown()).optional()
        })
        .safeParse(raw);
    if (!parsed.success) return base;

    const columns: ViewColumn[] = [];
    const seen = new Set<string>();
    for (const entry of parsed.data.columns ?? []) {
        const column = columnSchema.safeParse(entry);
        if (!column.success || seen.has(column.data.key)) continue;
        const field = fieldOf(object, column.data.key);
        if (!field) continue;
        seen.add(field.key);
        columns.push({
            ...column.data,
            hidden: field.primary ? false : column.data.hidden,
            aggregate:
                column.data.aggregate && aggregatesFor(field.kind).includes(column.data.aggregate)
                    ? column.data.aggregate
                    : null
        });
    }
    if (columns.length === 0) return base;
    for (const column of base.columns) {
        if (!seen.has(column.key)) columns.push({ ...column, hidden: true, aggregate: null });
    }
    // The name leads, wherever a stored config put it.
    const primary = columns.findIndex((column) => fieldOf(object, column.key)?.primary);
    if (primary > 0) columns.unshift(...columns.splice(primary, 1));

    const sorts: ViewSort[] = [];
    for (const entry of parsed.data.sorts ?? []) {
        const sort = sortSchema.safeParse(entry);
        const field = sort.success ? fieldOf(object, sort.data.key) : undefined;
        if (!sort.success || !field || !sortable(field.kind)) continue;
        if (sorts.some((existing) => existing.key === sort.data.key)) continue;
        if (sorts.length < MAX_SORTS) sorts.push(sort.data);
    }
    return { columns, sorts };
}

/** One saved view as the screens receive it. */
export interface ViewSummary {
    readonly id: string;
    /** Empty for the view every kind of record starts with. */
    readonly name: string;
    readonly config: ViewConfig;
}
