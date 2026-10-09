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
import { AGGREGATES, MAX_SORTS, viewConfigSchema, type ViewSummary } from "../model/views";

const object = z.enum(CRM_OBJECTS);
const id = z.string().uuid();
const search = z.string().max(MAX_SEARCH).default("");
const sorts = z
    .array(z.object({ key: z.string().min(1).max(64), direction: z.enum(["asc", "desc"]) }))
    .max(MAX_SORTS)
    .default([]);
/** Field values as typed: checked per field by `normalizeInput` on the way in. */
const values = z
    .record(z.string().max(64), z.unknown())
    .refine((entry) => Object.keys(entry).length <= 64);

export interface ListOpening {
    /** Null for a reader who may not see this kind of record here. */
    readonly view: ViewSummary | null;
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
            return { view: null, can: actor.can, people: [], shelfName: actor.shelf.orgName };
        }
        const [view, people] = await Promise.all([
            views.defaultView(actor, parsed.data.object),
            records.shelfPeople(actor)
        ]);
        return { view, can: actor.can, people, shelfName: actor.shelf.orgName };
    });
}

/** One page of a list. */
export async function listRecordsAction(input: unknown): Promise<Outcome<records.RecordPage>> {
    const parsed = z
        .object({
            object,
            search,
            sorts,
            deleted: z.boolean().default(false),
            offset: z.number().int().min(0).max(1_000_000).default(0)
        })
        .safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () =>
        records.listRecords(await requireCrmActor(), parsed.data.object, parsed.data)
    );
}

/** The totals under a list's columns. */
export async function totalsAction(input: unknown): Promise<Outcome<{ totals: totals.Total[] }>> {
    const parsed = z
        .object({
            object,
            search,
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

/** Store a view's columns, totals and sorts. */
export async function saveViewAction(input: unknown): Promise<Outcome<{ view: ViewSummary }>> {
    const parsed = z.object({ object, viewId: id, config: viewConfigSchema }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        view: await views.saveViewConfig(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.viewId,
            parsed.data.config
        )
    }));
}
