/**
 * The records that point at a record: every relation field of another kind of
 * record whose target is this kind. A company is pointed at by its people and
 * its deals, a person by the deals they are the contact of. Read off the field
 * definitions, so a relation added there is a related list on the record page
 * with no other change.
 *
 * Client-safe.
 */

import { CRM_OBJECTS, FIELDS, type CrmObject } from "./objects";

export interface RelatedList {
    /** The kind of record that points here. */
    readonly object: CrmObject;
    /** Its relation field. */
    readonly field: string;
    /** The column that relation is stored in. */
    readonly column: string;
}

export function relatedLists(object: CrmObject): RelatedList[] {
    return CRM_OBJECTS.flatMap((other) =>
        FIELDS[other]
            .filter((field) => field.kind === "relation" && field.target === object)
            .map((field) => ({ object: other, field: field.key, column: `${field.key}Id` }))
    );
}

/** Where a record's page is. */
export function recordHref(object: CrmObject, id: string): string {
    return `/crm/${object}/${encodeURIComponent(id)}`;
}
