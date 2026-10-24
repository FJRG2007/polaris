"use server";

/**
 * Dashboards: list them, make, rename and delete one, keep its widgets, and
 * answer one widget. Every input is checked against a schema here.
 */

import { z } from "zod";
import * as views from "../lib/views";
import * as fields from "../lib/fields";
import type { Abilities } from "../lib/access";
import * as dashboards from "../lib/dashboards";
import { requireCrmActor, requireCrmUser } from "../lib/access";
import type { ViewSummary } from "../model/views";
import type { CustomField } from "../model/fields";
import { CRM_OBJECTS, type CrmObject } from "../model/objects";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import {
    DASHBOARD_NAME_MAX,
    widgetSchema,
    widgetsSchema,
    type WidgetData
} from "../model/dashboards";

const id = z.string().uuid();
const name = z.string().max(DASHBOARD_NAME_MAX * 2);

export interface DashboardsOpening {
    readonly dashboards: dashboards.DashboardSummary[];
    readonly can: Abilities;
    readonly canManage: boolean;
    /** Per kind of record the reader may see: its saved views and added fields,
     *  for the widget dialog. */
    readonly objects: Partial<Record<CrmObject, { views: ViewSummary[]; fields: CustomField[] }>>;
}

export async function openDashboardsAction(): Promise<Outcome<DashboardsOpening>> {
    return outcome(async () => {
        const actor = await requireCrmActor();
        const readable = CRM_OBJECTS.filter((object) => actor.can[object].read);
        const [list, shared, perObject] = await Promise.all([
            dashboards.listDashboards(actor),
            dashboards.listSharedDashboards(actor),
            Promise.all(
                readable.map(async (object) => {
                    const [all, added] = await Promise.all([
                        views.listViews(actor, object),
                        fields.listFields(actor.shelf, object)
                    ]);
                    return [object, { views: all, fields: added }] as const;
                })
            )
        ]);
        return {
            dashboards: [...list, ...shared],
            can: actor.can,
            canManage: dashboards.canManage(actor),
            objects: Object.fromEntries(perObject)
        };
    });
}

export async function createDashboardAction(
    input: unknown
): Promise<Outcome<{ dashboard: dashboards.DashboardSummary }>> {
    const parsed = z.object({ name }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        dashboard: await dashboards.createDashboard(await requireCrmActor(), parsed.data.name)
    }));
}

export async function renameDashboardAction(
    input: unknown
): Promise<Outcome<{ dashboard: dashboards.DashboardSummary }>> {
    const parsed = z.object({ id, name }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        dashboard: await dashboards.renameDashboard(
            await requireCrmActor(),
            parsed.data.id,
            parsed.data.name
        )
    }));
}

export async function deleteDashboardAction(input: unknown): Promise<Outcome<{ deleted: true }>> {
    const parsed = z.object({ id }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        await dashboards.deleteDashboard(await requireCrmActor(), parsed.data.id);
        return { deleted: true as const };
    });
}

export async function saveWidgetsAction(
    input: unknown
): Promise<Outcome<{ dashboard: dashboards.DashboardSummary }>> {
    const parsed = z.object({ id, widgets: widgetsSchema }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        dashboard: await dashboards.saveWidgets(
            await requireCrmActor(),
            parsed.data.id,
            parsed.data.widgets
        )
    }));
}

/** One chart of a dashboard somebody shared with the reader, by its id. */
export async function sharedWidgetDataAction(
    input: unknown
): Promise<Outcome<{ data: WidgetData }>> {
    const parsed = z.object({ id, widgetId: id }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        data: await dashboards.sharedWidgetData(
            await requireCrmUser(),
            parsed.data.id,
            parsed.data.widgetId
        )
    }));
}

export async function widgetDataAction(input: unknown): Promise<Outcome<{ data: WidgetData }>> {
    const parsed = z.object({ widget: widgetSchema }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        data: await dashboards.widgetData(await requireCrmActor(), parsed.data.widget)
    }));
}
