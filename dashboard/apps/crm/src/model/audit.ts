/**
 * The CRM's audit log: every change to every record on the shelf, by whom and
 * when, narrowed by kind of record, what happened, who did it and when.
 *
 * Pure and client-safe.
 */

import { z } from "zod";
import { csvCell, csvValue } from "./csv";
import { CRM_OBJECTS, type CrmObject, type FieldDef, type Ref } from "./objects";
import { EVENT_KINDS, type EventKind, type FieldChange } from "./timeline";

/** The most events one page of the log holds. */
export const AUDIT_PAGE = 50;

/** The most events one export writes. */
export const AUDIT_EXPORT_LIMIT = 5000;

export const auditQuerySchema = z.object({
    object: z.enum(CRM_OBJECTS).nullable(),
    kind: z.enum(EVENT_KINDS).nullable(),
    actorId: z.string().uuid().nullable(),
    /** An instant: the start of the first day asked for, in the reader's zone. */
    since: z.string().datetime().nullable(),
    /** An instant: the end of the last day asked for, in the reader's zone. */
    until: z.string().datetime().nullable(),
    /** The id to read the next, older page after. */
    cursor: z.string().uuid().nullable()
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const EMPTY_AUDIT_QUERY: AuditQuery = {
    object: null,
    kind: null,
    actorId: null,
    since: null,
    until: null,
    cursor: null
};

export interface AuditEvent {
    readonly id: string;
    readonly object: CrmObject;
    readonly recordId: string;
    /** The record's name now; null once it is deleted for good. */
    readonly recordName: string | null;
    readonly kind: EventKind;
    readonly actor: Ref | null;
    readonly at: string;
    readonly changes: readonly FieldChange[];
}

export interface AuditPage {
    readonly events: AuditEvent[];
    readonly next: string | null;
}

/**
 * The instants a range of days picked in the reader's zone covers: from the
 * start of `from` to the start of the day after `to`. A day left empty leaves
 * that end open; a malformed one is ignored.
 */
export function auditRange(
    from: string,
    to: string
): { since: string | null; until: string | null } {
    const start = (day: string, offset: number) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
        if (!match) return null;
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offset);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    return { since: start(from, 0), until: start(to, 1) };
}

export interface AuditCsvLabels {
    readonly header: readonly [string, string, string, string, string, string, string, string];
    readonly someone: string;
    readonly object: (object: CrmObject) => string;
    readonly kind: (kind: EventKind) => string;
    readonly field: (object: CrmObject, field: FieldDef) => string;
}

/**
 * The log as a CSV file: one line per field changed, or one for an event that
 * changed none, with when, who, the kind of record, its name and what
 * happened. A change to a field that is gone is left out, as on screen.
 */
export function auditCsv(
    events: readonly AuditEvent[],
    fieldsOf: (object: CrmObject) => readonly FieldDef[],
    labels: AuditCsvLabels
): string {
    const lines = [labels.header.map(csvCell).join(",")];
    for (const event of events) {
        const lead = [
            event.at,
            event.actor?.name || labels.someone,
            labels.object(event.object),
            event.recordName ?? "",
            labels.kind(event.kind)
        ];
        const byKey = new Map(fieldsOf(event.object).map((field) => [field.key, field]));
        const changes = event.changes.flatMap((change) => {
            const field = byKey.get(change.key);
            return field
                ? [
                      [
                          labels.field(event.object, field),
                          csvValue(field, change.before),
                          csvValue(field, change.after)
                      ]
                  ]
                : [];
        });
        for (const tail of changes.length > 0 ? changes : [["", "", ""]]) {
            lines.push([...lead, ...tail].map(csvCell).join(","));
        }
    }
    return `﻿${lines.join("\r\n")}\r\n`;
}
