/**
 * Saved views: how a list is drawn - table or board, its columns, totals,
 * sorts, filter and grouping - shared by everybody on the shelf.
 *
 * Every kind of record has a default view - the one with no name - made the
 * first time anybody opens that list on the shelf; it cannot be renamed or
 * deleted. Other views are named, and a name is used once per kind of record.
 * Changing, adding or removing a view is changing what everybody on the shelf
 * sees, so it takes the right to change that kind of record, not just to read
 * it.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { prisma } from "@polaris/db";
import { CrmRefusal } from "./errors";
import type { CrmObject } from "../model/objects";
import { requireCan, type CrmActor } from "./access";
import {
    defaultConfig,
    groupFields,
    MAX_VIEWS,
    normalizeViewName,
    readConfig,
    VIEW_NAME_MAX,
    type ViewConfig,
    type ViewKind,
    type ViewSummary
} from "../model/views";

const VIEW_SELECT = { id: true, name: true, kind: true, config: true } as const;

type ViewRow = { id: string; name: string; kind: string; config: string };

/** A kind of view this kind of record can be drawn as: a board needs a field
 *  with choices, so a kind of record without one is a table. */
function kindFor(object: CrmObject, kind: string): ViewKind {
    return kind === "kanban" && groupFields(object).length > 0 ? "kanban" : "table";
}

function summary(object: CrmObject, row: ViewRow): ViewSummary {
    let stored: unknown = null;
    try {
        stored = JSON.parse(row.config);
    } catch {
        // An unreadable config is the default, which `readConfig` gives for null.
    }
    return {
        id: row.id,
        name: row.name,
        kind: kindFor(object, row.kind),
        config: readConfig(object, stored)
    };
}

async function refuse(
    key: "viewMissing" | "viewNameTaken" | "viewName" | "viewDefault" | "viewLimit"
): Promise<never> {
    const t = await crmT();
    throw new CrmRefusal(t(`errors.${key}`, { max: MAX_VIEWS, length: VIEW_NAME_MAX }));
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

/** Every view of a kind of record on this shelf: the default first, then the
 *  named ones in the order they were made. */
export async function listViews(actor: CrmActor, object: CrmObject): Promise<ViewSummary[]> {
    const first = await defaultView(actor, object);
    const named = await prisma.crmView.findMany({
        where: { shelf: actor.shelf.key, object, NOT: { name: "" } },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: MAX_VIEWS,
        select: VIEW_SELECT
    });
    return [first, ...named.map((row) => summary(object, row))];
}

/** A name typed for a view, checked: there, not too long. */
async function cleanName(name: string): Promise<string> {
    const clean = normalizeViewName(name);
    if (!clean || clean.length > VIEW_NAME_MAX) await refuse("viewName");
    return clean;
}

/** Whether a write failed on the one-name-per-kind rule. */
function nameTaken(caught: unknown): boolean {
    return (caught as { code?: unknown } | null)?.code === "P2002";
}

/** Refuse a name another view of this kind already has, in any casing. */
async function refuseTaken(
    actor: CrmActor,
    object: CrmObject,
    name: string,
    except?: string
): Promise<void> {
    const clash = await prisma.crmView.findFirst({
        where: {
            shelf: actor.shelf.key,
            object,
            // SQLite has no `mode`; its comparisons of ASCII text ignore case
            // only with LIKE, so a local install compares as typed.
            name:
                process.env.POLARIS_DB_PROVIDER === "sqlite"
                    ? { equals: name }
                    : { equals: name, mode: "insensitive" },
            ...(except ? { NOT: { id: except } } : {})
        },
        select: { id: true }
    });
    if (clash) await refuse("viewNameTaken");
}

/** A new named view, drawn the way the reader is drawing the list now. */
export async function createView(
    actor: CrmActor,
    object: CrmObject,
    input: { readonly name: string; readonly kind: ViewKind; readonly config: ViewConfig }
): Promise<ViewSummary> {
    await requireCan(actor, object, "edit");
    const name = await cleanName(input.name);
    const where = { shelf: actor.shelf.key, object, NOT: { name: "" } };
    const [count, last] = await Promise.all([
        prisma.crmView.count({ where }),
        prisma.crmView.findFirst({
            where,
            orderBy: { position: "desc" },
            select: { position: true }
        })
    ]);
    if (count >= MAX_VIEWS) await refuse("viewLimit");
    await refuseTaken(actor, object, name);
    try {
        const made = await prisma.crmView.create({
            data: {
                shelf: actor.shelf.key,
                orgId: actor.shelf.orgId,
                userId: actor.shelf.orgId ? null : actor.shelf.userId,
                object,
                name,
                kind: kindFor(object, input.kind),
                config: JSON.stringify(readConfig(object, input.config)),
                position: (last?.position ?? 0) + 1,
                createdById: actor.user.id
            },
            select: VIEW_SELECT
        });
        return summary(object, made);
    } catch (caught) {
        if (nameTaken(caught)) await refuse("viewNameTaken");
        throw caught;
    }
}

/** Give a named view another name. The default view keeps having none. */
export async function renameView(
    actor: CrmActor,
    object: CrmObject,
    viewId: string,
    name: string
): Promise<ViewSummary> {
    await requireCan(actor, object, "edit");
    const clean = await cleanName(name);
    const where = { id: viewId, shelf: actor.shelf.key, object };
    const found = await prisma.crmView.findFirst({ where, select: { name: true } });
    if (!found) await refuse("viewMissing");
    if (found!.name === "") await refuse("viewDefault");
    await refuseTaken(actor, object, clean, viewId);
    try {
        const row = await prisma.crmView.update({
            where: { id: viewId },
            data: { name: clean },
            select: VIEW_SELECT
        });
        return summary(object, row);
    } catch (caught) {
        if (nameTaken(caught)) await refuse("viewNameTaken");
        throw caught;
    }
}

/** Remove a named view. The default view cannot be removed. */
export async function deleteView(
    actor: CrmActor,
    object: CrmObject,
    viewId: string
): Promise<void> {
    await requireCan(actor, object, "edit");
    const where = { id: viewId, shelf: actor.shelf.key, object };
    const found = await prisma.crmView.findFirst({ where, select: { name: true } });
    if (!found) await refuse("viewMissing");
    if (found!.name === "") await refuse("viewDefault");
    await prisma.crmView.deleteMany({ where: { ...where, NOT: { name: "" } } });
}

/** Store how a view is drawn: its columns, totals, sorts, filter and grouping,
 *  and whether it is a table or a board. */
export async function saveViewConfig(
    actor: CrmActor,
    object: CrmObject,
    viewId: string,
    config: ViewConfig,
    kind?: ViewKind
): Promise<ViewSummary> {
    await requireCan(actor, object, "edit");
    const clean = readConfig(object, config);
    const where = { id: viewId, shelf: actor.shelf.key, object };
    const result = await prisma.crmView.updateMany({
        where,
        data: { config: JSON.stringify(clean), ...(kind ? { kind: kindFor(object, kind) } : {}) }
    });
    const row =
        result.count > 0 ? await prisma.crmView.findFirst({ where, select: VIEW_SELECT }) : null;
    if (!row) await refuse("viewMissing");
    return summary(object, row!);
}
