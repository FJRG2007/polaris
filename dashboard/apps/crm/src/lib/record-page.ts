/**
 * One record's page: the record, what the reader may do with it, and the
 * records that point at it - a company's people and deals, a person's deals.
 *
 * Server-only.
 */

import { loadFields } from "./fields";
import { getRecord, shelfPeople } from "./records";
import { recordSelect, table, toRecord } from "./columns";
import { relatedLists, type RelatedList } from "../model/related";
import { shelfWhere, type Abilities, type CrmActor } from "./access";
import { recordName, type CrmObject, type CrmRecord, type FieldDef, type Ref } from "../model/objects";

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
    const lists = record
        ? relatedLists(object).filter((list) => actor.can[list.object].read)
        : [];
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
    return { record, fields: [...fields], can: actor.can, people, related };
}
