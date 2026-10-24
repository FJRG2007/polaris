"use server";

/**
 * Records: list a page, total the columns, make, change, bulk-change and trash
 * them, find one to point a reference at. Every input is checked against a
 * schema here; what each field may hold is checked again, per field, below.
 */

import { z } from "zod";
import * as views from "../lib/views";
import * as fields from "../lib/fields";
import * as totals from "../lib/totals";
import * as records from "../lib/records";
import * as exporter from "../lib/export";
import * as importer from "../lib/import";
import * as page from "../lib/record-page";
import * as timeline from "../lib/timeline";
import * as favorites from "../lib/favorites";
import * as duplicates from "../lib/duplicates";
import * as merging from "../lib/merge";
import type { TimelinePage } from "../model/timeline";
import { MAX_SEARCH } from "../lib/query";
import type { Abilities, CrmActor } from "../lib/access";
import type { ObjectRule } from "../model/roles";
import { requireCrmActor } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { CRM_OBJECTS, type CrmObject, type CrmRecord, type Ref } from "../model/objects";
import { DUPLICATE_FIELDS, type Duplicate } from "../model/duplicates";
import { filterSchema } from "../model/filters";
import { IMPORT_BATCH, MAX_IMPORT_CELL, MAX_IMPORT_COLUMNS } from "../model/import";
import { choiceRenamesSchema, fieldInputSchema, type CustomField } from "../model/fields";
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
    /** The fields added to this kind of record here. */
    readonly fields: CustomField[];
    /** The views the reader pinned to the rail. */
    readonly favoriteViews?: string[];
    /** What the reader's role is held to for this kind of record. */
    readonly rule?: ObjectRule;
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
                shelfName: actor.shelf.orgName,
                fields: []
            };
        }
        const [all, people, added] = await Promise.all([
            views.listViews(actor, parsed.data.object),
            records.shelfPeople(actor),
            fields.listFields(actor.shelf, parsed.data.object)
        ]);
        return {
            view: all[0] ?? null,
            views: all,
            can: actor.can,
            people,
            shelfName: actor.shelf.orgName,
            fields: added,
            rule: actor.rules?.[parsed.data.object],
            favoriteViews: await favorites.pinnedAmong(
                actor,
                "view",
                all.map((one) => one.id)
            )
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
            offset: z.number().int().min(0).max(1_000_000).default(0),
            after: z.string().max(4096).optional()
        })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, filter: sent, ...options } = parsed.data;
    return outcome(async () =>
        records.listRecords(await requireCrmActor(), kind, {
            ...options,
            filter: sent
        })
    );
}

/** One record's page: the record, its fields and the records that point at it. */
export async function openRecordAction(input: unknown): Promise<Outcome<page.RecordOpening>> {
    const parsed = z.object({ object, id }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const actor = await requireCrmActor();
        // A kind the reader may not read on their shelf is only ever a share.
        if (!actor.can[parsed.data.object].read) {
            const shared = await page.openSharedRecord(
                actor.user,
                parsed.data.object,
                parsed.data.id
            );
            if (shared) return shared;
        }
        const opening = await page.openRecord(actor, parsed.data.object, parsed.data.id);
        if (opening.record) return opening;
        // Not on the reader's shelf: it may be somebody else's, shared with them.
        return (
            (await page.openSharedRecord(actor.user, parsed.data.object, parsed.data.id)) ?? opening
        );
    });
}

/** An older page of what happened to a record. */
export async function recordTimelineAction(input: unknown): Promise<Outcome<TimelinePage>> {
    const parsed = z.object({ object, id, before: id }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const actor = await requireCrmActor();
        return timeline.listTimeline(
            actor,
            parsed.data.object,
            parsed.data.id,
            await records.shelfPeople(actor),
            parsed.data.before
        );
    });
}

/** The rows a view shows, in its columns, as a CSV file. */
export async function exportRecordsAction(input: unknown): Promise<Outcome<exporter.CsvExport>> {
    const parsed = z
        .object({
            object,
            search,
            sorts,
            filter,
            deleted: z.boolean().default(false),
            columns: z.array(fieldKey).max(128).default([])
        })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, ...options } = parsed.data;
    return outcome(async () => exporter.exportRecords(await requireCrmActor(), kind, options));
}

/** One batch of a CSV import: the field each column goes to, and the rows. */
export async function importRecordsAction(input: unknown): Promise<Outcome<importer.ImportResult>> {
    const parsed = z
        .object({
            object,
            mapping: z.array(fieldKey.nullable()).min(1).max(MAX_IMPORT_COLUMNS),
            rows: z
                .array(z.array(z.string().max(MAX_IMPORT_CELL * 2)).max(MAX_IMPORT_COLUMNS))
                .min(1)
                .max(IMPORT_BATCH),
            skipDuplicates: z.boolean().default(false)
        })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, ...batch } = parsed.data;
    return outcome(async () => importer.importRecords(await requireCrmActor(), kind, batch));
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
            filter: sent
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
            parsed.data
        )
    }));
}

/** The records a saved one looks like, when the values sent could make it one. */
async function lookalikes(
    actor: CrmActor,
    object: CrmObject,
    sent: Readonly<Record<string, unknown>>,
    record: CrmRecord
): Promise<Duplicate[]> {
    if (!DUPLICATE_FIELDS[object].some((key) => key in sent)) return [];
    const [found] = await duplicates.findDuplicates(actor, object, [record.values], [record.id]);
    return found ?? [];
}

export async function createRecordAction(
    input: unknown
): Promise<Outcome<{ record: CrmRecord; duplicates: Duplicate[] }>> {
    const parsed = z.object({ object, values }).safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, values: sent } = parsed.data;
    return outcome(async () => {
        const actor = await requireCrmActor();
        const record = await records.createRecord(actor, kind, sent);
        return { record, duplicates: await lookalikes(actor, kind, sent, record) };
    });
}

export async function updateRecordAction(
    input: unknown
): Promise<Outcome<{ record: CrmRecord; duplicates: Duplicate[] }>> {
    const parsed = z.object({ object, id, values }).safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, id: recordId, values: sent } = parsed.data;
    return outcome(async () => {
        const actor = await requireCrmActor();
        const record = await records.updateRecord(actor, kind, recordId, sent);
        return { record, duplicates: await lookalikes(actor, kind, sent, record) };
    });
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

/** Take records out of the trash. */
export async function restoreRecordsAction(input: unknown): Promise<Outcome<{ count: number }>> {
    const parsed = z.object({ object, ids }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        count: await records.restoreRecords(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.ids
        )
    }));
}

/** Delete records in the trash for good. */
export async function destroyRecordsAction(input: unknown): Promise<Outcome<{ count: number }>> {
    const parsed = z.object({ object, ids }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        count: await records.destroyRecords(
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

/** Add a field to a kind of record. */
export async function createFieldAction(input: unknown): Promise<Outcome<{ field: CustomField }>> {
    const parsed = z.object({ object, field: fieldInputSchema }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        field: await fields.createField(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.field
        )
    }));
}

/** Rename a field, or change a select's choices, carrying records over to
 *  the choices given new wording. */
export async function updateFieldAction(input: unknown): Promise<Outcome<{ field: CustomField }>> {
    const parsed = z
        .object({ object, fieldId: id, field: fieldInputSchema, renames: choiceRenamesSchema })
        .safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        field: await fields.updateField(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.fieldId,
            parsed.data.field,
            parsed.data.renames
        )
    }));
}

/** Remove a field and what the records held in it. */
export async function deleteFieldAction(input: unknown): Promise<Outcome<{ deleted: true }>> {
    const parsed = z.object({ object, fieldId: id }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        await fields.deleteField(await requireCrmActor(), parsed.data.object, parsed.data.fieldId);
        return { deleted: true as const };
    });
}

/** Merge duplicates into the record kept; the others go to the trash. */
export async function mergeRecordsAction(input: unknown): Promise<Outcome<{ record: CrmRecord }>> {
    const parsed = z
        .object({ object, keepId: id, ids: z.array(id).min(1).max(merging.MAX_MERGE) })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, keepId, ids: merged } = parsed.data;
    return outcome(async () => ({
        record: await merging.mergeRecords(await requireCrmActor(), kind, keepId, merged)
    }));
}
