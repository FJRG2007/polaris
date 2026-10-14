/**
 * One record's page: the record, what the reader may do with it, and the
 * records that point at it - a company's people and deals, a person's deals,
 * and the records whose added relation fields link to it.
 *
 * Server-only.
 */

import { pinnedAmong } from "./favorites";
import { loadFields } from "./fields";
import { listTimeline } from "./timeline";
import type { TimelinePage } from "../model/timeline";
import { getRecord, shelfPeople, shown } from "./records";
import { recordSelect, table } from "./columns";
import { relatedLists, type RelatedList } from "../model/related";
import type { ObjectRule } from "../model/roles";
import { recordWhere, type Abilities, type CrmActor } from "./access";
import {
    CRM_OBJECTS,
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
    /** What the reader's role is held to for this kind of record. */
    readonly rule?: ObjectRule;
}

export async function openRecord(
    actor: CrmActor,
    object: CrmObject,
    id: string
): Promise<RecordOpening> {
    // The fields of every kind the reader may read, in the same round trip as
    // the record: an added relation on any of them may point at this one.
    const [record, people, ...loaded] = await Promise.all([
        getRecord(actor, object, id),
        shelfPeople(actor),
        ...CRM_OBJECTS.map((other) =>
            other === object || actor.can[other].read
                ? loadFields(actor.shelf, other)
                : Promise.resolve([])
        )
    ]);
    const added = Object.fromEntries(
        CRM_OBJECTS.map((other, at) => [other, loaded[at]!])
    ) as Record<CrmObject, FieldDef[]>;
    const fields = added[object];
    const lists = record
        ? relatedLists(object, added).filter(
              (list) =>
                  actor.can[list.object].read &&
                  !(actor.rules?.[list.object].hidden ?? []).includes(list.field)
          )
        : [];
    const timeline: Promise<TimelinePage> = record
        ? listTimeline(actor, object, id, people)
        : Promise.resolve({ events: [], next: null });
    const pinned = record ? pinnedAmong(actor, "record", [id]) : Promise.resolve([]);
    // enigma: bounded - `relatedLists` comes from the built-in relation fields
    // (two lists at most) and the relation slots (three per kind), so the
    // reads per page stay fixed however many records there are.
    const related = await Promise.all(
        lists.map(async (list): Promise<RelatedRecords> => {
            const where = {
                ...recordWhere(actor, list.object),
                deletedAt: null,
                [list.column]: list.label === undefined ? id : { has: id }
            };
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
                    const one = shown(actor, list.object, row);
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
        favorite: (await pinned).length > 0,
        rule: actor.rules?.[object]
    };
}
