"use server";

/**
 * Records: list a page, total the columns, make, change, bulk-change and trash
 * them, find one to point a reference at. Every input is checked against a
 * schema here; what each field may hold is checked again, per field, below.
 */

import { z } from "zod";
import * as views from "../lib/views";
import * as totals from "../lib/totals";
import * as records from "../lib/records";
import { MAX_SEARCH } from "../lib/query";
import type { Abilities } from "../lib/access";
import { requireCrmActor } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { CRM_OBJECTS, type CrmRecord, type Ref } from "../model/objects";
import { filterSchema, readFilter } from "../model/filters";
import {
    AGGREGATES,
    MAX_SORTS,
    VIEW_KINDS,
    VIEW_NAME_MAX,
    viewConfigSchema,
    type ViewSummary
} from "../model/views";

const object = z.enum(CRM_OBJECTS);
const id = z.string().uuid();
const search = z.string().max(MAX_SEARCH).default("");
const sorts = z
    .array(z.object({ key: z.string().min(1).max(64), direction: z.enum(["asc", "desc"]) }))
    .max(MAX_SORTS)
    .default([]);
const fieldKey = z.string().min(1).max(64);
/** The view's filter as sent; what each rule may hold is read per field by
 *  `readFilter` before it reaches a query. */
const filter = filterSchema.optional();
const group = z.object({ key: fieldKey, value: z.string().max(64) });
const viewName = z.string().max(VIEW_NAME_MAX * 2);
const viewKind = z.enum(VIEW_KINDS);

/** Field values as typed: checked per field by `normalizeInput` on the way in. */
const values = z
    .record(z.string().max(64), z.unknown())
    .refine((entry) => Object.keys(entry).length <= 64);

export interface ListOpening {
    /** The default view; null for a reader who may not see this kind of record
     *  here. */
    readonly view: ViewSummary | null;
    /** Every view of this kind of record, the default first; empty for a
     *  reader who may not see it. */
    readonly views: ViewSummary[];
    readonly can: Abilities;
    /** Who may own a record here. */
    readonly people: Ref[];
    /** The organization whose CRM this is, or null for the reader's own. */
    readonly shelfName: string | null;
}

/** Everything a list needs before its rows: its view, what the reader may do,
 *  and who may own a record. */
export async function openListAction(input: unknown): Promise<Outcome<ListOpening>> {
    const parsed = z.object({ object }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const actor = await requireCrmActor();
        // Not a refusal: the screen says in its own words that this list is
        // not theirs to see, and still offers the others.
        if (!actor.can[parsed.data.object].read) {
            return {
                view: null,
                views: [],
                can: actor.can,
                people: [],
                shelfName: actor.shelf.orgName
            };
        }
        const [all, people] = await Promise.all([
            views.listViews(actor, parsed.data.object),
            records.shelfPeople(actor)
        ]);
        return {
            view: all[0] ?? null,
            views: all,
            can: actor.can,
            people,
            shelfName: actor.shelf.orgName
        };
    });
}

/** One page of a list. */
export async function listRecordsAction(input: unknown): Promise<Outcome<records.RecordPage>> {
    const parsed = z
        .object({
            object,
            search,
            sorts,
            filter,
            group: group.optional(),
            byPosition: z.boolean().default(false),
            deleted: z.boolean().default(false),
            offset: z.number().int().min(0).max(1_000_000).default(0)
        })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, filter: sent, ...options } = parsed.data;
    return outcome(async () =>
        records.listRecords(await requireCrmActor(), kind, {
            ...options,
            filter: readFilter(kind, sent)
        })
    );
}

/** The first page of every group of a grouped list or a board. */
export async function listGroupsAction(
    input: unknown
): Promise<Outcome<{ groups: records.RecordGroup[] }>> {
    const parsed = z
        .object({
            object,
            key: fieldKey,
            search,
            sorts,
            filter,
            byPosition: z.boolean().default(false)
        })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, key, filter: sent, ...options } = parsed.data;
    return outcome(async () => ({
        groups: await records.listGroups(await requireCrmActor(), kind, key, {
            ...options,
            filter: readFilter(kind, sent)
        })
    }));
}

/** The totals under a list's columns. */
export async function totalsAction(input: unknown): Promise<Outcome<{ totals: totals.Total[] }>> {
    const parsed = z
        .object({
            object,
            search,
            filter,
            deleted: z.boolean().default(false),
            asked: z
                .array(z.object({ key: z.string().min(1).max(64), aggregate: z.enum(AGGREGATES) }))
                .max(64)
        })
        .safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        totals: await totals.computeTotals(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.asked,
            { ...parsed.data, filter: readFilter(parsed.data.object, parsed.data.filter) }
        )
    }));
}

export async function createRecordAction(input: unknown): Promise<Outcome<{ record: CrmRecord }>> {
    const parsed = z.object({ object, values }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        record: await records.createRecord(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.values
        )
    }));
}

export async function updateRecordAction(input: unknown): Promise<Outcome<{ record: CrmRecord }>> {
    const parsed = z.object({ object, id, values }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        record: await records.updateRecord(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.id,
            parsed.data.values
        )
    }));
}

const ids = z.array(id).min(1).max(records.MAX_BULK);

/** The same values on several records. */
export async function updateRecordsAction(
    input: unknown
): Promise<Outcome<{ records: CrmRecord[] }>> {
    const parsed = z.object({ object, ids, values }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        records: await records.updateRecords(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.ids,
            parsed.data.values
        )
    }));
}

/** Drop a card in another column of a board, or another place in its own. */
export async function moveRecordAction(input: unknown): Promise<Outcome<{ record: CrmRecord }>> {
    const parsed = z
        .object({
            object,
            id,
            key: fieldKey,
            value: z.string().max(64),
            position: z.number().finite().min(-1e15).max(1e15),
            last: z.boolean().optional()
        })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, id: recordId, ...move } = parsed.data;
    return outcome(async () => ({
        record: await records.moveRecord(await requireCrmActor(), kind, recordId, move)
    }));
}

/** Move records to the trash. */
export async function trashRecordsAction(input: unknown): Promise<Outcome<{ count: number }>> {
    const parsed = z.object({ object, ids }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        count: await records.trashRecords(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.ids
        )
    }));
}

/** Records to point a reference at, by name. */
export async function searchRefsAction(input: unknown): Promise<Outcome<{ refs: Ref[] }>> {
    const parsed = z.object({ object, search }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        refs: await records.searchRefs(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.search
        )
    }));
}

/** Store how a view is drawn: its columns, totals, sorts, filter, grouping,
 *  and whether it is a table or a board. */
export async function saveViewAction(input: unknown): Promise<Outcome<{ view: ViewSummary }>> {
    const parsed = z
        .object({ object, viewId: id, config: viewConfigSchema, kind: viewKind.optional() })
        .safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        view: await views.saveViewConfig(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.viewId,
            parsed.data.config,
            parsed.data.kind
        )
    }));
}

/** A new named view, drawn the way the list is drawn now. */
export async function createViewAction(input: unknown): Promise<Outcome<{ view: ViewSummary }>> {
    const parsed = z
        .object({ object, name: viewName, kind: viewKind, config: viewConfigSchema })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, ...view } = parsed.data;
    return outcome(async () => ({
        view: await views.createView(await requireCrmActor(), kind, view)
    }));
}

export async function renameViewAction(input: unknown): Promise<Outcome<{ view: ViewSummary }>> {
    const parsed = z.object({ object, viewId: id, name: viewName }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        view: await views.renameView(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.viewId,
            parsed.data.name
        )
    }));
}

export async function deleteViewAction(input: unknown): Promise<Outcome<{ deleted: true }>> {
    const parsed = z.object({ object, viewId: id }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        await views.deleteView(await requireCrmActor(), parsed.data.object, parsed.data.viewId);
        return { deleted: true as const };
    });
}
