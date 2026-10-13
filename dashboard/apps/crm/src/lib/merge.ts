/**
 * Merging duplicates into one record: the kept record's empty fields are filled
 * from the others, in the order given, everything that pointed at the others
 * (people at a company, opportunities at a company or a contact, notes, tasks
 * and files) points at the kept one, and the others go to the trash, where
 * they can still be restored.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { shown } from "./records";
import { prisma } from "@polaris/db";
import { CrmRefusal } from "./errors";
import { loadFields } from "./fields";
import { logEvents } from "./timeline";
import { changesBetween } from "../model/timeline";
import { columnOf, recordSelect, table, toRecord } from "./columns";
import { fieldOf, fieldsOf, type CrmObject, type CrmRecord } from "../model/objects";
import { MAX_MERGE } from "../model/duplicates";
import {
    recordWhere,
    requireCan,
    requireChangeable,
    shelfWhere,
    type CrmActor
} from "./access";

export { MAX_MERGE };

const empty = (value: unknown): boolean => value === null || value === undefined || value === "";

/** The columns a field is stored in, filled together or not at all. */
function columnsOf(object: CrmObject, key: string): string[] {
    const spec = columnOf(object, key);
    if (spec.type === "name") return [spec.first, spec.last];
    if (spec.type === "money") return [spec.amount, spec.currency];
    return [spec.column];
}

/** The records of other kinds that point at the merged ones, by the field that points. */
const LINKED: Readonly<Record<CrmObject, readonly { object: CrmObject; key: string }[]>> = {
    companies: [
        { object: "people", key: "company" },
        { object: "opportunities", key: "company" }
    ],
    people: [{ object: "opportunities", key: "pointOfContact" }],
    opportunities: []
};

/**
 * Refuse unless the reader may repoint every record that points at the ones
 * merged away: edit on its kind, the pointing field not locked by their role,
 * and every such record one they reach.
 */
async function requireRepointable(
    actor: CrmActor,
    object: CrmObject,
    others: readonly string[]
): Promise<void> {
    const t = await crmT();
    for (const link of LINKED[object]) {
        const column = columnsOf(link.object, link.key)[0]!;
        const pointing = { [column]: { in: [...others] } };
        const total = await table(link.object).count({
            where: { ...shelfWhere(actor.shelf), ...pointing }
        });
        if (total === 0) continue;
        await requireCan(actor, link.object, "edit");
        await requireChangeable(actor, link.object, [link.key], async (key) => {
            const field = fieldOf(link.object, key);
            return field?.label ?? t(`fields.${link.object}.${key}` as Parameters<typeof t>[0]);
        });
        const reached = await table(link.object).count({
            where: { ...recordWhere(actor, link.object), ...pointing }
        });
        if (reached !== total) throw new CrmRefusal(t("merge.linked"));
    }
}

/** Merge `ids` into `keepId`. Returns the kept record as it is now. */
export async function mergeRecords(
    actor: CrmActor,
    object: CrmObject,
    keepId: string,
    ids: readonly string[]
): Promise<CrmRecord> {
    await requireCan(actor, object, "edit");
    await requireCan(actor, object, "delete");
    const t = await crmT();
    const others = [...new Set(ids)].filter((id) => id !== keepId);
    if (others.length === 0 || others.length >= MAX_MERGE) {
        throw new CrmRefusal(t("merge.count", { count: MAX_MERGE }));
    }
    await requireRepointable(actor, object, others);
    const rule = actor.rules?.[object];
    const fields = fieldsOf(object, await loadFields(actor.shelf, object)).filter(
        (field) =>
            !field.readOnly &&
            !rule?.hidden.includes(field.key) &&
            !rule?.readOnly.includes(field.key)
    );
    const columns = fields.map((field) => columnsOf(object, field.key));
    const select = Object.fromEntries(
        ["id", "updatedAt", ...columns.flat()].map((column) => [column, true] as const)
    );
    const where = { ...recordWhere(actor, object), deletedAt: null };

    const { before, after, filled } = await prisma.$transaction(async (tx) => {
        const rows = (await table(object, tx).findMany({
            where: { ...where, id: { in: [keepId, ...others] } },
            select
        })) as Record<string, unknown>[];
        const keep = rows.find((row) => row.id === keepId);
        const merged = others.map((id) => rows.find((row) => row.id === id));
        if (!keep || merged.some((row) => !row)) throw new CrmRefusal(t("merge.missing"));

        // A field is filled only when every one of its columns is empty on the
        // kept record, and from the first other record that has it.
        const data: Record<string, unknown> = {};
        const filled: string[] = [];
        fields.forEach((field, index) => {
            const group = columns[index]!;
            if (!group.every((column) => empty(keep[column]))) return;
            const source = merged.find((row) => group.some((column) => !empty(row![column])));
            if (!source) return;
            for (const column of group) data[column] = source[column];
            filled.push(field.key);
        });
        const before = (await table(object, tx).findFirst({
            where: { id: keepId },
            select: recordSelect(object)
        })) as Record<string, unknown>;

        const kept = await table(object, tx).updateMany({
            where: { ...where, id: keepId, updatedAt: keep.updatedAt },
            data: { ...data, updatedById: actor.user.id }
        });
        if (kept.count !== 1) throw new CrmRefusal(t("merge.missing"));
        const trashed = await table(object, tx).updateMany({
            where: { ...where, id: { in: others } },
            data: { deletedAt: new Date() }
        });
        if (trashed.count !== others.length) throw new CrmRefusal(t("merge.missing"));

        const shelf = shelfWhere(actor.shelf);
        for (const link of LINKED[object]) {
            const column = columnsOf(link.object, link.key)[0]!;
            await table(link.object, tx).updateMany({
                where: { ...shelf, [column]: { in: others } },
                data: { [column]: keepId }
            });
        }
        // A note, task or file linked to both stays linked once.
        const links = await tx.crmLink.findMany({
            where: { ...shelf, object, recordId: keepId },
            select: { kind: true, targetId: true }
        });
        if (links.length > 0) {
            await tx.crmLink.deleteMany({
                where: {
                    ...shelf,
                    object,
                    recordId: { in: others },
                    OR: links.map((link) => ({ kind: link.kind, targetId: link.targetId }))
                }
            });
        }
        await tx.crmLink.updateMany({
            where: { ...shelf, object, recordId: { in: others } },
            data: { recordId: keepId }
        });
        const after = (await table(object, tx).findFirst({
            where: { id: keepId },
            select: recordSelect(object)
        })) as Record<string, unknown>;
        return { before, after, filled };
    });
    const record = toRecord(object, after);
    await logEvents(actor, object, [
        ...(filled.length > 0
            ? [
                  {
                      recordId: keepId,
                      kind: "updated" as const,
                      changes: changesBetween(toRecord(object, before), record, filled)
                  }
              ]
            : []),
        ...others.map((id) => ({ recordId: id, kind: "trashed" as const }))
    ]);
    return shown(actor, object, after);
}
