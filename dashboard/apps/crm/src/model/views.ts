/**
 * A view: which columns a table shows, how wide, in what order, what total sits
 * under each, how the rows are sorted, filtered and grouped, and which field a
 * board draws its columns from.
 *
 * Stored as JSON on `CrmView.config`, so what is read back may be older than
 * this file - written before a field existed, or naming one that has gone.
 * `readConfig` turns whatever is stored into a whole config for today's fields
 * rather than trusting its shape.
 *
 * Client-safe.
 */

import { z } from "zod";
import { EMPTY_FILTER, filterSchema, readFilter } from "./filters";
import { FIELDS, fieldOf, type CrmObject, type FieldDef, type FieldKind } from "./objects";

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

/** Whether records can be grouped, or drawn as a board, by a field: one with
 *  a fixed set of choices. */
export function groupable(field: FieldDef): boolean {
    return field.kind === "select" && (field.options?.length ?? 0) > 0;
}

/** The fields a kind of record can be grouped or drawn as a board by. */
export function groupFields(object: CrmObject): readonly FieldDef[] {
    return FIELDS[object].filter(groupable);
}

const groupKey = z.string().min(1).max(64).nullable();

export const viewConfigSchema = z.object({
    columns: z.array(columnSchema).max(64),
    sorts: z.array(sortSchema).max(MAX_SORTS),
    filter: filterSchema.default(EMPTY_FILTER),
    /** The field a table's rows are grouped by, or null for one run of rows. */
    groupBy: groupKey.default(null),
    /** The field a board draws its columns from; null is the first one there is. */
    boardBy: groupKey.default(null)
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
        sorts: [],
        filter: EMPTY_FILTER,
        groupBy: null,
        boardBy: null
    };
}

/**
 * A stored config made whole for today's fields.
 *
 * Columns keep their stored order, width and total; a field the stored config
 * does not mention is added at the end, hidden, so a field shipped later never
 * appears in somebody's table uninvited; a column for a field that is gone, a
 * total that field cannot have and a sort on something unsortable are dropped.
 * The name column is never hidden. A filter is read by `readFilter`; grouping
 * by a field that cannot group is no grouping. Anything unreadable is the
 * default.
 */
export function readConfig(object: CrmObject, raw: unknown): ViewConfig {
    const base = defaultConfig(object);
    const parsed = z
        .object({
            columns: z.array(z.unknown()).optional(),
            sorts: z.array(z.unknown()).optional(),
            filter: z.unknown().optional(),
            groupBy: z.unknown().optional(),
            boardBy: z.unknown().optional()
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
    return {
        columns,
        sorts,
        filter: readFilter(object, parsed.data.filter),
        groupBy: readGroupKey(object, parsed.data.groupBy),
        boardBy: readGroupKey(object, parsed.data.boardBy)
    };
}

function readGroupKey(object: CrmObject, raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const field = fieldOf(object, raw);
    return field && groupable(field) ? field.key : null;
}

/** The field a board is drawn by: the view's, or the first that can be one. */
export function boardField(object: CrmObject, config: ViewConfig): FieldDef | null {
    const chosen = config.boardBy ? fieldOf(object, config.boardBy) : undefined;
    return chosen && groupable(chosen) ? chosen : (groupFields(object)[0] ?? null);
}

/** How a view draws its records. */
export const VIEW_KINDS = ["table", "kanban"] as const;

export type ViewKind = (typeof VIEW_KINDS)[number];

/** The longest name a saved view may have. */
export const VIEW_NAME_MAX = 60;
/** The most views one kind of record keeps on a shelf. */
export const MAX_VIEWS = 50;

/** A view's name as it is kept: trimmed, its runs of spaces made one. */
export function normalizeViewName(name: string): string {
    return name.trim().replace(/\s+/g, " ");
}

/** One saved view as the screens receive it. */
export interface ViewSummary {
    readonly id: string;
    /** Empty for the view every kind of record starts with. */
    readonly name: string;
    readonly kind: ViewKind;
    readonly config: ViewConfig;
}
