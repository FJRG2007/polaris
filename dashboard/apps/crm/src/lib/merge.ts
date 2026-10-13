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
import { fieldsOf, type CrmObject, type CrmRecord } from "../model/objects";
import { MAX_MERGE } from "../model/duplicates";
import { recordWhere, requireCan, shelfWhere, type CrmActor } from "./access";

export { MAX_MERGE };

const empty = (value: unknown): boolean => value === null || value === undefined || value === "";

/** The columns a field is stored in, filled together or not at all. */
function columnsOf(object: CrmObject, key: string): string[] {
    const spec = columnOf(object, key);
    if (spec.type === "name") return [spec.first, spec.last];
    if (spec.type === "money") return [spec.amount, spec.currency];
    return [spec.column];
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
    const rule = actor.rules?.[object];
    const fields = fieldsOf(object, await loadFields(actor.shelf, object)).filter(
        (field) =>
            !field.readOnly &&
            !rule?.hidden.includes(field.key) &&
            !rule?.readOnly.includes(field.key)
    );
    const columns = fields.map((field) => columnsOf(object, field.key));
    const select = Object.fromEntries(
        ["id", ...columns.flat()].map((column) => [column, true] as const)
    );
    const where = { ...recordWhere(actor, object), deletedAt: null };
    const rows = (await table(object).findMany({
        where: { ...where, id: { in: [keepId, ...others] } },
        select
    })) as Record<string, unknown>[];
    const keep = rows.find((row) => row.id === keepId);
    const merged = others.map((id) => rows.find((row) => row.id === id));
    if (!keep || merged.some((row) => !row)) throw new CrmRefusal(t("merge.missing"));

    // A field is filled only when every one of its columns is empty on the kept
    // record, and from the first other record that has it.
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

    const before = (await table(object).findFirst({
        where: { id: keepId },
        select: recordSelect(object)
    })) as Record<string, unknown>;
    const after = await prisma.$transaction(async (tx) => {
        const shelf = shelfWhere(actor.shelf);
        if (object === "companies") {
            for (const target of ["people", "opportunities"] as const) {
                await table(target, tx).updateMany({
                    where: { ...shelf, companyId: { in: others } },
                    data: { companyId: keepId }
                });
            }
        }
        if (object === "people") {
            await table("opportunities", tx).updateMany({
                where: { ...shelf, pointOfContactId: { in: others } },
                data: { pointOfContactId: keepId }
            });
        }
        // A note, task or file linked to both stays linked once.
        const kept = await tx.crmLink.findMany({
            where: { ...shelf, object, recordId: keepId },
            select: { kind: true, targetId: true }
        });
        if (kept.length > 0) {
            await tx.crmLink.deleteMany({
                where: {
                    ...shelf,
                    object,
                    recordId: { in: others },
                    OR: kept.map((link) => ({ kind: link.kind, targetId: link.targetId }))
                }
            });
        }
        await tx.crmLink.updateMany({
            where: { ...shelf, object, recordId: { in: others } },
            data: { recordId: keepId }
        });
        await table(object, tx).updateMany({
            where: { ...where, id: { in: others } },
            data: { deletedAt: new Date() }
        });
        return table(object, tx).update({
            where: { id: keepId },
            data: { ...data, updatedById: actor.user.id },
            select: recordSelect(object)
        });
    });
    const record = toRecord(object, after as Record<string, unknown>);
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
    return shown(actor, object, after as Record<string, unknown>);
}
