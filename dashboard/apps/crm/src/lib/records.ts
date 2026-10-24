/**
 * Reading and writing CRM records, for every kind of record at once.
 *
 * Each function takes the resolved reader (`CrmActor`) and checks what they may
 * do before it touches anything; every query is narrowed to their shelf in the
 * `where`, so an id from another shelf is simply not found.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { CrmRefusal } from "./errors";
import { loadFields } from "./fields";
import { keepUnseenLinks, nameLinks, unlinkRecords } from "./linked";
import { recordHref, relatedLists } from "../model/related";
import { prisma } from "@polaris/db";
import { dropEvents, logEvents, type NewEvent } from "./timeline";
import { changesBetween, initialValues } from "../model/timeline";
import { host } from "@polaris/app-host";
import { CRM_OBJECTS } from "@polaris/core";
import {
    afterCursor,
    groupColumn,
    listOrder,
    listWhere,
    pageCursor,
    searchWhere,
    type ListScope
} from "./query";
import { normalizeInput, type InputValue } from "../model/values";
import { filterKeys, hideValues } from "../model/roles";
import * as access from "./access";
import { crmActor, recordWhere, requireCan, shelfData, shelfWhere, type CrmActor } from "./access";
import { recordSelect, table, toRecord, writable, writeData } from "./columns";
import {
    fieldOf,
    isLinkList,
    linksOf,
    primaryField,
    recordName,
    type CrmObject,
    type CrmRecord,
    type FieldDef,
    type Ref
} from "../model/objects";
import { groupable, type ViewSort } from "../model/views";

/** The most rows one page of a list returns. */
export const PAGE_SIZE = 50;

/** The most records one bulk change touches. */
export const MAX_BULK = 500;

export interface RecordPage {
    readonly records: CrmRecord[];
    /** How many rows match, across every page - null on a page read after
     *  another (`after`), which is not counted again: the first page's count
     *  still holds. */
    readonly total: number | null;
    /** Where the next page starts (`after`), or null when the order cannot be
     *  followed that way and the next page is counted by `offset`. */
    readonly next: string | null;
    /** False when this page reached the end of the list. */
    readonly more: boolean;
}

export interface ListOptions extends ListScope {
    readonly sorts?: readonly ViewSort[];
    /** A board's order: where its cards were put, when it has no sorts. */
    readonly byPosition?: boolean;
    readonly offset?: number;
    /** The `next` of the page before: this page starts right after it, found
     *  through the index rather than by counting past `offset` rows. A cursor
     *  that does not fit the order falls back to `offset`. */
    readonly after?: string;
    readonly limit?: number;
    /** False when the caller already counted the rows (a board's columns are
     *  counted together in one query), so the page is not counted again. */
    readonly count?: boolean;
}

/** One page of a list. */
export async function listRecords(
    actor: CrmActor,
    object: CrmObject,
    options: ListOptions
): Promise<RecordPage> {
    await requireCan(actor, object, "read");
    await requireListShown(actor, object, options);
    const custom = options.custom ?? (await loadFields(actor.shelf, object));
    if (options.group) requireGroupable(object, options.group.key, custom);
    const where = listWhere(object, actor, { ...options, custom });
    const orderBy = listOrder(object, options.sorts ?? [], options.byPosition);
    const take = Math.min(Math.max(1, options.limit ?? PAGE_SIZE), PAGE_SIZE);
    const read = (paging: Record<string, unknown>) =>
        table(object).findMany({
            where,
            orderBy,
            take,
            select: recordSelect(object),
            ...paging
        }) as Promise<Record<string, unknown>[]>;
    const byOffset = { skip: Math.max(0, options.offset ?? 0) };
    const after = options.after ? afterCursor(orderBy, options.after) : null;
    let rows: Record<string, unknown>[];
    let total: number | null = null;
    if (after) {
        rows = await read({ where: { AND: [where, after] } });
    } else if (options.after || options.count === false) {
        rows = await read(byOffset);
    } else {
        [rows, total] = await Promise.all([read(byOffset), table(object).count({ where })]);
    }
    const last = rows[rows.length - 1];
    return {
        records: await nameLinks(
            actor,
            rows.map((row) => shown(actor, object, row)),
            custom
        ),
        total,
        next: last ? pageCursor(orderBy, last) : null,
        more: rows.length === take
    };
}

/** A row as the reader may see it: without the fields their role hides. */
export function shown(actor: CrmActor, object: CrmObject, row: Record<string, unknown>): CrmRecord {
    return hideValues(toRecord(object, row), actor.rules?.[object].hidden ?? []);
}

/** Refuse a list filtered, sorted or grouped by a field the reader may not see:
 *  the rows it returns would tell what the field holds. */
export async function requireListShown(
    actor: CrmActor,
    object: CrmObject,
    options: Pick<ListOptions, "filter" | "sorts" | "group">
): Promise<void> {
    await access.requireShown(actor, object, [
        ...filterKeys(options.filter),
        ...(options.sorts ?? []).map((sort) => sort.key),
        ...(options.group ? [options.group.key] : [])
    ]);
}

function requireGroupable(object: CrmObject, key: string, custom: readonly FieldDef[]): FieldDef {
    const field = fieldOf(object, key, custom);
    if (!field || !groupable(field)) throw new Error(`crm: ${object} cannot group by ${key}`);
    return field;
}

/** One group of a grouped list, or one column of a board: its first page. */
export interface RecordGroup extends RecordPage {
    readonly value: string;
    readonly total: number;
}

/** How many groups' pages a board reads at once. */
const GROUP_READS = 4;

/**
 * The first page of every group of a list grouped by a field - one per choice
 * of the field, in the field's order, the empty ones too, so a board draws
 * every column. The groups are counted in one query and only the ones with
 * records are read, a few at a time: a board must not take a connection per
 * column.
 */
export async function listGroups(
    actor: CrmActor,
    object: CrmObject,
    key: string,
    options: Omit<ListOptions, "group" | "offset" | "limit">
): Promise<RecordGroup[]> {
    await requireCan(actor, object, "read");
    await requireListShown(actor, object, { ...options, group: { key, value: "" } });
    const custom = await loadFields(actor.shelf, object);
    const field = requireGroupable(object, key, custom);
    // A choice somebody added may be unset, so its records get a group too.
    const values = [...(field.options ?? []), ...(field.custom ? [""] : [])];
    const column = groupColumn(object, key);
    const counted = (await table(object).groupBy({
        by: [column],
        where: {
            ...listWhere(object, actor, { ...options, custom }),
            [column]: { in: values }
        },
        _count: { _all: true }
    })) as Record<string, unknown>[];
    const totals = new Map(
        counted.map((row) => [String(row[column]), (row._count as { _all: number })._all])
    );
    const groups: RecordGroup[] = values.map((value) => ({
        value,
        records: [],
        total: 0,
        next: null,
        more: false
    }));
    const filled = groups.flatMap((group, at) => ((totals.get(group.value) ?? 0) > 0 ? [at] : []));
    for (let start = 0; start < filled.length; start += GROUP_READS) {
        await Promise.all(
            filled.slice(start, start + GROUP_READS).map(async (at) => {
                const value = groups[at]!.value;
                const page = await listRecords(actor, object, {
                    ...options,
                    custom,
                    group: { key, value },
                    count: false
                });
                groups[at] = { ...page, value, total: totals.get(value) ?? 0 };
            })
        );
    }
    return groups;
}

/**
 * Put a record in another group, or another place in its group: the field
 * takes the group's choice and the record takes the place it was dropped at.
 */
export async function moveRecord(
    actor: CrmActor,
    object: CrmObject,
    id: string,
    move: {
        readonly key: string;
        readonly value: string;
        readonly position: number;
        readonly last?: boolean;
    }
): Promise<CrmRecord> {
    await requireCan(actor, object, "edit");
    const custom = await loadFields(actor.shelf, object);
    requireGroupable(object, move.key, custom);
    await access.requireChangeable(actor, object, [move.key], async (key) => {
        const t = await crmT();
        const field = fieldOf(object, key, custom);
        return field?.label ?? t(`fields.${object}.${key}` as Parameters<typeof t>[0]);
    });
    const data = await prepare(actor, object, { [move.key]: move.value }, custom);
    const where = { id, ...recordWhere(actor, object), deletedAt: null };
    const position = move.last ? await pastLast(actor, object, id, move) : move.position;
    const before = await table(object).findFirst({ where, select: recordSelect(object) });
    const result = await table(object).updateMany({
        where,
        data: { ...data, position, updatedById: actor.user.id }
    });
    const row =
        result.count > 0
            ? await table(object).findFirst({ where, select: recordSelect(object) })
            : null;
    if (!row) {
        const t = await crmT();
        throw new CrmRefusal(t("errors.notFound"));
    }
    const [record] = (await nameLinks(
        actor,
        [toRecord(object, row as Record<string, unknown>)],
        custom
    )) as [CrmRecord];
    if (before) {
        const was = toRecord(object, before as Record<string, unknown>);
        await logEvents(actor, object, [
            { recordId: id, kind: "updated", changes: changesBetween(was, record, [move.key]) }
        ]);
    }
    return hideValues(record, actor.rules?.[object].hidden ?? []);
}

/** A place after every other card of the group, even the ones the board has
 *  not loaded yet. */
async function pastLast(
    actor: CrmActor,
    object: CrmObject,
    id: string,
    move: { readonly key: string; readonly value: string; readonly position: number }
): Promise<number> {
    const top = (await table(object).findFirst({
        where: {
            ...listWhere(object, actor.shelf, { group: { key: move.key, value: move.value } }),
            id: { not: id }
        },
        orderBy: { position: "desc" },
        select: { position: true }
    })) as { position: number } | null;
    return top ? Math.max(move.position, top.position + 1) : move.position;
}

/** One record on the reader's shelf, or null. */
export async function getRecord(
    actor: CrmActor,
    object: CrmObject,
    id: string
): Promise<CrmRecord | null> {
    await requireCan(actor, object, "read");
    const row = await table(object).findFirst({
        where: { id, ...recordWhere(actor, object) },
        select: recordSelect(object)
    });
    if (!row) return null;
    const [record] = await nameLinks(
        actor,
        [shown(actor, object, row as Record<string, unknown>)],
        await loadFields(actor.shelf, object)
    );
    return record!;
}

/**
 * Records of a kind, named, for a picker: the ones whose name matches, the
 * most recently changed first. Never the trash.
 */
export async function searchRefs(
    actor: CrmActor,
    object: CrmObject,
    search: string,
    limit = 20
): Promise<Ref[]> {
    await requireCan(actor, object, "read");
    const rows = (await table(object).findMany({
        where: {
            AND: [
                { ...recordWhere(actor, object), deletedAt: null },
                searchWhere(object, search, actor.rules?.[object].hidden ?? [])
            ]
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: Math.min(limit, 50),
        select: recordSelect(object)
    })) as Record<string, unknown>[];
    return rows.map((row) => {
        const record = toRecord(object, row);
        return { id: record.id, name: recordName(object, record) };
    });
}

/** The people who may own a record on the reader's shelf. */
export async function shelfPeople(actor: CrmActor): Promise<Ref[]> {
    if (!actor.shelf.orgId) return [{ id: actor.user.id, name: actor.user.name }];
    const people = await host.crmHost.crmOrgPeople(
        { id: actor.user.id, isAdmin: actor.user.isAdmin },
        actor.shelf.orgId
    );
    return people.map((person) => ({ id: person.id, name: person.name }));
}

/** A value refused, as the sentence to show, naming the field. */
async function refuseValue(object: CrmObject, field: FieldDef, reason: string): Promise<never> {
    const t = await crmT();
    throw new CrmRefusal(
        t("errors.invalidValue", {
            field: field.label ?? t(`fields.${object}.${field.key}` as Parameters<typeof t>[0]),
            reason: t(`invalid.${reason}` as Parameters<typeof t>[0])
        })
    );
}

/**
 * A set of field values made ready to store: each normalized, each reference
 * checked to point at something on this shelf (a company in the trash or on
 * another shelf is not one), each owner checked to be somebody on it.
 */
async function prepare(
    actor: CrmActor,
    object: CrmObject,
    values: Readonly<Record<string, unknown>>,
    custom: readonly FieldDef[]
): Promise<Record<string, unknown>> {
    await access.requireChangeable(actor, object, Object.keys(values), async (key) => {
        const t = await crmT();
        const field = fieldOf(object, key, custom);
        return field?.label ?? t(`fields.${object}.${key}` as Parameters<typeof t>[0]);
    });
    const data: Record<string, unknown> = {};
    let people: Ref[] | null = null;
    for (const [key, raw] of Object.entries(values)) {
        const field = writable(object, key, custom);
        if (!field) {
            const t = await crmT();
            throw new CrmRefusal(t("errors.unknownField"));
        }
        const normalized = normalizeInput(field, raw);
        if (!normalized.ok) await refuseValue(object, field, normalized.reason);
        const value = (normalized as { value: InputValue }).value;
        if (isLinkList(field) && (value as readonly string[]).length > 0) {
            const ids = value as readonly string[];
            await requireCan(actor, field.target!, "read");
            const found = await table(field.target!).count({
                where: {
                    id: { in: [...ids] },
                    ...recordWhere(actor, field.target!),
                    deletedAt: null
                }
            });
            if (found !== ids.length) await refuseValue(object, field, "missing");
        } else if (value !== null && field.kind === "relation" && !isLinkList(field)) {
            await requireCan(actor, field.target!, "read");
            const found = await table(field.target!).count({
                where: {
                    id: value as string,
                    ...recordWhere(actor, field.target!),
                    deletedAt: null
                }
            });
            if (found === 0) await refuseValue(object, field, "missing");
        }
        if (value !== null && field.kind === "member") {
            people ??= await shelfPeople(actor);
            if (!people.some((person) => person.id === value)) {
                await refuseValue(object, field, "notOnShelf");
            }
        }
        Object.assign(data, writeData(object, field, value));
    }
    return data;
}

/** Make a record. Its name is required; everything else may come later. */
export async function createRecord(
    actor: CrmActor,
    object: CrmObject,
    values: Readonly<Record<string, unknown>>
): Promise<CrmRecord> {
    await requireCan(actor, object, "edit");
    const primary = primaryField(object);
    if (!(primary.key in values)) await refuseValue(object, primary, "required");
    const custom = await loadFields(actor.shelf, object);
    const data = await prepare(actor, object, values, custom);
    // New rows go to the top of a board column: below everything by position.
    const first = (await table(object).findFirst({
        where: shelfWhere(actor.shelf),
        orderBy: { position: "asc" },
        select: { position: true }
    })) as { position: number } | null;
    const row = await table(object).create({
        data: {
            ...data,
            ...shelfData(actor.shelf),
            createdById: actor.user.id,
            position: (first?.position ?? 1) - 1
        },
        select: recordSelect(object)
    });
    const [record] = (await nameLinks(
        actor,
        [toRecord(object, row as Record<string, unknown>)],
        custom
    )) as [CrmRecord];
    await logEvents(actor, object, [
        {
            recordId: record.id,
            kind: "created",
            changes: initialValues(record, Object.keys(values))
        }
    ]);
    return hideValues(record, actor.rules?.[object].hidden ?? []);
}

/** Change fields of one record. */
export async function updateRecord(
    actor: CrmActor,
    object: CrmObject,
    id: string,
    values: Readonly<Record<string, unknown>>
): Promise<CrmRecord> {
    const [record] = await updateRecords(actor, object, [id], values);
    if (!record) {
        const t = await crmT();
        throw new CrmRefusal(t("errors.notFound"));
    }
    return record;
}

/**
 * Give several records the same values - a bulk edit. Records that are not on
 * the shelf, or are in the trash, are left alone and not returned.
 */
export async function updateRecords(
    actor: CrmActor,
    object: CrmObject,
    ids: readonly string[],
    values: Readonly<Record<string, unknown>>
): Promise<CrmRecord[]> {
    await requireCan(actor, object, "edit");
    if (ids.length === 0) return [];
    const custom = await loadFields(actor.shelf, object);
    const data = await prepare(actor, object, values, custom);
    const where = { id: { in: [...new Set(ids)] }, ...recordWhere(actor, object), deletedAt: null };
    const before = (await table(object).findMany({
        where,
        select: recordSelect(object)
    })) as Record<string, unknown>[];
    const groups = await keepUnseenLinks(actor, before, custom, data);
    if (groups === null) {
        await table(object).updateMany({ where, data: { ...data, updatedById: actor.user.id } });
    } else {
        for (const group of groups) {
            await table(object).updateMany({
                where: { ...where, id: { in: group.ids } },
                data: { ...group.data, updatedById: actor.user.id }
            });
        }
    }
    const rows = (await table(object).findMany({ where, select: recordSelect(object) })) as Record<
        string,
        unknown
    >[];
    const named = await nameLinks(
        actor,
        [...rows, ...before].map((row) => toRecord(object, row)),
        custom
    );
    const saved = named.slice(0, rows.length);
    const was = new Map(named.slice(rows.length).map((record) => [record.id, record]));
    const keys = Object.keys(values);
    await logEvents(
        actor,
        object,
        saved.flatMap((record) => {
            const old = was.get(record.id);
            return old
                ? [
                      {
                          recordId: record.id,
                          kind: "updated" as const,
                          changes: changesBetween(old, record, keys)
                      }
                  ]
                : [];
        })
    );
    return saved.map((record) => hideValues(record, actor.rules?.[object].hidden ?? []));
}

/** Move records to the trash. Returns how many moved. */
export async function trashRecords(
    actor: CrmActor,
    object: CrmObject,
    ids: readonly string[]
): Promise<number> {
    await requireCan(actor, object, "delete");
    if (ids.length === 0) return 0;
    const where = { id: { in: [...new Set(ids)] }, ...recordWhere(actor, object), deletedAt: null };
    const found = (await table(object).findMany({ where, select: { id: true } })) as {
        id: string;
    }[];
    if (found.length === 0) return 0;
    const result = await table(object).updateMany({
        where: { ...where, id: { in: found.map((row) => row.id) } },
        data: { deletedAt: new Date() }
    });
    await logEvents(
        actor,
        object,
        found.map((row) => ({ recordId: row.id, kind: "trashed" as const }))
    );
    return result.count as number;
}

/** Take records out of the trash. Returns how many came back. */
export async function restoreRecords(
    actor: CrmActor,
    object: CrmObject,
    ids: readonly string[]
): Promise<number> {
    await requireCan(actor, object, "delete");
    if (ids.length === 0) return 0;
    const where = {
        id: { in: [...new Set(ids)] },
        ...recordWhere(actor, object),
        deletedAt: { not: null }
    };
    const found = (await table(object).findMany({ where, select: { id: true } })) as {
        id: string;
    }[];
    if (found.length === 0) return 0;
    const result = await table(object).updateMany({
        where: { ...where, id: { in: found.map((row) => row.id) } },
        data: { deletedAt: null }
    });
    await logEvents(
        actor,
        object,
        found.map((row) => ({ recordId: row.id, kind: "restored" as const }))
    );
    return result.count as number;
}

/**
 * Delete records for good - only ones already in the trash, so nothing leaves
 * a list without passing through it first. Every record that pointed at them -
 * a person at their company, a deal at its contact - is cleared in the same
 * transaction and keeps a line on its timeline saying so; their own timeline
 * and their links to notes, tasks and files go with them (the notes, tasks and
 * files themselves stay). Returns how many went.
 */
export async function destroyRecords(
    actor: CrmActor,
    object: CrmObject,
    ids: readonly string[]
): Promise<number> {
    await requireCan(actor, object, "delete");
    if (ids.length === 0) return 0;
    const where = {
        id: { in: [...new Set(ids)] },
        ...recordWhere(actor, object),
        deletedAt: { not: null }
    };
    const cleared: { object: CrmObject; events: NewEvent[] }[] = [];
    const destroyed: string[] = [];
    const count = await prisma.$transaction(async (tx) => {
        const found = (await table(object, tx).findMany({
            where,
            select: recordSelect(object)
        })) as Record<string, unknown>[];
        if (found.length === 0) return 0;
        const doomed = found.map((row) => toRecord(object, row));
        const gone = doomed.map((record) => record.id);
        destroyed.push(...gone);
        const names = new Map(doomed.map((record) => [record.id, recordName(object, record)]));
        for (const list of relatedLists(object)) {
            const pointing = { ...shelfWhere(actor.shelf), [list.column]: { in: gone } };
            const rows = (await table(list.object, tx).findMany({
                where: pointing,
                select: { id: true, [list.column]: true }
            })) as Record<string, string>[];
            if (rows.length === 0) continue;
            await table(list.object, tx).updateMany({
                where: { ...pointing, id: { in: rows.map((row) => row.id) } },
                data: { [list.column]: null }
            });
            const target = rows.map((row) => row[list.column]!);
            cleared.push({
                object: list.object,
                events: rows.map((row, at) => ({
                    recordId: row.id!,
                    kind: "updated" as const,
                    changes: [
                        {
                            key: list.field,
                            before: { id: target[at]!, name: names.get(target[at]!) ?? "" },
                            after: null
                        }
                    ]
                }))
            });
        }
        const result = await table(object, tx).deleteMany({
            where: { ...where, id: { in: gone } }
        });
        // A relation somebody added holds ids, not a foreign key: take them out.
        const lists = await unlinkRecords(tx, actor, gone);
        // The links that stay are named the way any list is; the ones that
        // went by the names read above.
        const kept = new Map<string, string>();
        for (const other of new Set(lists.map((list) => list.object))) {
            const custom = await loadFields(actor.shelf, other);
            const named = await nameLinks(
                actor,
                lists
                    .filter((list) => list.object === other)
                    .map((list) => ({
                        id: list.recordId,
                        position: 0,
                        deletedAt: null,
                        values: { [list.slot]: list.after.map((id) => ({ id, name: "" })) }
                    })),
                custom
            );
            for (const record of named)
                for (const value of Object.values(record.values))
                    for (const ref of linksOf(value)) kept.set(ref.id, ref.name);
        }
        for (const list of lists) {
            const named = (ids: readonly string[]) =>
                ids.map((id) => ({ id, name: names.get(id) ?? kept.get(id) ?? "" }));
            cleared.push({
                object: list.object,
                events: [
                    {
                        recordId: list.recordId,
                        kind: "updated" as const,
                        changes: [
                            { key: list.slot, before: named(list.before), after: named(list.after) }
                        ]
                    }
                ]
            });
        }
        await dropEvents(actor, gone, tx);
        await tx.crmLink.deleteMany({
            where: { ...shelfWhere(actor.shelf), recordId: { in: gone } }
        });
        // Anybody's pin of it goes with it.
        await tx.crmFavorite.deleteMany({ where: { kind: "record", targetId: { in: gone } } });
        return result.count as number;
    });
    for (const one of cleared) await logEvents(actor, one.object, one.events);
    // Nobody keeps reading a record that no longer exists.
    for (const id of destroyed)
        await host.accessGrants.dropGrantsFor("crm.record", `${object}:${id}`);
    return count;
}

/**
 * Records of every kind the account may see, named, for search: each kind's
 * matches, the most recently changed first, taken in turn so one kind cannot
 * crowd out the others. Nothing for an account that may not use the CRM.
 */
export async function searchAllRecords(
    userId: string,
    search: string,
    limit: number
): Promise<{ id: string; label: string; detail: string; href: string }[]> {
    const user = await host.crmHost.crmRunner(userId);
    if (!user) return [];
    const actor = await crmActor(user);
    const t = await crmT();
    const kinds = CRM_OBJECTS.filter((object) => actor.can[object].read);
    const found = await Promise.all(
        kinds.map(async (object) =>
            (await searchRefs(actor, object, search, limit)).map((ref) => ({
                id: ref.id,
                label: ref.name,
                detail: actor.shelf.orgName
                    ? `${t(`objects.${object}.plural`)} - ${actor.shelf.orgName}`
                    : t(`objects.${object}.plural`),
                href: recordHref(object, ref.id)
            }))
        )
    );
    const hits = [];
    for (let at = 0; hits.length < limit && found.some((list) => at < list.length); at++) {
        for (const list of found) if (at < list.length) hits.push(list[at]!);
    }
    return hits.slice(0, limit);
}
