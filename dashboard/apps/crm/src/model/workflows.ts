/**
 * Workflows: when something happens to a kind of record, do these things. The
 * shapes a workflow is saved in, the record changes that set one off, and the
 * rules the screen and the server both check a workflow against.
 *
 * Pure and client-safe.
 */

import { z } from "zod";
import type { EventKind, FieldChange } from "./timeline";

/** The longest name a workflow may have. */
export const WORKFLOW_NAME_MAX = 120;

/** The most actions one workflow runs. */
export const MAX_WORKFLOW_ACTIONS = 10;

/** The most workflows one kind of record may have on a shelf. */
export const MAX_WORKFLOWS = 50;

/** What sets a workflow off. */
export const workflowTriggerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("created") }),
    z.object({ kind: z.literal("updated") }),
    z.object({ kind: z.literal("deleted") })
]);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;
export type TriggerKind = WorkflowTrigger["kind"];

/** The triggers in the order the screen offers them. */
export const TRIGGER_KINDS: readonly TriggerKind[] = ["created", "updated", "deleted"];

/** One thing a workflow does. */
export const workflowActionSchema = z.never();
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export type ActionKind = WorkflowAction extends { kind: infer K } ? K : never;

/** The actions in the order the screen offers them. */
export const ACTION_KINDS: readonly ActionKind[] = [];

/** Whether an action can run under a kind of trigger: one that changes "the
 *  record" needs a trigger that is about one. */
export function actionFits(_kind: ActionKind, _trigger: TriggerKind): boolean {
    return true;
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

/** Whether a record change sets a trigger off. */
export function triggerMatches(trigger: WorkflowTrigger, event: RecordEvent): boolean {
    return trigger.kind === event.kind;
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
