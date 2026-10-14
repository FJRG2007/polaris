/**
 * Favorites: records and views somebody pinned to the CRM's rail.
 *
 * Each one is the reader's own, kept per shelf, so an organization's favorites
 * show while working in it and a personal CRM's in that one. What a favorite
 * points at is read again every time it is listed, through the same shelf and
 * role checks as everything else: a record gone to the trash, a view deleted
 * or a kind of record the role no longer sees simply stops being listed.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { CrmRefusal } from "./errors";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { recordHref } from "../model/related";
import { recordSelect, table, toRecord } from "./columns";
import { crmActor, recordWhere, requireCan, type CrmActor } from "./access";
import { CRM_OBJECTS, recordName, type CrmObject } from "../model/objects";

/** The most favorites one person keeps on one shelf: a rail, not a list. */
export const MAX_FAVORITES = 50;

export type FavoriteKind = "record" | "view";

export interface Favorite {
    readonly id: string;
    readonly kind: FavoriteKind;
    readonly object: CrmObject;
    readonly targetId: string;
    readonly label: string;
    readonly href: string;
}

/** The reader's favorites on this shelf, in the order they were pinned. */
function mine(actor: CrmActor) {
    return { userId: actor.user.id, orgId: actor.shelf.orgId };
}

/** Pin a record or a view: only one the reader may see on this shelf. */
export async function addFavorite(
    actor: CrmActor,
    kind: FavoriteKind,
    object: CrmObject,
    targetId: string
): Promise<void> {
    await requireCan(actor, object, "read");
    const t = await crmT();
    const there =
        kind === "record"
            ? await table(object).findFirst({
                  where: { id: targetId, ...recordWhere(actor, object), deletedAt: null },
                  select: { id: true }
              })
            : await prisma.crmView.findFirst({
                  where: { id: targetId, shelf: actor.shelf.key, object },
                  select: { id: true }
              });
    if (!there)
        throw new CrmRefusal(t(kind === "record" ? "errors.notFound" : "errors.viewMissing"));
    const [count, last] = await Promise.all([
        prisma.crmFavorite.count({ where: mine(actor) }),
        prisma.crmFavorite.findFirst({
            where: mine(actor),
            orderBy: { position: "desc" },
            select: { position: true }
        })
    ]);
    if (count >= MAX_FAVORITES) {
        throw new CrmRefusal(t("favorites.limit", { max: MAX_FAVORITES }));
    }
    await prisma.crmFavorite.upsert({
        where: { userId_kind_targetId: { userId: actor.user.id, kind, targetId } },
        create: { ...mine(actor), kind, object, targetId, position: (last?.position ?? 0) + 1 },
        update: {}
    });
}

/** Unpin one. Nothing to do when it was not pinned. */
export async function removeFavorite(
    actor: CrmActor,
    kind: FavoriteKind,
    targetId: string
): Promise<void> {
    await prisma.crmFavorite.deleteMany({ where: { ...mine(actor), kind, targetId } });
}

/** Which of these are pinned by the reader. */
export async function pinnedAmong(
    actor: CrmActor,
    kind: FavoriteKind,
    targetIds: readonly string[]
): Promise<string[]> {
    if (targetIds.length === 0) return [];
    const rows = await prisma.crmFavorite.findMany({
        where: { ...mine(actor), kind, targetId: { in: [...targetIds] } },
        select: { targetId: true }
    });
    return rows.map((row) => row.targetId);
}

/** The reader's favorites on this shelf, named and linked, in order. */
export async function listFavorites(actor: CrmActor): Promise<Favorite[]> {
    const rows = await prisma.crmFavorite.findMany({
        where: mine(actor),
        orderBy: [{ position: "asc" }, { id: "asc" }],
        take: MAX_FAVORITES,
        select: { id: true, kind: true, object: true, targetId: true }
    });
    const visible = rows.filter(
        (row): row is typeof row & { object: CrmObject } =>
            (CRM_OBJECTS as readonly string[]).includes(row.object) &&
            actor.can[row.object as CrmObject].read
    );
    if (visible.length === 0) return [];
    const t = await crmT();
    const names = new Map<string, { label: string; href: string }>();

    // One read per kind of record, and one for the views.
    await Promise.all(
        CRM_OBJECTS.map(async (object) => {
            const ids = visible
                .filter((row) => row.kind === "record" && row.object === object)
                .map((row) => row.targetId);
            if (ids.length === 0) return;
            const found = (await table(object).findMany({
                where: { id: { in: ids }, ...recordWhere(actor, object), deletedAt: null },
                select: recordSelect(object)
            })) as Record<string, unknown>[];
            for (const row of found) {
                const record = toRecord(object, row);
                names.set(record.id, {
                    label: recordName(object, record) || t("record.untitled"),
                    href: recordHref(object, record.id)
                });
            }
        })
    );
    const viewIds = visible.filter((row) => row.kind === "view").map((row) => row.targetId);
    if (viewIds.length > 0) {
        const found = await prisma.crmView.findMany({
            where: { id: { in: viewIds }, shelf: actor.shelf.key },
            select: { id: true, name: true, object: true }
        });
        for (const view of found) {
            const object = view.object as CrmObject;
            const plural = t(`objects.${object}.plural`);
            names.set(view.id, {
                label: view.name ? `${plural}: ${view.name}` : plural,
                href: `/crm/${object}?view=${view.id}`
            });
        }
    }

    return visible.flatMap((row) => {
        const named = names.get(row.targetId);
        return named
            ? [
                  {
                      id: row.id,
                      kind: row.kind as FavoriteKind,
                      object: row.object,
                      targetId: row.targetId,
                      ...named
                  }
              ]
            : [];
    });
}

/** The rail's favorites for an account, or none when it may not use the CRM. */
export async function railFavorites(
    userId: string
): Promise<{ id: string; label: string; href: string }[]> {
    const user = await host.crmHost.crmRunner(userId);
    if (!user) return [];
    const favorites = await listFavorites(await crmActor(user));
    return favorites.map(({ id, label, href }) => ({ id, label, href }));
}
