/**
 * Writing and reading a record's activity log.
 *
 * Every change in `records.ts` calls `logEvents` after it is stored. The log is
 * a record of what happened, not part of it: a failed write here is logged on
 * the server and never undoes, or refuses, the change it describes.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { CrmObject, Ref } from "../model/objects";
import { requireCan, shelfData, shelfWhere, type CrmActor } from "./access";
import {
    isEventKind,
    readChanges,
    TIMELINE_PAGE,
    type EventKind,
    type FieldChange,
    type TimelinePage
} from "../model/timeline";

export interface NewEvent {
    readonly recordId: string;
    readonly kind: EventKind;
    readonly changes?: readonly FieldChange[];
}

/** Store what just happened to some records. An update that changed nothing
 *  leaves nothing. */
export async function logEvents(
    actor: CrmActor,
    object: CrmObject,
    events: readonly NewEvent[]
): Promise<void> {
    const rows = events
        .filter((event) => event.kind !== "updated" || (event.changes?.length ?? 0) > 0)
        .map((event) => ({
            ...shelfData(actor.shelf),
            object,
            recordId: event.recordId,
            kind: event.kind,
            actorId: actor.user.id,
            changes: JSON.stringify(event.changes ?? [])
        }));
    if (rows.length === 0) return;
    try {
        await prisma.crmEvent.createMany({ data: rows });
    } catch (caught) {
        console.error("crm: could not log record events", { object, count: rows.length, caught });
    }
    // The workflows these changes set off run behind the request that made
    // them: what they do is not the reader's to wait for.
    void import("./workflows")
        .then((workflows) => workflows.onRecordEvents(actor, object, events))
        .catch((caught) => console.error("crm: could not run workflows", { object, caught }));
}

/** Remove the log of records deleted for good. */
export async function dropEvents(
    actor: CrmActor,
    ids: readonly string[],
    client: Pick<typeof prisma, "crmEvent"> = prisma
): Promise<void> {
    if (ids.length === 0) return;
    await client.crmEvent.deleteMany({
        where: { ...shelfWhere(actor.shelf), recordId: { in: [...ids] } }
    });
}

/** One page of a record's activity, newest first, after the event `before`. */
export async function listTimeline(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    people: readonly Ref[],
    before: string | null = null
): Promise<TimelinePage> {
    await requireCan(actor, object, "read");
    const rows = (await prisma.crmEvent.findMany({
        where: {
            ...shelfWhere(actor.shelf),
            object,
            recordId,
            ...(before ? { id: { lt: before } } : {})
        },
        orderBy: { id: "desc" },
        take: TIMELINE_PAGE + 1,
        select: { id: true, kind: true, actorId: true, changes: true, createdAt: true }
    })) as {
        id: string;
        kind: string;
        actorId: string | null;
        changes: string;
        createdAt: Date;
    }[];
    const names = new Map(people.map((person) => [person.id, person]));
    const shown = rows.slice(0, TIMELINE_PAGE);
    return {
        events: shown.flatMap((row) =>
            isEventKind(row.kind)
                ? [
                      {
                          id: row.id,
                          kind: row.kind,
                          actor: row.actorId ? (names.get(row.actorId) ?? null) : null,
                          at: row.createdAt.toISOString(),
                          changes: readChanges(row.changes)
                      }
                  ]
                : []
        ),
        next: rows.length > TIMELINE_PAGE ? shown[shown.length - 1]!.id : null
    };
}
