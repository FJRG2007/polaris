/**
 * Relations somebody adds: the record ids a `cRel` slot holds, named for the
 * screens, and taken out of every list when the record they name is deleted.
 *
 * A database array cannot carry a foreign key, so this module is what keeps a
 * list from pointing at a record that no longer exists. A record in the trash
 * keeps its place in the lists it is in, so restoring it brings the links
 * back; until then it is not drawn.
 *
 * Server-only.
 */

import { Prisma } from "@polaris/db";
import { nameSelect, refName, table } from "./columns";
import { recordWhere, shelfWhere, type CrmActor } from "./access";
import {
    CRM_OBJECTS,
    SLOT_FAMILIES,
    isLinkList,
    type CrmObject,
    type CrmRecord,
    type FieldDef,
    type Ref
} from "../model/objects";

/** Every relation slot column, "cRel1" to "cRel3". */
export const LINK_SLOTS: readonly string[] = Array.from(
    { length: SLOT_FAMILIES.cRel },
    (_, index) => `cRel${index + 1}`
);

/**
 * Records with their relation lists named: one read per kind of record linked
 * to, however many records and fields. A linked record the reader may not
 * read, or one in the trash, is left out; so is every link of a slot no field
 * names any more.
 */
export async function nameLinks<T extends CrmRecord>(
    actor: CrmActor,
    records: readonly T[],
    custom: readonly FieldDef[]
): Promise<T[]> {
    const fields = custom.filter(isLinkList);
    const slots = LINK_SLOTS.filter((slot) => records.some((record) => slot in record.values));
    if (slots.length === 0) return [...records];
    const wanted = new Map<CrmObject, Set<string>>();
    for (const field of fields) {
        const ids = wanted.get(field.target!) ?? new Set<string>();
        for (const record of records) for (const ref of refsAt(record, field.key)) ids.add(ref.id);
        wanted.set(field.target!, ids);
    }
    const names = new Map<string, string>();
    await Promise.all(
        [...wanted].map(async ([target, ids]) => {
            if (ids.size === 0 || !actor.can[target].read) return;
            const rows = (await table(target).findMany({
                where: { id: { in: [...ids] }, ...recordWhere(actor, target), deletedAt: null },
                select: nameSelect(target)
            })) as Record<string, unknown>[];
            for (const row of rows) names.set(`${target}:${String(row.id)}`, refName(row));
        })
    );
    return records.map((record) => {
        const values = { ...record.values };
        for (const slot of slots) {
            if (!(slot in values)) continue;
            const field = fields.find((one) => one.key === slot);
            values[slot] = field
                ? refsAt(record, slot).flatMap((ref) => {
                      const name = names.get(`${field.target}:${ref.id}`);
                      return name === undefined ? [] : [{ id: ref.id, name }];
                  })
                : [];
        }
        return { ...record, values };
    });
}

/**
 * Relation lists about to be written, per record: a list keeps the ids it
 * already holds that the writer cannot see - a record they may not read, or
 * one in the trash - since they could not have meant to take those out. A
 * list that holds one record is replaced when the writer picks one, and kept
 * when they only clear it. Records that end up written the same are grouped,
 * so each group is one update; null when the values hold no relation list.
 */
export async function keepUnseenLinks(
    actor: CrmActor,
    rows: readonly Record<string, unknown>[],
    custom: readonly FieldDef[],
    data: Readonly<Record<string, unknown>>
): Promise<{ ids: string[]; data: Record<string, unknown> }[] | null> {
    const fields = custom.filter((field) => isLinkList(field) && field.key in data);
    if (fields.length === 0) return null;
    const stored = (row: Record<string, unknown>, slot: string): string[] =>
        Array.isArray(row[slot]) ? (row[slot] as string[]) : [];
    const seen = new Map<CrmObject, Set<string>>();
    await Promise.all(
        [...new Set(fields.map((field) => field.target!))].map(async (target) => {
            const ids = new Set(
                fields
                    .filter((field) => field.target === target)
                    .flatMap((field) => rows.flatMap((row) => stored(row, field.key)))
            );
            const visible = new Set<string>();
            seen.set(target, visible);
            if (ids.size === 0 || !actor.can[target].read) return;
            const found = (await table(target).findMany({
                where: { id: { in: [...ids] }, ...recordWhere(actor, target), deletedAt: null },
                select: { id: true }
            })) as { id: string }[];
            for (const row of found) visible.add(row.id);
        })
    );
    const groups = new Map<string, { ids: string[]; data: Record<string, unknown> }>();
    for (const row of rows) {
        const written: Record<string, unknown> = { ...data };
        for (const field of fields) {
            const posted = data[field.key] as readonly string[];
            const unseen = stored(row, field.key).filter((id) => !seen.get(field.target!)!.has(id));
            written[field.key] = field.many
                ? [...new Set([...posted, ...unseen])]
                : posted.length > 0
                  ? [...posted]
                  : unseen;
        }
        const key = JSON.stringify(fields.map((field) => written[field.key]));
        const group = groups.get(key) ?? { ids: [], data: written };
        group.ids.push(String(row.id));
        groups.set(key, group);
    }
    return [...groups.values()];
}

function refsAt(record: CrmRecord, key: string): readonly Ref[] {
    const value = record.values[key];
    return Array.isArray(value) ? value : [];
}

/** One record a deletion took out of another record's relation list. */
export interface Unlinked {
    readonly object: CrmObject;
    readonly recordId: string;
    readonly slot: string;
    readonly before: readonly string[];
    readonly after: readonly string[];
}

/**
 * Take deleted records out of every relation list on the shelf, in the
 * transaction that deletes them. Every slot of every kind is swept, not only
 * the ones a field names today, so a slot handed to a later field never holds
 * an id of a record that is gone.
 */
export async function unlinkRecords(
    tx: Prisma.TransactionClient,
    actor: CrmActor,
    gone: readonly string[]
): Promise<Unlinked[]> {
    return rewriteLinks(tx, actor, gone, null);
}

/**
 * Point every relation list on the shelf that holds one of the records merged
 * away at the record kept instead, once, in the merge's transaction.
 */
export async function relinkRecords(
    tx: Prisma.TransactionClient,
    actor: CrmActor,
    merged: readonly string[],
    keepId: string
): Promise<Unlinked[]> {
    return rewriteLinks(tx, actor, merged, keepId);
}

/** The table each kind of record is kept in, for the set-based sweep. */
const TABLES: Readonly<Record<CrmObject, string>> = {
    companies: "CrmCompany",
    people: "CrmPerson",
    opportunities: "CrmOpportunity"
};

/** The most rows one statement of the sweep rewrites. */
const SWEEP_BATCH = 1000;

async function rewriteLinks(
    tx: Prisma.TransactionClient,
    actor: CrmActor,
    gone: readonly string[],
    keepId: string | null
): Promise<Unlinked[]> {
    if (gone.length === 0) return [];
    const doomed = new Set(gone);
    const unlinked: Unlinked[] = [];
    for (const object of CRM_OBJECTS) {
        const rows = (await table(object, tx).findMany({
            where: {
                ...shelfWhere(actor.shelf),
                OR: LINK_SLOTS.map((slot) => ({ [slot]: { hasSome: [...gone] } }))
            },
            select: { id: true, ...Object.fromEntries(LINK_SLOTS.map((slot) => [slot, true])) }
        })) as Record<string, unknown>[];
        for (const slot of LINK_SLOTS) {
            const changed: Unlinked[] = [];
            for (const row of rows) {
                const before = Array.isArray(row[slot]) ? (row[slot] as string[]) : [];
                if (!before.some((id) => doomed.has(id))) continue;
                const after = [
                    ...new Set(before.map((id) => (doomed.has(id) ? keepId : id)))
                ].filter((id): id is string => id !== null);
                changed.push({ object, recordId: String(row.id), slot, before, after });
            }
            for (let start = 0; start < changed.length; start += SWEEP_BATCH) {
                const batch = changed.slice(start, start + SWEEP_BATCH);
                const values = Prisma.join(
                    batch.map((one) => Prisma.sql`(${one.recordId}::uuid, ${one.after}::uuid[])`)
                );
                const target = Prisma.raw(`"${TABLES[object]}"`);
                const column = Prisma.raw(`"${slot}"`);
                await tx.$executeRaw`UPDATE ${target} AS t SET ${column} = v.after, "updatedAt" = now() AT TIME ZONE 'UTC' FROM (VALUES ${values}) AS v(id, after) WHERE t."id" = v.id`;
            }
            unlinked.push(...changed);
        }
    }
    return unlinked;
}
