/**
 * The records that point at a record: every relation field of another kind of
 * record whose target is this kind. A company is pointed at by its people and
 * its deals, a person by the deals they are the contact of. Read off the field
 * definitions, so a relation added there is a related list on the record page
 * with no other change; so is every relation somebody added (`added`) whose
 * target is this kind, listing the records whose links include this one.
 *
 * Client-safe.
 */

import { CRM_OBJECTS, FIELDS, isLinkList, type CrmObject, type FieldDef } from "./objects";

export interface RelatedList {
    /** The kind of record that points here. */
    readonly object: CrmObject;
    /** Its relation field. */
    readonly field: string;
    /** The column that relation is stored in. */
    readonly column: string;
    /** For a relation somebody added: its name. Its column is then a list of
     *  ids that holds this record's, not one id equal to it. */
    readonly label?: string;
}

export function relatedLists(
    object: CrmObject,
    added: Partial<Readonly<Record<CrmObject, readonly FieldDef[]>>> = {}
): RelatedList[] {
    const builtIn = CRM_OBJECTS.flatMap((other) =>
        FIELDS[other]
            .filter((field) => field.kind === "relation" && field.target === object)
            .map((field) => ({ object: other, field: field.key, column: `${field.key}Id` }))
    );
    const custom = CRM_OBJECTS.flatMap((other) =>
        (added[other] ?? [])
            .filter((field) => isLinkList(field) && field.target === object)
            .map((field) => ({
                object: other,
                field: field.key,
                column: field.key,
                label: field.label ?? field.key
            }))
    );
    return [...builtIn, ...custom];
}

/** Where a record's page is. */
/** How a shared record is named in `crm.record`. */
export function recordSubjectId(object: CrmObject, id: string): string {
    return `${object}:${id}`;
}

export function recordHref(object: CrmObject, id: string): string {
    return `/crm/${object}/${encodeURIComponent(id)}`;
}
