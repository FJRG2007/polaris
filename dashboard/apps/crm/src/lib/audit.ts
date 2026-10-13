/**
 * The CRM's audit log: every record event on the shelf, newest first, and the
 * same as a CSV file.
 *
 * A reader sees the events of the kinds of record they may read, and of those
 * only when their role reaches every record: an event does not say whose
 * record it was, so a role held to its own records reads that history on each
 * record instead. A field the role hides is left out of every change.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { prisma } from "@polaris/db";
import { loadFields } from "./fields";
import { CRM_OBJECTS } from "@polaris/core";
import { nameSelect, refName, table } from "./columns";
import { isEventKind, readChanges } from "../model/timeline";
import { ownClause, recordWhere, shelfWhere, type CrmActor } from "./access";
import { fieldsOf, type CrmObject, type FieldDef, type Ref } from "../model/objects";
import {
    AUDIT_EXPORT_LIMIT,
    AUDIT_PAGE,
    auditCsv,
    type AuditEvent,
    type AuditPage,
    type AuditQuery
} from "../model/audit";

/** How many events one read of an export takes. */
const BATCH = 500;

interface EventRow {
    id: string;
    object: string;
    recordId: string;
    kind: string;
    actorId: string | null;
    changes: string;
    createdAt: Date;
}

/** The kinds of record whose events this reader may see in the log. */
export function auditObjects(actor: CrmActor): CrmObject[] {
    return CRM_OBJECTS.filter((object) => actor.can[object].read && !ownClause(actor, object));
}

function eventsWhere(actor: CrmActor, query: AuditQuery): Record<string, unknown> | null {
    const objects = auditObjects(actor).filter((object) => !query.object || object === query.object);
    if (objects.length === 0) return null;
    return {
        ...shelfWhere(actor.shelf),
        object: { in: objects },
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.since || query.until
            ? {
                  createdAt: {
                      ...(query.since ? { gte: new Date(query.since) } : {}),
                      ...(query.until ? { lt: new Date(query.until) } : {})
                  }
              }
            : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {})
    };
}

async function readEvents(where: Record<string, unknown>, take: number): Promise<EventRow[]> {
    return (await prisma.crmEvent.findMany({
        where,
        orderBy: { id: "desc" },
        take,
        select: {
            id: true,
            object: true,
            recordId: true,
            kind: true,
            actorId: true,
            changes: true,
            createdAt: true
        }
    })) as EventRow[];
}

/** The names the records behind these events go by now, in one read per kind
 *  of record; a record deleted for good has none. The trash is included. */
async function recordNames(
    actor: CrmActor,
    rows: readonly EventRow[]
): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    await Promise.all(
        CRM_OBJECTS.map(async (object) => {
            const ids = [...new Set(rows.filter((row) => row.object === object).map((row) => row.recordId))];
            if (ids.length === 0) return;
            const found = (await table(object).findMany({
                where: { ...recordWhere(actor, object), id: { in: ids } },
                select: nameSelect(object)
            })) as Record<string, unknown>[];
            for (const row of found) names.set(row.id as string, refName(row));
        })
    );
    return names;
}

function toEvents(
    actor: CrmActor,
    rows: readonly EventRow[],
    people: readonly Ref[],
    names: ReadonlyMap<string, string>
): AuditEvent[] {
    const byId = new Map(people.map((person) => [person.id, person]));
    return rows.flatMap((row) => {
        const object = row.object as CrmObject;
        if (!CRM_OBJECTS.includes(object) || !isEventKind(row.kind)) return [];
        const hidden = actor.rules?.[object].hidden ?? [];
        return [
            {
                id: row.id,
                object,
                recordId: row.recordId,
                recordName: names.get(row.recordId) ?? null,
                kind: row.kind,
                actor: row.actorId ? (byId.get(row.actorId) ?? null) : null,
                at: row.createdAt.toISOString(),
                changes: readChanges(row.changes).filter((change) => !hidden.includes(change.key))
            }
        ];
    });
}

/** One page of the log, newest first, after the event `query.cursor`. */
export async function listAudit(
    actor: CrmActor,
    query: AuditQuery,
    people: readonly Ref[]
): Promise<AuditPage> {
    const where = eventsWhere(actor, query);
    if (!where) return { events: [], next: null };
    const rows = await readEvents(where, AUDIT_PAGE + 1);
    const shown = rows.slice(0, AUDIT_PAGE);
    return {
        events: toEvents(actor, shown, people, await recordNames(actor, shown)),
        next: rows.length > AUDIT_PAGE ? shown[shown.length - 1]!.id : null
    };
}

export interface AuditExport {
    readonly csv: string;
    readonly rows: number;
    /** More events matched than one export writes. */
    readonly truncated: boolean;
}

/** The log, as the filters narrow it, as a CSV file. */
export async function exportAudit(
    actor: CrmActor,
    query: AuditQuery,
    people: readonly Ref[]
): Promise<AuditExport> {
    const where = eventsWhere(actor, { ...query, cursor: null });
    const rows: EventRow[] = [];
    // Batches by id, which is time order: one event past the ceiling is read to
    // tell that the file was cut.
    while (where && rows.length <= AUDIT_EXPORT_LIMIT) {
        const last = rows[rows.length - 1];
        const batch = await readEvents(
            last ? { ...where, id: { lt: last.id } } : where,
            Math.min(BATCH, AUDIT_EXPORT_LIMIT + 1 - rows.length)
        );
        rows.push(...batch);
        if (batch.length < BATCH) break;
    }
    const kept = rows.slice(0, AUDIT_EXPORT_LIMIT);
    const objects = [...new Set(kept.map((row) => row.object))].filter((object): object is CrmObject =>
        CRM_OBJECTS.includes(object as CrmObject)
    );
    const [names, custom, t] = await Promise.all([
        recordNames(actor, kept),
        Promise.all(objects.map(async (object) => [object, await loadFields(actor.shelf, object)] as const)),
        crmT()
    ]);
    const customOf = new Map<CrmObject, readonly FieldDef[]>(custom);
    const events = toEvents(actor, kept, people, names);
    return {
        csv: auditCsv(events, (object) => fieldsOf(object, customOf.get(object) ?? []), {
            header: [
                t("audit.when"),
                t("audit.who"),
                t("audit.object"),
                t("audit.record"),
                t("audit.what"),
                t("audit.field"),
                t("audit.before"),
                t("audit.after")
            ],
            someone: t("timeline.someone"),
            object: (object) => t(`objects.${object}.plural`),
            kind: (kind) => t(`audit.kinds.${kind}`),
            field: (object, field) =>
                field.label ?? t(`fields.${object}.${field.key}` as Parameters<typeof t>[0])
        }),
        rows: events.length,
        truncated: rows.length > AUDIT_EXPORT_LIMIT
    };
}
