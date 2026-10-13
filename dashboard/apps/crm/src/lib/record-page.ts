/**
 * One record's page: the record, what the reader may do with it, and the
 * records that point at it - a company's people and deals, a person's deals.
 *
 * Server-only.
 */

import { pinnedAmong } from "./favorites";
import { loadFields } from "./fields";
import { listTimeline } from "./timeline";
import type { TimelinePage } from "../model/timeline";
import { getRecord, shelfPeople } from "./records";
import { recordSelect, table, toRecord } from "./columns";
import { relatedLists, type RelatedList } from "../model/related";
import { shelfWhere, type Abilities, type CrmActor } from "./access";
import {
    recordName,
    type CrmObject,
    type CrmRecord,
    type FieldDef,
    type Ref
} from "../model/objects";

/** The most records one related list shows; the rest are counted. */
export const RELATED_LIMIT = 20;

export interface RelatedRecords extends RelatedList {
    readonly records: Ref[];
    readonly total: number;
}

export interface RecordOpening {
    /** Null when it does not exist on this shelf. */
    readonly record: CrmRecord | null;
    readonly fields: FieldDef[];
    readonly can: Abilities;
    readonly people: Ref[];
    readonly related: RelatedRecords[];
    /** The newest page of what happened to the record. */
    readonly timeline: TimelinePage;
    /** Whether the reader pinned it to the rail. */
    readonly favorite: boolean;
}

export async function openRecord(
    actor: CrmActor,
    object: CrmObject,
    id: string
): Promise<RecordOpening> {
    const [record, fields, people] = await Promise.all([
        getRecord(actor, object, id),
        loadFields(actor.shelf, object),
        shelfPeople(actor)
    ]);
    const lists = record ? relatedLists(object).filter((list) => actor.can[list.object].read) : [];
    const timeline: Promise<TimelinePage> = record
        ? listTimeline(actor, object, id, people)
        : Promise.resolve({ events: [], next: null });
    const pinned = record ? pinnedAmong(actor, "record", [id]) : Promise.resolve([]);
    const related = await Promise.all(
        lists.map(async (list): Promise<RelatedRecords> => {
            const where = { ...shelfWhere(actor.shelf), deletedAt: null, [list.column]: id };
            const [rows, total] = await Promise.all([
                table(list.object).findMany({
                    where,
                    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                    take: RELATED_LIMIT,
                    select: recordSelect(list.object)
                }),
                table(list.object).count({ where })
            ]);
            return {
                ...list,
                total,
                records: (rows as Record<string, unknown>[]).map((row) => {
                    const one = toRecord(list.object, row);
                    return { id: one.id, name: recordName(list.object, one) };
                })
            };
        })
    );
    return {
        record,
        fields: [...fields],
        can: actor.can,
        people,
        related,
        timeline: await timeline,
        favorite: (await pinned).length > 0
    };
}
