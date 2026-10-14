"use server";

/**
 * The CRM's audit log, a page at a time or as a CSV file. Every input is
 * checked against a schema here.
 */

import * as audit from "../lib/audit";
import { loadFields } from "../lib/fields";
import { shelfPeople } from "../lib/records";
import { requireCrmActor } from "../lib/access";
import type { CrmObject, FieldDef, Ref } from "../model/objects";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { auditQuerySchema, type AuditPage } from "../model/audit";

export interface AuditReading extends AuditPage {
    /** The kinds of record whose events the reader may see here. */
    readonly objects: CrmObject[];
    /** Who works on this shelf, to narrow the log to one of them. */
    readonly people: Ref[];
    /** The fields added to each of those kinds of record, to draw a change. */
    readonly fields: Partial<Record<CrmObject, FieldDef[]>>;
}

export async function auditAction(input: unknown): Promise<Outcome<AuditReading>> {
    const parsed = auditQuerySchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const actor = await requireCrmActor();
        const objects = audit.auditObjects(actor);
        const [people, fields] = await Promise.all([
            shelfPeople(actor),
            Promise.all(
                objects.map(async (object) => [object, await loadFields(actor.shelf, object)])
            )
        ]);
        return {
            ...(await audit.listAudit(actor, parsed.data, people)),
            objects,
            people,
            fields: Object.fromEntries(fields)
        };
    });
}

export async function exportAuditAction(input: unknown): Promise<Outcome<audit.AuditExport>> {
    const parsed = auditQuerySchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const actor = await requireCrmActor();
        return audit.exportAudit(actor, parsed.data, await shelfPeople(actor));
    });
}
