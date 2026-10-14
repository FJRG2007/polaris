/**
 * Dashboards: named pages of charts over a shelf's records.
 *
 * A widget is one question asked of one kind of record: how many (or the sum,
 * average, smallest or largest of a number), over everything or over the rows
 * a saved view lists, as one figure or split by a field - its choices, its
 * owner, the record it points at, or its date by day, week, month, quarter or
 * year. Shared by both sides: the server reads a widget with this schema, the
 * dialog builds one against it.
 */

import { z } from "zod";
import { CRM_OBJECTS } from "@polaris/core";
import { fieldsOf, type CrmObject, type FieldDef } from "./objects";

export const DASHBOARD_NAME_MAX = 80;
export const WIDGET_TITLE_MAX = 80;
/** A page of charts, not a report generator. */
export const MAX_WIDGETS = 24;
export const MAX_DASHBOARDS = 50;
/** The most bars or slices drawn; the rest are added up as one. */
export const MAX_GROUPS = 10;
/** The most points along a date: past this the range is too fine to read. */
export const MAX_BUCKETS = 400;

export const CHART_KINDS = ["number", "bar", "line", "donut"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const MEASURES = ["count", "sum", "avg", "min", "max"] as const;
export type Measure = (typeof MEASURES)[number];

export const GRANULARITIES = ["day", "week", "month", "quarter", "year"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

const key = z.string().min(1).max(64);

export const widgetSchema = z
    .object({
        id: z.string().uuid(),
        title: z.string().trim().max(WIDGET_TITLE_MAX),
        object: z.enum(CRM_OBJECTS),
        chart: z.enum(CHART_KINDS),
        measure: z.enum(MEASURES),
        /** The number a sum, an average or an extreme is taken of. */
        field: key.nullable(),
        /** For an amount: the currency counted; amounts in others are left out. */
        currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .nullable(),
        /** What a chart is split by; null for a single figure. */
        groupBy: key.nullable(),
        granularity: z.enum(GRANULARITIES).nullable(),
        /** The saved view whose rows are counted; null for every record. */
        viewId: z.string().uuid().nullable(),
        /** 1 or 2 columns wide in the grid. */
        wide: z.boolean()
    })
    .superRefine((widget, context) => {
        const problem = widgetProblem(widget);
        if (problem) context.addIssue({ code: "custom", message: problem });
    });

export type Widget = z.infer<typeof widgetSchema>;

export const widgetsSchema = z.array(widgetSchema).max(MAX_WIDGETS);

/** Whether a field can be measured: a number, an amount or a rating. */
export function measurable(field: FieldDef): boolean {
    return (
        field.kind === "number" ||
        field.kind === "money" ||
        field.kind === "currency" ||
        field.kind === "rating"
    );
}

/** Whether a field splits records into a few named groups. */
export function categorical(field: FieldDef): boolean {
    return (
        (field.kind === "select" && (field.options?.length ?? 0) > 0) ||
        field.kind === "boolean" ||
        field.kind === "member" ||
        field.kind === "relation"
    );
}

export function dated(field: FieldDef): boolean {
    return field.kind === "date" || field.kind === "dateTime";
}

export function measureFields(object: CrmObject, custom: readonly FieldDef[] = []): FieldDef[] {
    return fieldsOf(object, custom).filter(measurable);
}

export function splitFields(
    object: CrmObject,
    chart: ChartKind,
    custom: readonly FieldDef[] = []
): FieldDef[] {
    if (chart === "number") return [];
    // A line is drawn along time; bars and slices compare groups or periods.
    return fieldsOf(object, custom).filter((field) =>
        chart === "line"
            ? dated(field)
            : chart === "donut"
              ? categorical(field)
              : categorical(field) || dated(field)
    );
}

/**
 * Why a widget's shape does not hold together, as a short machine reason, or
 * null. The fields themselves are checked against the kind of record where it
 * is read, since custom fields are per shelf.
 */
export function widgetProblem(widget: {
    chart: ChartKind;
    measure: Measure;
    field: string | null;
    groupBy: string | null;
    granularity: Granularity | null;
}): string | null {
    if (widget.measure === "count" ? widget.field !== null : widget.field === null)
        return "measure";
    if (widget.chart === "number" ? widget.groupBy !== null : widget.groupBy === null)
        return "groupBy";
    return null;
}

/** A widget checked against the fields of its kind of record now: null when it
 *  names a field that is not there or cannot be used that way. */
export function readWidget(widget: Widget, custom: readonly FieldDef[]): Widget | null {
    const all = fieldsOf(widget.object, custom);
    if (widget.field !== null) {
        const field = all.find((one) => one.key === widget.field);
        if (!field || !measurable(field)) return null;
        // An amount is counted in one currency: adding euros to dollars is no figure.
        if ((field.kind === "currency") !== (widget.currency !== null)) return null;
    }
    if (widget.groupBy !== null) {
        const field = splitFields(widget.object, widget.chart, custom).find(
            (one) => one.key === widget.groupBy
        );
        if (!field) return null;
        if (dated(field) !== (widget.granularity !== null)) return null;
    }
    return widget;
}

/** What one widget answers, ready to draw. */
export type WidgetData =
    | { readonly kind: "number"; readonly value: number | null }
    | {
          readonly kind: "groups";
          /** Keyed by the stored value: a choice, "true"/"false", an id, or a
           *  period's first day ("2026-10-01"). "" is "no value". */
          readonly points: readonly {
              readonly key: string;
              readonly label: string | null;
              readonly value: number | null;
          }[];
          /** Everything past the groups drawn, added up; null when nothing is. */
          readonly other: number | null;
          /** Some values were left uncounted: far more than a chart can draw. */
          readonly capped: boolean;
      };

/** The first day of the period a day falls in, as `YYYY-MM-DD`, in UTC. */
export function bucketOf(date: Date, granularity: Granularity): string {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    let start: Date;
    switch (granularity) {
        case "day":
            start = new Date(Date.UTC(year, month, date.getUTCDate()));
            break;
        case "week": {
            // Weeks start on Monday.
            const day = (date.getUTCDay() + 6) % 7;
            start = new Date(Date.UTC(year, month, date.getUTCDate() - day));
            break;
        }
        case "month":
            start = new Date(Date.UTC(year, month, 1));
            break;
        case "quarter":
            start = new Date(Date.UTC(year, month - (month % 3), 1));
            break;
        case "year":
            start = new Date(Date.UTC(year, 0, 1));
            break;
    }
    return start.toISOString().slice(0, 10);
}

/** The period after this one. */
export function nextBucket(bucket: string, granularity: Granularity): string {
    const date = new Date(`${bucket}T00:00:00Z`);
    switch (granularity) {
        case "day":
            date.setUTCDate(date.getUTCDate() + 1);
            break;
        case "week":
            date.setUTCDate(date.getUTCDate() + 7);
            break;
        case "month":
            date.setUTCMonth(date.getUTCMonth() + 1);
            break;
        case "quarter":
            date.setUTCMonth(date.getUTCMonth() + 3);
            break;
        case "year":
            date.setUTCFullYear(date.getUTCFullYear() + 1);
            break;
    }
    return date.toISOString().slice(0, 10);
}

/** Every period from the first to the last, so a line has no hidden gaps;
 *  null when that is more than a chart can show. */
export function bucketRange(
    first: string,
    last: string,
    granularity: Granularity
): string[] | null {
    const all: string[] = [];
    for (let at = first; at <= last; at = nextBucket(at, granularity)) {
        all.push(at);
        if (all.length > MAX_BUCKETS) return null;
    }
    return all;
}

/** A partial running total: enough to merge sums, averages and extremes. */
export interface Tally {
    count: number;
    /** Rows where the measured number is not empty. */
    counted: number;
    sum: number;
    min: number | null;
    max: number | null;
}

export const EMPTY_TALLY: Tally = { count: 0, counted: 0, sum: 0, min: null, max: null };

export function addTally(into: Tally, one: Tally): Tally {
    return {
        count: into.count + one.count,
        counted: into.counted + one.counted,
        sum: into.sum + one.sum,
        min:
            into.min === null ? one.min : one.min === null ? into.min : Math.min(into.min, one.min),
        max: into.max === null ? one.max : one.max === null ? into.max : Math.max(into.max, one.max)
    };
}

/** The figure a tally gives for a measure; null when there is nothing to measure. */
export function measureOf(tally: Tally, measure: Measure): number | null {
    const round = (value: number) => Math.round(value * 100) / 100;
    switch (measure) {
        case "count":
            return tally.count;
        case "sum":
            return tally.counted === 0 ? null : round(tally.sum);
        case "avg":
            return tally.counted === 0 ? null : round(tally.sum / tally.counted);
        case "min":
            return tally.min;
        case "max":
            return tally.max;
    }
}
