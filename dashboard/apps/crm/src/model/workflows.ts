/**
 * Workflows: when something happens to a kind of record, do these things. The
 * shapes a workflow is saved in, the record changes that set one off, and the
 * rules the screen and the server both check a workflow against.
 *
 * Pure and client-safe.
 */

import { z } from "zod";
import { csvValue } from "./csv";
import type { EventKind, FieldChange } from "./timeline";
import { CRM_OBJECTS, type FieldDef, type FieldValue } from "./objects";

/** The longest name a workflow may have. */
export const WORKFLOW_NAME_MAX = 120;

/** The most actions one workflow runs. */
export const MAX_WORKFLOW_ACTIONS = 10;

/** The most workflows one kind of record may have on a shelf. */
export const MAX_WORKFLOWS = 50;

/** The longest text an action holds in one place: a value, a title. */
export const ACTION_TEXT_MAX = 2000;

/** What sets a workflow off. */
export const workflowTriggerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("created") }),
    z.object({ kind: z.literal("updated") }),
    z.object({ kind: z.literal("deleted") }),
    /** A field changes - to anything, or to the value named (as its CSV cell
     *  reads, case aside). */
    z.object({
        kind: z.literal("fieldChanged"),
        field: z.string().min(1).max(64),
        to: z.string().trim().max(ACTION_TEXT_MAX).nullable()
    })
]);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;
export type TriggerKind = WorkflowTrigger["kind"];

/** The triggers in the order the screen offers them. */
export const TRIGGER_KINDS: readonly TriggerKind[] = [
    "created",
    "updated",
    "fieldChanged",
    "deleted"
];

/** The most fields one action writes. */
export const MAX_ACTION_VALUES = 40;

/** Field values to write, each the text a cell would hold. `{{field}}` in one
 *  is the value of that field on the record the workflow is about. */
const valuesSchema = z
    .record(z.string().min(1).max(64), z.string().max(ACTION_TEXT_MAX))
    .refine((values) => {
        const count = Object.keys(values).length;
        return count > 0 && count <= MAX_ACTION_VALUES;
    });

/** One thing a workflow does. */
export const workflowActionSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("updateRecord"), values: valuesSchema }),
    z.object({
        kind: z.literal("createRecord"),
        object: z.enum(CRM_OBJECTS),
        values: valuesSchema
    })
]);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export type ActionKind = WorkflowAction["kind"];

/** The actions in the order the screen offers them. */
export const ACTION_KINDS: readonly ActionKind[] = ["updateRecord", "createRecord"];

/** The triggers that are about one record still out of the trash. */
const LIVE_RECORD_TRIGGERS: readonly TriggerKind[] = ["created", "updated", "fieldChanged"];

/** Whether an action can run under a kind of trigger: one that changes "the
 *  record" needs a trigger that is about one still there. */
export function actionFits(kind: ActionKind, trigger: TriggerKind): boolean {
    if (kind === "updateRecord") return LIVE_RECORD_TRIGGERS.includes(trigger);
    return true;
}

/**
 * A template filled in: `{{key}}` is the value of that field on the record, as
 * the text its CSV cell would hold, and nothing for a field that is not there.
 */
export function renderTemplate(
    text: string,
    fields: readonly FieldDef[],
    values: Readonly<Record<string, FieldValue | undefined>>
): string {
    return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
        const field = fields.find((one) => one.key === key);
        return field ? csvValue(field, values[key]) : "";
    });
}

/** A workflow as the screen sends it. */
export const workflowInputSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(WORKFLOW_NAME_MAX),
    trigger: workflowTriggerSchema,
    actions: z.array(workflowActionSchema).max(MAX_WORKFLOW_ACTIONS),
    enabled: z.boolean().default(true)
});
export type WorkflowInput = z.input<typeof workflowInputSchema>;

/** A workflow as the screen lists it. */
export interface WorkflowView {
    readonly id: string;
    readonly name: string;
    readonly trigger: WorkflowTrigger;
    readonly actions: WorkflowAction[];
    readonly enabled: boolean;
    readonly runCount: number;
    readonly lastRunAt: string | null;
    readonly lastError: string | null;
}

/** A workflow just saved, and what the reader is told about it once. */
export interface SavedWorkflow {
    readonly workflow: WorkflowView;
}

/** A change to a record, as a trigger reads it. */
export interface RecordEvent {
    readonly kind: "created" | "updated" | "deleted";
    readonly recordId: string;
    readonly changes: readonly FieldChange[];
}

/** What the timeline logged, as the changes a trigger can match. A record made
 *  by an import is made; an update that changed nothing is nothing; a record
 *  taken out of the trash sets nothing off. */
export function eventsOf(
    logged: readonly {
        readonly recordId: string;
        readonly kind: EventKind;
        readonly changes?: readonly FieldChange[];
    }[]
): RecordEvent[] {
    return logged.flatMap((event): RecordEvent[] => {
        const changes = event.changes ?? [];
        if (event.kind === "created" || event.kind === "imported") {
            return [{ kind: "created", recordId: event.recordId, changes }];
        }
        if (event.kind === "updated" && changes.length > 0) {
            return [{ kind: "updated", recordId: event.recordId, changes }];
        }
        if (event.kind === "trashed")
            return [{ kind: "deleted", recordId: event.recordId, changes }];
        return [];
    });
}

/** Whether a record change sets a trigger off. `fields` are the fields of the
 *  record's kind, for reading a changed value as text. */
export function triggerMatches(
    trigger: WorkflowTrigger,
    event: RecordEvent,
    fields: readonly FieldDef[] = []
): boolean {
    if (trigger.kind !== "fieldChanged") return trigger.kind === event.kind;
    if (event.kind !== "updated") return false;
    const change = event.changes.find((one) => one.key === trigger.field);
    if (!change) return false;
    if (trigger.to === null || trigger.to === "") return true;
    const field = fields.find((one) => one.key === trigger.field);
    if (!field) return false;
    return csvValue(field, change.after).trim().toLowerCase() === trigger.to.toLowerCase();
}

/** A stored trigger, or null when it no longer reads as one. */
export function readTrigger(raw: string): WorkflowTrigger | null {
    try {
        const parsed = workflowTriggerSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Stored actions, keeping only the ones that still read as one. */
export function readActions(raw: string): WorkflowAction[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_WORKFLOW_ACTIONS).flatMap((entry) => {
        const one = workflowActionSchema.safeParse(entry);
        return one.success ? [one.data] : [];
    });
}
