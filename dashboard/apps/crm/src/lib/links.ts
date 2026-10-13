/**
 * A record's links to what other apps keep: which notes, tasks and files hang
 * off it. Only the ids live here; each app is asked for what the reader may
 * open, so a link to something gone or not theirs is simply not shown.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { prisma } from "@polaris/db";
import { table } from "./columns";
import { CrmRefusal } from "./errors";
import type { CrmObject } from "../model/objects";
import { LINK_PAGE, type LinkKind } from "../model/links";
import { recordWhere, requireCan, shelfData, shelfWhere, type CrmActor } from "./access";

/** The record, among those the reader reaches and out of the trash, or a refusal. */
export async function requireLiveRecord(
    actor: CrmActor,
    object: CrmObject,
    recordId: string
): Promise<void> {
    const found = await table(object).count({
        where: { id: recordId, ...recordWhere(actor, object), deletedAt: null }
    });
    if (found === 0) throw new CrmRefusal((await crmT())("errors.notFound"));
}

/** The ids a record links to, of one kind, the newest link first. */
export async function linkedIds(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    kind: LinkKind
): Promise<string[]> {
    await requireCan(actor, object, "read");
    const rows = (await prisma.crmLink.findMany({
        where: { ...shelfWhere(actor.shelf), object, recordId, kind },
        orderBy: { id: "desc" },
        take: LINK_PAGE,
        select: { targetId: true }
    })) as { targetId: string }[];
    return rows.map((row) => row.targetId);
}

/** Whether a record links to a target. */
export async function isLinked(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    kind: LinkKind,
    targetId: string
): Promise<boolean> {
    await requireCan(actor, object, "read");
    const found = await prisma.crmLink.count({
        where: { ...shelfWhere(actor.shelf), object, recordId, kind, targetId }
    });
    return found > 0;
}

/** Link a record to something; linking it twice is a no-op. */
export async function addLink(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    kind: LinkKind,
    targetId: string
): Promise<void> {
    await requireCan(actor, object, "edit");
    await requireLiveRecord(actor, object, recordId);
    await prisma.crmLink.createMany({
        data: [
            {
                ...shelfData(actor.shelf),
                object,
                recordId,
                kind,
                targetId,
                createdById: actor.user.id
            }
        ],
        skipDuplicates: true
    });
}

/** Take a link off a record. The thing it pointed at is left as it is. */
export async function removeLink(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    kind: LinkKind,
    targetId: string
): Promise<boolean> {
    await requireCan(actor, object, "edit");
    const result = await prisma.crmLink.deleteMany({
        where: { ...shelfWhere(actor.shelf), object, recordId, kind, targetId }
    });
    return result.count > 0;
}
