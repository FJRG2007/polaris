/**
 * Saved views: the columns, totals and sorts a table is drawn with, shared by
 * everybody on the shelf.
 *
 * Every kind of record has a default view - the one with no name - made the
 * first time anybody opens that list on the shelf. Changing a view is changing
 * what everybody on the shelf sees, so it takes the right to change that kind
 * of record, not just to read it.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { prisma } from "@polaris/db";
import { CrmRefusal } from "./errors";
import type { CrmObject } from "../model/objects";
import { requireCan, type CrmActor } from "./access";
import { defaultConfig, readConfig, type ViewConfig, type ViewSummary } from "../model/views";

const VIEW_SELECT = { id: true, name: true, config: true } as const;

function summary(object: CrmObject, row: { id: string; name: string; config: string }): ViewSummary {
    let stored: unknown = null;
    try {
        stored = JSON.parse(row.config);
    } catch {
        // An unreadable config is the default, which `readConfig` gives for null.
    }
    return { id: row.id, name: row.name, config: readConfig(object, stored) };
}

/** The view a kind of record opens with on this shelf, made if it is missing. */
export async function defaultView(actor: CrmActor, object: CrmObject): Promise<ViewSummary> {
    await requireCan(actor, object, "read");
    const key = { shelf_object_name: { shelf: actor.shelf.key, object, name: "" } };
    const found = await prisma.crmView.findUnique({ where: key, select: VIEW_SELECT });
    if (found) return summary(object, found);
    try {
        const made = await prisma.crmView.create({
            data: {
                shelf: actor.shelf.key,
                orgId: actor.shelf.orgId,
                userId: actor.shelf.orgId ? null : actor.shelf.userId,
                object,
                name: "",
                config: JSON.stringify(defaultConfig(object)),
                createdById: actor.user.id
            },
            select: VIEW_SELECT
        });
        return summary(object, made);
    } catch {
        // Two first visits at once: the other one made it.
        const raced = await prisma.crmView.findUnique({ where: key, select: VIEW_SELECT });
        if (raced) return summary(object, raced);
        throw new Error("crm: the default view could not be made");
    }
}

/** Store a view's columns, totals and sorts. */
export async function saveViewConfig(
    actor: CrmActor,
    object: CrmObject,
    viewId: string,
    config: ViewConfig
): Promise<ViewSummary> {
    await requireCan(actor, object, "edit");
    const clean = readConfig(object, config);
    const result = await prisma.crmView.updateMany({
        where: { id: viewId, shelf: actor.shelf.key, object },
        data: { config: JSON.stringify(clean) }
    });
    if (result.count === 0) {
        const t = await crmT();
        throw new CrmRefusal(t("errors.viewMissing"));
    }
    return { id: viewId, name: "", config: clean };
}
