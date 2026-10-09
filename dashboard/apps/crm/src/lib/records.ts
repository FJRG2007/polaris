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
import { host } from "@polaris/app-host";
import { listOrder, listWhere, searchWhere } from "./query";
import { normalizeInput, type InputValue } from "../model/values";
import { requireCan, shelfData, shelfWhere, type CrmActor } from "./access";
import { recordSelect, table, toRecord, writable, writeData } from "./columns";
import {
    primaryField,
    recordName,
    type CrmObject,
    type CrmRecord,
    type FieldDef,
    type Ref
} from "../model/objects";
import type { ViewSort } from "../model/views";

/** The most rows one page of a list returns. */
export const PAGE_SIZE = 50;

/** The most records one bulk change touches. */
export const MAX_BULK = 500;

export interface RecordPage {
    readonly records: CrmRecord[];
    /** How many rows match, across every page. */
    readonly total: number;
}

/** One page of a list. */
export async function listRecords(
    actor: CrmActor,
    object: CrmObject,
    options: {
        readonly search?: string;
        readonly sorts?: readonly ViewSort[];
        readonly deleted?: boolean;
        readonly offset?: number;
        readonly limit?: number;
    }
): Promise<RecordPage> {
    await requireCan(actor, object, "read");
    const where = listWhere(object, actor.shelf, options);
    const [rows, total] = await Promise.all([
        table(object).findMany({
            where,
            orderBy: listOrder(object, options.sorts ?? []),
            skip: Math.max(0, options.offset ?? 0),
            take: Math.min(Math.max(1, options.limit ?? PAGE_SIZE), PAGE_SIZE),
            select: recordSelect(object)
        }),
        table(object).count({ where })
    ]);
    return {
        records: (rows as Record<string, unknown>[]).map((row) => toRecord(object, row)),
        total
    };
}

/** One record on the reader's shelf, or null. */
export async function getRecord(
    actor: CrmActor,
    object: CrmObject,
    id: string
): Promise<CrmRecord | null> {
    await requireCan(actor, object, "read");
    const row = await table(object).findFirst({
        where: { id, ...shelfWhere(actor.shelf) },
        select: recordSelect(object)
    });
    return row ? toRecord(object, row as Record<string, unknown>) : null;
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
        where: { ...shelfWhere(actor.shelf), deletedAt: null, ...searchWhere(object, search) },
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
            field: t(`fields.${object}.${field.key}` as Parameters<typeof t>[0]),
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
    values: Readonly<Record<string, unknown>>
): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};
    let people: Ref[] | null = null;
    for (const [key, raw] of Object.entries(values)) {
        const field = writable(object, key);
        if (!field) {
            const t = await crmT();
            throw new CrmRefusal(t("errors.unknownField"));
        }
        const normalized = normalizeInput(field, raw);
        if (!normalized.ok) await refuseValue(object, field, normalized.reason);
        const value = (normalized as { value: InputValue }).value;
        if (value !== null && field.kind === "relation") {
            await requireCan(actor, field.target!, "read");
            const found = await table(field.target!).count({
                where: { id: value as string, ...shelfWhere(actor.shelf), deletedAt: null }
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
    const data = await prepare(actor, object, values);
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
    return toRecord(object, row as Record<string, unknown>);
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
    const data = await prepare(actor, object, values);
    const where = { id: { in: [...new Set(ids)] }, ...shelfWhere(actor.shelf), deletedAt: null };
    await table(object).updateMany({ where, data });
    const rows = (await table(object).findMany({ where, select: recordSelect(object) })) as Record<
        string,
        unknown
    >[];
    return rows.map((row) => toRecord(object, row));
}

/** Move records to the trash. Returns how many moved. */
export async function trashRecords(
    actor: CrmActor,
    object: CrmObject,
    ids: readonly string[]
): Promise<number> {
    await requireCan(actor, object, "delete");
    if (ids.length === 0) return 0;
    const result = await table(object).updateMany({
        where: { id: { in: [...new Set(ids)] }, ...shelfWhere(actor.shelf), deletedAt: null },
        data: { deletedAt: new Date() }
    });
    return result.count as number;
}
