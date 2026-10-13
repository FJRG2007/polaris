/**
 * Workflows: when something happens to a kind of record, do these things. The
 * shapes a workflow is saved in, the record changes that set one off, and the
 * rules the screen and the server both check a workflow against.
 *
 * Pure and client-safe.
 */

import { z } from "zod";
import { isTimeZone, nextCronRun, parseCron } from "@polaris/core";
import { csvValue } from "./csv";
import { filterSchema, type ViewFilter } from "./filters";
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

/** Whether a cron expression reads as a schedule. */
export function isCron(expression: string): boolean {
    try {
        parseCron(expression);
        return true;
    } catch {
        return false;
    }
}

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
    }),
    /** Somebody runs it on a record from the record's page. */
    z.object({ kind: z.literal("manual") }),
    /** A call to the workflow's secret address. */
    z.object({ kind: z.literal("webhook") }),
    /** A cron schedule, read in a time zone. */
    z.object({
        kind: z.literal("schedule"),
        cron: z.string().trim().min(1).max(120).refine(isCron),
        timeZone: z.string().min(1).max(64).refine(isTimeZone)
    })
]);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;
export type TriggerKind = WorkflowTrigger["kind"];

/** The triggers in the order the screen offers them. */
export const TRIGGER_KINDS: readonly TriggerKind[] = [
    "created",
    "updated",
    "fieldChanged",
    "deleted",
    "manual",
    "schedule",
    "webhook"
];

/** The most fields one action writes. */
export const MAX_ACTION_VALUES = 40;

/** What the editor offers a task or notification action: the lists the
 *  editor may add tasks to and the people on the shelf. */
export interface WorkflowOptions {
    readonly taskLists: { id: string; name: string; spaceName: string }[];
    readonly people: { id: string; name: string }[];
    /** Whether the reader has a mailbox a workflow's email can go from. */
    readonly mail?: boolean;
}

/** The longest address a workflow may call. */
export const REQUEST_URL_MAX = 2048;

/** Whether a text is an http or https address with no credentials in it. Where
 *  it resolves to is checked when it is called, every time. */
export function isHttpAddress(text: string): boolean {
    try {
        const url = new URL(text);
        return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            !url.username &&
            !url.password
        );
    } catch {
        return false;
    }
}

/** How far ahead a workflow's task may fall due, in days. */
export const MAX_DUE_DAYS = 365;

/** The most people one notification goes to. */
export const MAX_RECIPIENTS = 50;

/** The longest title a notification may have. */
export const NOTIFY_TITLE_MAX = 200;

/** The most addresses one workflow email goes to. */
export const MAX_EMAIL_RECIPIENTS = 20;

/** The longest subject a workflow email may have. */
export const EMAIL_SUBJECT_MAX = 300;

/** The longest recipient list a workflow email may have, as typed. */
export const EMAIL_TO_MAX = 2000;

const anEmail = z.string().email().max(254);

/** The addresses in a filled-in recipient list: split on commas, semicolons
 *  and spaces, lowercased, each once. Anything that is not an address is
 *  returned apart, so a run can say which. */
export function emailRecipients(text: string): { addresses: string[]; invalid: string[] } {
    const addresses: string[] = [];
    const invalid: string[] = [];
    for (const part of text.split(/[,;\s]+/)) {
        const one = part.trim().toLowerCase();
        if (!one) continue;
        if (!anEmail.safeParse(one).success) invalid.push(one);
        else if (!addresses.includes(one)) addresses.push(one);
    }
    return { addresses, invalid };
}

/** Field values to write, each the text a cell would hold. `{{field}}` in one
 *  is the value of that field on the record the workflow is about. */
const valuesSchema = z
    .record(z.string().min(1).max(64), z.string().max(ACTION_TEXT_MAX))
    .refine((values) => {
        const count = Object.keys(values).length;
        return count > 0 && count <= MAX_ACTION_VALUES;
    });

/** A filter a workflow checks a record against, as a view's filter reads. */
export type WorkflowFilter = ViewFilter;

/** The most records one "for each record found" goes through. */
export const MAX_FOUND = 50;

/** The most actions one workflow holds, counting the ones inside branches. */
export const MAX_TOTAL_ACTIONS = 30;

/** The longest a workflow may wait, in minutes: thirty days. */
export const MAX_DELAY_MINUTES = 30 * 24 * 60;

/** The actions that do one thing, each on its own. */
const LEAF_ACTIONS = [
    z.object({ kind: z.literal("updateRecord"), values: valuesSchema }),
    z.object({
        kind: z.literal("createRecord"),
        object: z.enum(CRM_OBJECTS),
        values: valuesSchema
    }),
    /** A task in a list of Polaris's Tasks, linked to the record when there is
     *  one; due that many days after the run, or never. */
    z.object({
        kind: z.literal("createTask"),
        listId: z.string().uuid(),
        name: z.string().trim().min(1).max(ACTION_TEXT_MAX),
        dueInDays: z.number().int().min(0).max(MAX_DUE_DAYS).nullable()
    }),
    /** A notification to people on the shelf: by id, or `field:<key>` for
     *  whoever an owner field of the record names. */
    z.object({
        kind: z.literal("notify"),
        to: z.array(z.string().min(1).max(80)).min(1).max(MAX_RECIPIENTS),
        title: z.string().trim().min(1).max(NOTIFY_TITLE_MAX),
        body: z.string().max(ACTION_TEXT_MAX)
    }),
    /** An email from the mailbox of whoever owns the workflow. Every part is a
     *  template, so `{{email}}` writes to the person the record is about. */
    z.object({
        kind: z.literal("sendEmail"),
        to: z.string().trim().min(1).max(EMAIL_TO_MAX),
        subject: z.string().trim().min(1).max(EMAIL_SUBJECT_MAX),
        body: z.string().max(ACTION_TEXT_MAX)
    }),
    /** A POST of the record, as JSON, to an address outside. */
    z.object({
        kind: z.literal("httpRequest"),
        url: z.string().trim().max(REQUEST_URL_MAX).refine(isHttpAddress)
    })
] as const;

/** An action that does one thing: the kind a branch or a loop holds. */
export const leafActionSchema = z.discriminatedUnion("kind", [...LEAF_ACTIONS]);
export type LeafAction = z.infer<typeof leafActionSchema>;

const branchSchema = z.array(leafActionSchema).max(MAX_WORKFLOW_ACTIONS);

/** One thing a workflow does. */
export const workflowActionSchema = z.discriminatedUnion("kind", [
    ...LEAF_ACTIONS,
    /** Go on only when the record matches; otherwise end the run there, as a
     *  run that went well. */
    z.object({ kind: z.literal("filter"), when: filterSchema }),
    /** One list of actions when the record matches, the other when it does not. */
    z.object({
        kind: z.literal("ifElse"),
        when: filterSchema,
        then: branchSchema,
        otherwise: branchSchema
    }),
    /** Find the records of the same kind that match, and run the actions on
     *  each one in turn: in them, "the record" is the one found. */
    z.object({
        kind: z.literal("forEach"),
        where: filterSchema,
        limit: z.number().int().min(1).max(MAX_FOUND),
        actions: branchSchema.min(1)
    }),
    /** Wait, then go on with the actions after it. */
    z.object({
        kind: z.literal("delay"),
        minutes: z.number().int().min(1).max(MAX_DELAY_MINUTES)
    })
]);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export type ActionKind = WorkflowAction["kind"];

/** The actions that do one thing, in the order the screen offers them. */
export const LEAF_KINDS: readonly LeafAction["kind"][] = [
    "updateRecord",
    "createRecord",
    "createTask",
    "notify",
    "sendEmail",
    "httpRequest"
];

/** The actions in the order the screen offers them. */
export const ACTION_KINDS: readonly ActionKind[] = [
    ...LEAF_KINDS,
    "filter",
    "ifElse",
    "forEach",
    "delay"
];

/** The actions a workflow's list holds, with the ones inside branches. */
export function allActions(actions: readonly WorkflowAction[]): WorkflowAction[] {
    return actions.flatMap((action): WorkflowAction[] => {
        if (action.kind === "ifElse") return [action, ...action.then, ...action.otherwise];
        if (action.kind === "forEach") return [action, ...action.actions];
        return [action];
    });
}

/** A recipient that is whoever an owner field of the record names. */
export const FIELD_RECIPIENT = "field:";

/** The triggers that are about one record still out of the trash. */
export const LIVE_RECORD_TRIGGERS: readonly TriggerKind[] = [
    "created",
    "updated",
    "fieldChanged",
    "manual"
];

/** Whether an action can run under a kind of trigger: one that changes "the
 *  record" needs a trigger that is about one still there. */
export function actionFits(kind: ActionKind, trigger: TriggerKind): boolean {
    if (kind === "updateRecord" || kind === "filter" || kind === "ifElse") {
        return LIVE_RECORD_TRIGGERS.includes(trigger);
    }
    return true;
}

/**
 * A template filled in: `{{key}}` is the value of that field on the record, as
 * the text its CSV cell would hold, and nothing for a field that is not there.
 */
export function renderTemplate(
    text: string,
    fields: readonly FieldDef[],
    values: Readonly<Record<string, FieldValue | undefined>>,
    /** The body of the outside call that set the workflow off, if one did:
     *  `{{body.a.b}}` is its `a.b`, as text. */
    body: unknown = undefined
): string {
    return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
        if (key.startsWith("body.")) return bodyText(body, key.slice("body.".length));
        const field = fields.find((one) => one.key === key);
        return field ? csvValue(field, values[key]) : "";
    });
}

/** One value out of a call's body, as text: a string as it is, anything else
 *  as JSON, nothing for what is not there. */
function bodyText(body: unknown, path: string): string {
    let at: unknown = body;
    for (const step of path.split(".")) {
        if (at === null || typeof at !== "object" || !Object.hasOwn(at, step)) return "";
        at = (at as Record<string, unknown>)[step];
    }
    if (at === null || at === undefined) return "";
    return typeof at === "string" ? at : JSON.stringify(at);
}

/** A workflow as the screen sends it. */
export const workflowInputSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(WORKFLOW_NAME_MAX),
    trigger: workflowTriggerSchema,
    actions: z
        .array(workflowActionSchema)
        .max(MAX_WORKFLOW_ACTIONS)
        .refine((actions) => allActions(actions).length <= MAX_TOTAL_ACTIONS),
    enabled: z.boolean().default(true),
    /** Give a webhook trigger a new address, ending the old one. */
    newHookSecret: z.boolean().optional()
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
    /** When a schedule next runs it. */
    readonly nextRunAt: string | null;
}

/** A workflow just saved, and what the reader is told about it once. */
export interface SavedWorkflow {
    readonly workflow: WorkflowView;
    /** A webhook's new address, `/api/crm/hooks/<secret>`: shown this once,
     *  since only its hash is kept. */
    readonly hookPath?: string;
}

/** How a run ended, or where it stands. */
export const RUN_STATUSES = [
    "running",
    "waiting",
    "done",
    "stopped",
    "failed",
    "cancelled"
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A run's cause as a trigger kind the screen can name. */
export function causeKind(cause: string): TriggerKind {
    return (TRIGGER_KINDS as readonly string[]).includes(cause) ? (cause as TriggerKind) : "manual";
}

/** The most runs of one workflow that are kept. */
export const MAX_RUNS = 100;

/** One run as the editor's log shows it. */
export interface WorkflowRunView {
    readonly id: string;
    readonly status: RunStatus;
    readonly cause: string;
    readonly recordId: string | null;
    readonly error: string | null;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    /** When a waiting run goes on. */
    readonly resumeAt: string | null;
}

/** The most bytes of an outside call's body a workflow reads. */
export const MAX_HOOK_BODY = 64 * 1024;

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

/** When a schedule trigger next fires after `after`; null for any other. */
export function nextScheduledRun(trigger: WorkflowTrigger, after: Date): Date | null {
    if (trigger.kind !== "schedule") return null;
    try {
        return nextCronRun(parseCron(trigger.cron), after, trigger.timeZone);
    } catch {
        return null;
    }
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
