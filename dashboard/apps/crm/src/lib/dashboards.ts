/**
 * Dashboards: kept per shelf like views, so everybody working in an
 * organization's CRM sees the same ones, and answered per widget.
 *
 * Every figure is counted by the database over the same rows a list would
 * show - the shelf, never the trash, and a saved view's filter when the
 * widget names one - and grouped there too: a chart split by a field asks for
 * one row per value, never for the records. A date is grouped by its distinct
 * values and those are added into periods here, since a period is not a
 * column; a range with more distinct values than `DATE_CAP` is cut short and
 * says so.
 *
 * Changing a dashboard needs the right to change some kind of record on the
 * shelf; a widget may only count records its author may see. Reading a widget
 * checks again, as the reader: one about a kind the reader's role cannot see
 * is refused, and the screen says so in its place.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { listWhere } from "./query";
import { prisma } from "@polaris/db";
import { CrmRefusal } from "./errors";
import { loadFields } from "./fields";
import { shelfPeople } from "./records";
import { readConfig } from "../model/views";
import * as model from "../model/dashboards";
import { recordSelect, table, toRecord, columnOf } from "./columns";
import { requireCan, shelfData, shelfWhere, type CrmActor } from "./access";
import { CRM_OBJECTS, fieldOf, recordName, type CrmObject } from "../model/objects";

/** Distinct values of a field a split may group: past this it is not a chart. */
export const CATEGORY_CAP = 1000;
/** Distinct days or moments a date split adds into periods. */
export const DATE_CAP = 20_000;

export interface DashboardSummary {
    readonly id: string;
    readonly name: string;
    readonly widgets: model.Widget[];
}

const SELECT = { id: true, name: true, widgets: true } as const;

function readWidgets(raw: string): model.Widget[] {
    try {
        const parsed = model.widgetsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

function summary(row: { id: string; name: string; widgets: string }): DashboardSummary {
    return { id: row.id, name: row.name, widgets: readWidgets(row.widgets) };
}

async function refuse(key: string, values?: Record<string, string | number>): Promise<never> {
    const t = await crmT();
    throw new CrmRefusal(t(`dashboards.errors.${key}` as Parameters<typeof t>[0], values));
}

/** Whether the reader may change dashboards on this shelf. */
export function canManage(actor: CrmActor): boolean {
    return CRM_OBJECTS.some((object) => actor.can[object].edit);
}

async function requireManage(actor: CrmActor): Promise<void> {
    if (!canManage(actor)) await refuse("forbidden");
}

export async function listDashboards(actor: CrmActor): Promise<DashboardSummary[]> {
    const rows = await prisma.crmDashboard.findMany({
        where: { shelf: actor.shelf.key },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: model.MAX_DASHBOARDS,
        select: SELECT
    });
    return rows.map(summary);
}

async function cleanName(name: string): Promise<string> {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean || clean.length > model.DASHBOARD_NAME_MAX) {
        await refuse("name", { length: model.DASHBOARD_NAME_MAX });
    }
    return clean;
}

function nameTaken(caught: unknown): boolean {
    return (caught as { code?: unknown } | null)?.code === "P2002";
}

export async function createDashboard(actor: CrmActor, name: string): Promise<DashboardSummary> {
    await requireManage(actor);
    const clean = await cleanName(name);
    const [count, last] = await Promise.all([
        prisma.crmDashboard.count({ where: { shelf: actor.shelf.key } }),
        prisma.crmDashboard.findFirst({
            where: { shelf: actor.shelf.key },
            orderBy: { position: "desc" },
            select: { position: true }
        })
    ]);
    if (count >= model.MAX_DASHBOARDS) await refuse("limit", { max: model.MAX_DASHBOARDS });
    try {
        return summary(
            await prisma.crmDashboard.create({
                data: {
                    ...shelfData(actor.shelf),
                    shelf: actor.shelf.key,
                    name: clean,
                    widgets: "[]",
                    position: (last?.position ?? 0) + 1,
                    createdById: actor.user.id
                },
                select: SELECT
            })
        );
    } catch (caught) {
        if (nameTaken(caught)) await refuse("nameTaken");
        throw caught;
    }
}

async function owned(actor: CrmActor, id: string): Promise<void> {
    const found = await prisma.crmDashboard.findFirst({
        where: { id, shelf: actor.shelf.key },
        select: { id: true }
    });
    if (!found) await refuse("missing");
}

export async function renameDashboard(
    actor: CrmActor,
    id: string,
    name: string
): Promise<DashboardSummary> {
    await requireManage(actor);
    const clean = await cleanName(name);
    await owned(actor, id);
    try {
        return summary(
            await prisma.crmDashboard.update({
                where: { id },
                data: { name: clean },
                select: SELECT
            })
        );
    } catch (caught) {
        if (nameTaken(caught)) await refuse("nameTaken");
        throw caught;
    }
}

export async function deleteDashboard(actor: CrmActor, id: string): Promise<void> {
    await requireManage(actor);
    await owned(actor, id);
    await prisma.crmDashboard.deleteMany({ where: { id, shelf: actor.shelf.key } });
}

/** Keep a dashboard's widgets, each checked against its kind of record now. */
export async function saveWidgets(
    actor: CrmActor,
    id: string,
    widgets: readonly model.Widget[]
): Promise<DashboardSummary> {
    await requireManage(actor);
    await owned(actor, id);
    const custom = new Map<CrmObject, Awaited<ReturnType<typeof loadFields>>>();
    for (const widget of widgets) {
        await requireCan(actor, widget.object, "read");
        if (!custom.has(widget.object)) {
            custom.set(widget.object, await loadFields(actor.shelf, widget.object));
        }
        if (!model.readWidget(widget, custom.get(widget.object)!)) await refuse("widget");
    }
    return summary(
        await prisma.crmDashboard.update({
            where: { id },
            data: { widgets: JSON.stringify(widgets) },
            select: SELECT
        })
    );
}

/** A number the database answered, as a number. */
function numeric(raw: unknown): number | null {
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

type GroupRow = Record<string, unknown> & {
    _count: Record<string, number>;
    _sum?: Record<string, unknown>;
    _min?: Record<string, unknown>;
    _max?: Record<string, unknown>;
};

function tallyOf(row: GroupRow, column: string | null): model.Tally {
    if (!column) return { ...model.EMPTY_TALLY, count: row._count._all ?? 0 };
    return {
        count: row._count._all ?? 0,
        counted: row._count[column] ?? 0,
        sum: numeric(row._sum?.[column]) ?? 0,
        min: numeric(row._min?.[column]),
        max: numeric(row._max?.[column])
    };
}

/** What one widget answers, counted as the reader. */
export async function widgetData(actor: CrmActor, widget: model.Widget): Promise<model.WidgetData> {
    const { object } = widget;
    await requireCan(actor, object, "read");
    const custom = await loadFields(actor.shelf, object);
    const checked = model.readWidget(widget, custom);
    if (!checked) return refuse("widget");

    let filter = undefined;
    if (checked.viewId) {
        const view = await prisma.crmView.findFirst({
            where: { id: checked.viewId, shelf: actor.shelf.key, object },
            select: { config: true }
        });
        if (!view) return refuse("view");
        let stored: unknown = null;
        try {
            stored = JSON.parse(view.config);
        } catch {
            // An unreadable view is the default one: every record.
        }
        filter = readConfig(object, stored, custom).filter;
    }
    const base = listWhere(object, actor.shelf, { filter, custom });

    // The column measured, and, for an amount, only the rows in its currency.
    let column: string | null = null;
    let where: Record<string, unknown> = base;
    if (checked.field) {
        const spec = columnOf(object, checked.field);
        if (spec.type === "money") {
            column = spec.amount;
            where = { AND: [base, { [spec.currency]: checked.currency }] };
        } else if (spec.type === "scalar") {
            column = spec.column;
        } else {
            return refuse("widget");
        }
    }
    const measures = column
        ? {
              _count: { _all: true, [column]: true },
              _sum: { [column]: true },
              _min: { [column]: true },
              _max: { [column]: true }
          }
        : { _count: { _all: true } };

    if (!checked.groupBy) {
        const row = (await table(object).aggregate({ where, ...measures })) as GroupRow;
        return { kind: "number", value: model.measureOf(tallyOf(row, column), checked.measure) };
    }

    const field = fieldOf(object, checked.groupBy, custom)!;
    const spec = columnOf(object, checked.groupBy);
    if (spec.type !== "scalar" && spec.type !== "day" && spec.type !== "ref") {
        return refuse("widget");
    }
    const by = spec.column;

    if (checked.granularity) {
        const granularity = checked.granularity;
        const rows = (await table(object).groupBy({
            by: [by],
            where: { AND: [where, { NOT: { [by]: null } }] },
            ...measures,
            orderBy: { [by]: "asc" },
            take: DATE_CAP + 1
        })) as GroupRow[];
        const capped = rows.length > DATE_CAP;
        const periods = new Map<string, model.Tally>();
        for (const row of rows.slice(0, DATE_CAP)) {
            const at = row[by];
            if (!(at instanceof Date)) continue;
            const bucket = model.bucketOf(at, granularity);
            periods.set(
                bucket,
                model.addTally(periods.get(bucket) ?? model.EMPTY_TALLY, tallyOf(row, column))
            );
        }
        const present = [...periods.keys()].sort();
        const range =
            present.length > 0
                ? model.bucketRange(present[0]!, present[present.length - 1]!, granularity)
                : [];
        const keys = range ?? present;
        return {
            kind: "groups",
            points: keys.map((bucket) => ({
                key: bucket,
                label: null,
                // A period with nothing in it counts nothing; it has no average.
                value: model.measureOf(periods.get(bucket) ?? model.EMPTY_TALLY, checked.measure)
            })),
            other: null,
            capped: capped || range === null
        };
    }

    const rows = (await table(object).groupBy({
        by: [by],
        where,
        ...measures,
        orderBy: { _count: { [by]: "desc" } },
        take: CATEGORY_CAP + 1
    })) as GroupRow[];
    const capped = rows.length > CATEGORY_CAP;
    const tallies = new Map<string, model.Tally>();
    for (const row of rows.slice(0, CATEGORY_CAP)) {
        const raw = row[by];
        const key = raw === null || raw === undefined ? "" : String(raw);
        tallies.set(
            key,
            model.addTally(tallies.get(key) ?? model.EMPTY_TALLY, tallyOf(row, column))
        );
    }

    // A choice keeps its own order - a pipeline reads left to right - and
    // shows the stages nothing is in; anything else is ranked by its figure.
    let order: string[];
    if (field.kind === "select") {
        const options = field.options ?? [];
        order = [...options, ...[...tallies.keys()].filter((key) => !options.includes(key))];
    } else if (field.kind === "boolean") {
        order = ["true", "false"];
    } else {
        order = [...tallies.keys()].sort(
            (a, b) =>
                (model.measureOf(tallies.get(b)!, checked.measure) ?? -Infinity) -
                (model.measureOf(tallies.get(a)!, checked.measure) ?? -Infinity)
        );
    }
    const shown = order.slice(0, model.MAX_GROUPS);
    const rest = order
        .slice(model.MAX_GROUPS)
        .reduce(
            (sum, key) => model.addTally(sum, tallies.get(key) ?? model.EMPTY_TALLY),
            model.EMPTY_TALLY
        );

    const labels = await groupLabels(actor, field.kind, field.target, shown);
    return {
        kind: "groups",
        points: shown.map((key) => ({
            key,
            label: labels.get(key) ?? null,
            value: model.measureOf(tallies.get(key) ?? model.EMPTY_TALLY, checked.measure)
        })),
        other: rest.count > 0 ? model.measureOf(rest, checked.measure) : null,
        capped
    };
}

/** The names of the people and records a split is grouped by; choices and
 *  yes/no are named on screen, in the reader's language. */
async function groupLabels(
    actor: CrmActor,
    kind: string,
    target: CrmObject | undefined,
    keys: readonly string[]
): Promise<Map<string, string>> {
    const ids = keys.filter(Boolean);
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    if (kind === "member") {
        for (const person of await shelfPeople(actor)) names.set(person.id, person.name);
    } else if (kind === "relation" && target && actor.can[target].read) {
        const rows = (await table(target).findMany({
            where: { id: { in: ids }, ...shelfWhere(actor.shelf) },
            select: recordSelect(target)
        })) as Record<string, unknown>[];
        for (const row of rows) {
            const record = toRecord(target, row);
            names.set(record.id, recordName(target, record));
        }
    }
    return names;
}
