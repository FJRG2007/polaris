/**
 * Workflows: saved per kind of record on a shelf, set off by what happens to
 * the records there, and run as whoever saved them last - with what that
 * person's role lets them do on the shelf at the moment it runs, so a workflow
 * never does what its author could not do by hand.
 *
 * What a workflow does is never set off again by itself: a run marks its async
 * context, and the record changes it makes start no other workflow.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { prisma } from "@polaris/db";
import { CrmRefusal } from "./errors";
import { host } from "@polaris/app-host";
import type { NewEvent } from "./timeline";
import { writable } from "./columns";
import { loadFields } from "./fields";
import * as records from "./records";
import { importRecords, readRows } from "./import";
import { addLink } from "./links";
import { dueAt } from "../model/links";
import { recordHref } from "../model/related";
import { csvValue } from "../model/csv";
import type { RowProblem } from "../model/import";
import { fieldsOf, primaryField, type CrmObject, type CrmRecord } from "../model/objects";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { actorOn, requireCan, shelfData, shelfWhere, type CrmActor } from "./access";
import * as model from "../model/workflows";

/** A workflow as stored. */
interface StoredWorkflow {
    readonly id: string;
    readonly orgId: string | null;
    readonly userId: string | null;
    readonly object: string;
    readonly name: string;
    readonly trigger: string;
    readonly actions: string;
    readonly enabled: boolean;
    readonly runAsId: string | null;
    readonly runCount: number;
    readonly lastRunAt: Date | null;
    readonly lastError: string | null;
    readonly nextRunAt?: Date | null;
}

/** What a run knows about why it started. */
export interface RunContext {
    readonly object: CrmObject;
    /** The record it is about, when it is about one. */
    readonly recordId: string | null;
    readonly event: model.RecordEvent | null;
    /** The body of the outside call that set it off. */
    readonly body?: unknown;
}

/** How a webhook's secret is kept: its SHA-256, never the secret. */
export function hookHash(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
}

/** The longest failure kept on a workflow, in characters. */
const ERROR_MAX = 500;

const running = new AsyncLocalStorage<true>();

/** Run `work` as part of a workflow: the record changes it makes set nothing
 *  else off. */
export function withinWorkflow<T>(work: () => Promise<T>): Promise<T> {
    return running.run(true, work);
}

function toView(row: StoredWorkflow): model.WorkflowView | null {
    const trigger = model.readTrigger(row.trigger);
    if (!trigger) return null;
    return {
        id: row.id,
        name: row.name,
        trigger,
        actions: model.readActions(row.actions),
        enabled: row.enabled,
        runCount: row.runCount,
        lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
        lastError: row.lastError,
        nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null
    };
}

/** The workflows of a kind of record on the reader's shelf. */
export async function listWorkflows(
    actor: CrmActor,
    object: CrmObject
): Promise<model.WorkflowView[]> {
    await requireCan(actor, object, "edit");
    const rows = (await prisma.crmWorkflow.findMany({
        where: { ...shelfWhere(actor.shelf), object },
        orderBy: { createdAt: "asc" },
        take: model.MAX_WORKFLOWS
    })) as StoredWorkflow[];
    return rows.flatMap((row) => toView(row) ?? []);
}

/** Check what the actions name against the shelf, refusing what cannot run:
 *  an action its trigger cannot give it a record for, a field that is not
 *  there, a record made without its name, a kind of record the reader may not
 *  change. */
async function checkActions(
    actor: CrmActor,
    object: CrmObject,
    trigger: model.WorkflowTrigger,
    actions: readonly model.WorkflowAction[]
): Promise<void> {
    const t = await crmT();
    if (trigger.kind === "fieldChanged") {
        const custom = await loadFields(actor.shelf, object);
        if (!fieldsOf(object, custom).some((field) => field.key === trigger.field)) {
            throw new CrmRefusal(t("errors.unknownField"));
        }
    }
    for (const action of actions) {
        if (!model.actionFits(action.kind, trigger.kind)) {
            throw new CrmRefusal(t("workflows.actionNeedsRecord"));
        }
        if (action.kind === "updateRecord" || action.kind === "createRecord") {
            const target = action.kind === "createRecord" ? action.object : object;
            await requireCan(actor, target, "edit");
            const custom = await loadFields(actor.shelf, target);
            for (const key of Object.keys(action.values)) {
                if (!writable(target, key, custom)) throw new CrmRefusal(t("errors.unknownField"));
            }
            if (action.kind === "createRecord" && !(primaryField(target).key in action.values)) {
                throw new CrmRefusal(t("workflows.createNeedsName"));
            }
        }
        if (action.kind === "createTask") {
            const lists = (await host.crmHost.taskListsFor(who(actor))) ?? [];
            if (!lists.some((list: { id: string }) => list.id === action.listId)) {
                throw new CrmRefusal(t("workflows.noList"));
            }
        }
        if (action.kind === "notify") {
            const people = new Set((await records.shelfPeople(actor)).map((person) => person.id));
            const custom = await loadFields(actor.shelf, object);
            for (const to of action.to) {
                const ok = to.startsWith(model.FIELD_RECIPIENT)
                    ? fieldsOf(object, custom).some(
                          (field) =>
                              field.kind === "member" &&
                              field.key === to.slice(model.FIELD_RECIPIENT.length)
                      )
                    : people.has(to);
                if (!ok) throw new CrmRefusal(t("workflows.notOnShelf"));
            }
        }
    }
}

/** Make a workflow, or change one on the reader's shelf. It runs as them from
 *  now on. */
export async function saveWorkflow(
    actor: CrmActor,
    object: CrmObject,
    input: model.WorkflowInput
): Promise<model.SavedWorkflow> {
    await requireCan(actor, object, "edit");
    const t = await crmT();
    const parsed = model.workflowInputSchema.safeParse(input);
    if (!parsed.success) throw new CrmRefusal(t("errors.checkInput"));
    const { id, name, trigger, actions, enabled, newHookSecret } = parsed.data;
    await checkActions(actor, object, trigger, actions);
    const data = {
        name,
        nextRunAt: model.nextScheduledRun(trigger, new Date()),
        trigger: JSON.stringify(trigger),
        actions: JSON.stringify(actions),
        enabled,
        runAsId: actor.user.id,
        lastError: null
    };
    const where = { ...shelfWhere(actor.shelf), object };
    // A webhook keeps its address across saves; it gets one when it has none,
    // a new one when asked, and loses it when it stops being a webhook.
    let secret: string | null = null;
    const hook = (had: string | null): { hookHash?: string | null } => {
        if (trigger.kind !== "webhook") return { hookHash: null };
        if (had && !newHookSecret) return {};
        secret = randomBytes(24).toString("base64url");
        return { hookHash: hookHash(secret) };
    };
    let row: StoredWorkflow;
    if (id) {
        const found = (await prisma.crmWorkflow.findFirst({
            where: { id, ...where }
        })) as (StoredWorkflow & { hookHash?: string | null }) | null;
        if (!found) throw new CrmRefusal(t("errors.notFound"));
        row = (await prisma.crmWorkflow.update({
            where: { id },
            data: { ...data, ...hook(found.hookHash ?? null) }
        })) as StoredWorkflow;
    } else {
        const count = await prisma.crmWorkflow.count({ where });
        if (count >= model.MAX_WORKFLOWS) {
            throw new CrmRefusal(t("workflows.tooMany", { max: model.MAX_WORKFLOWS }));
        }
        row = (await prisma.crmWorkflow.create({
            data: { ...shelfData(actor.shelf), object, ...data, ...hook(null) }
        })) as StoredWorkflow;
    }
    const made = secret as string | null;
    return made
        ? { workflow: toView(row)!, hookPath: `/api/crm/hooks/${made}` }
        : { workflow: toView(row)! };
}

/** Switch a workflow on or off. */
export async function setWorkflowEnabled(
    actor: CrmActor,
    object: CrmObject,
    id: string,
    enabled: boolean
): Promise<void> {
    await requireCan(actor, object, "edit");
    const row = (await prisma.crmWorkflow.findFirst({
        where: { id, ...shelfWhere(actor.shelf), object }
    })) as StoredWorkflow | null;
    const trigger = row ? model.readTrigger(row.trigger) : null;
    // Switched back on, a schedule picks up from now rather than catching up on
    // every run it missed while off.
    const result = await prisma.crmWorkflow.updateMany({
        where: { id, ...shelfWhere(actor.shelf), object },
        data: {
            enabled,
            ...(enabled && trigger
                ? { nextRunAt: model.nextScheduledRun(trigger, new Date()) }
                : {})
        }
    });
    if (result.count === 0) throw new CrmRefusal((await crmT())("errors.notFound"));
}

/** Delete a workflow. What it already did stays done. */
export async function deleteWorkflow(
    actor: CrmActor,
    object: CrmObject,
    id: string
): Promise<void> {
    await requireCan(actor, object, "edit");
    await prisma.crmWorkflow.deleteMany({ where: { id, ...shelfWhere(actor.shelf), object } });
}

/**
 * Whoever a workflow runs as, on its shelf, with what their role lets them do
 * there now - or null when that person is gone, may no longer use the CRM, or
 * the shelf is somebody else's own.
 */
async function runnerOf(workflow: StoredWorkflow): Promise<CrmActor | null> {
    if (!workflow.runAsId) return null;
    if (!workflow.orgId && workflow.userId !== workflow.runAsId) return null;
    const user = await host.crmHost.crmRunner(workflow.runAsId);
    if (!user) return null;
    return actorOn(user, workflow.orgId, null);
}

/** Somebody, as the hosts that do not need their whole session take them. */
const who = (actor: CrmActor) => ({ id: actor.user.id, isAdmin: actor.user.isAdmin });

/** The task lists and people a workflow's actions may name. */
export async function workflowOptions(actor: CrmActor): Promise<model.WorkflowOptions> {
    const [lists, people] = await Promise.all([
        host.crmHost.taskListsFor(who(actor)),
        records.shelfPeople(actor)
    ]);
    return {
        taskLists: (lists ?? []).map((list: { id: string; name: string; spaceName: string }) => ({
            id: list.id,
            name: list.name,
            spaceName: list.spaceName
        })),
        people: people.map((person) => ({ id: person.id, name: person.name }))
    };
}

/** The record a run is about, read as the runner, or null. */
async function recordOf(runner: CrmActor, context: RunContext): Promise<CrmRecord | null> {
    if (!context.recordId) return null;
    return records.getRecord(runner, context.object, context.recordId).catch(() => null);
}

/** Problems with a value an action wrote, as the sentence a refusal shows. */
async function problemText(
    runner: CrmActor,
    object: CrmObject,
    problems: readonly RowProblem[]
): Promise<string> {
    const t = await crmT();
    const custom = await loadFields(runner.shelf, object).catch(() => []);
    return problems
        .map((problem) => {
            const field = fieldsOf(object, custom).find((one) => one.key === problem.key);
            return t("errors.invalidValue", {
                field:
                    field?.label ?? t(`fields.${object}.${problem.key}` as Parameters<typeof t>[0]),
                reason: t(`invalid.${problem.reason}` as Parameters<typeof t>[0])
            });
        })
        .join(" ");
}

/** An action's values, filled from the record the run is about. */
async function filled(
    runner: CrmActor,
    context: RunContext,
    values: Readonly<Record<string, string>>
): Promise<{ keys: string[]; cells: string[]; record: CrmRecord | null }> {
    const record = await recordOf(runner, context);
    const fields = record
        ? fieldsOf(context.object, await loadFields(runner.shelf, context.object))
        : [];
    const keys = Object.keys(values);
    const cells = keys.map((key) =>
        model.renderTemplate(values[key]!, fields, record?.values ?? {}, context.body)
    );
    return { keys, cells, record };
}

/** One action, done as the runner. */
async function runAction(
    runner: CrmActor,
    workflow: StoredWorkflow,
    action: model.WorkflowAction,
    context: RunContext
): Promise<void> {
    const t = await crmT();
    switch (action.kind) {
        case "updateRecord": {
            if (!context.recordId) throw new CrmRefusal(t("workflows.actionNeedsRecord"));
            const { keys, cells } = await filled(runner, context, action.values);
            const read = await readRows(
                runner,
                context.object,
                { mapping: keys, rows: [cells] },
                false
            );
            const [values] = read.values;
            if (!values) {
                throw new CrmRefusal(
                    await problemText(runner, context.object, read.failed[0]?.problems ?? [])
                );
            }
            await records.updateRecord(runner, context.object, context.recordId, values);
            return;
        }
        case "createRecord": {
            const { keys, cells } = await filled(runner, context, action.values);
            const made = await importRecords(
                runner,
                action.object,
                { mapping: keys, rows: [cells] },
                "created"
            );
            if (made.created === 0) {
                throw new CrmRefusal(
                    await problemText(runner, action.object, made.failed[0]?.problems ?? [])
                );
            }
            return;
        }
        case "httpRequest": {
            const record = await recordOf(runner, context);
            const fields = record
                ? fieldsOf(context.object, await loadFields(runner.shelf, context.object))
                : [];
            const sent = await host.crmHost.crmPostJson(
                action.url,
                JSON.stringify({
                    workflow: { id: workflow.id, name: workflow.name },
                    object: context.object,
                    event: context.event?.kind ?? model.readTrigger(workflow.trigger)?.kind ?? null,
                    record: record
                        ? {
                              id: record.id,
                              fields: Object.fromEntries(
                                  fields.map((field) => [
                                      field.key,
                                      csvValue(field, record.values[field.key])
                                  ])
                              )
                          }
                        : null,
                    body: context.body
                })
            );
            if ("failed" in sent) {
                throw new CrmRefusal(
                    t(
                        sent.failed === "address"
                            ? "workflows.requestRefused"
                            : "workflows.requestUnreachable"
                    )
                );
            }
            if (sent.status < 200 || sent.status >= 300) {
                throw new CrmRefusal(t("workflows.requestFailed", { status: sent.status }));
            }
            return;
        }
        case "createTask": {
            const { cells, record } = await filled(runner, context, { name: action.name });
            const day =
                action.dueInDays === null
                    ? null
                    : new Date(Date.now() + action.dueInDays * 86_400_000)
                          .toISOString()
                          .slice(0, 10);
            const made = await host.crmHost.createTask(who(runner), {
                listId: action.listId,
                name: cells[0]!.trim() || action.name,
                due: dueAt(day)
            });
            if ("refused" in made) throw new CrmRefusal(made.refused || t("activities.tasksOff"));
            if (record && !record.deletedAt) {
                await addLink(runner, context.object, record.id, "task", made.id);
            }
            return;
        }
        case "notify": {
            const { cells, record } = await filled(runner, context, {
                title: action.title,
                body: action.body
            });
            const people = new Set((await records.shelfPeople(runner)).map((person) => person.id));
            const to = new Set<string>();
            for (const one of action.to) {
                if (!one.startsWith(model.FIELD_RECIPIENT)) {
                    to.add(one);
                    continue;
                }
                const named = record?.values[one.slice(model.FIELD_RECIPIENT.length)];
                if (named && typeof named === "object" && "id" in named) to.add(named.id);
            }
            for (const userId of to) {
                if (!people.has(userId)) continue;
                await host.notificationService.createNotification({
                    userId,
                    type: "crm.workflow",
                    title: cells[0]!.trim() || action.title,
                    body: cells[1]!.trim() || null,
                    href: record ? recordHref(context.object, record.id) : null,
                    shelf: runner.shelf.orgId ?? "personal"
                });
            }
            return;
        }
    }
}

/** What a failure says on the workflow: a refusal as it was worded, anything
 *  else as a sentence that names nothing internal. */
async function failureText(caught: unknown): Promise<string> {
    if (caught instanceof CrmRefusal) return caught.message.slice(0, ERROR_MAX);
    console.error("crm: a workflow failed", caught);
    return (await crmT())("errors.generic");
}

/** Run one workflow to the end or its first failure, and note how it went. */
export async function runWorkflow(
    workflow: StoredWorkflow,
    context: RunContext
): Promise<string | null> {
    let lastError: string | null = null;
    try {
        const runner = await runnerOf(workflow);
        if (!runner) throw new CrmRefusal((await crmT())("workflows.noRunner"));
        await withinWorkflow(async () => {
            for (const action of model.readActions(workflow.actions)) {
                await runAction(runner, workflow, action, context);
            }
        });
    } catch (caught) {
        lastError = await failureText(caught);
    }
    await prisma.crmWorkflow.update({
        where: { id: workflow.id },
        data: { runCount: { increment: 1 }, lastRunAt: new Date(), lastError }
    });
    return lastError;
}

/** The workflows a kind of record can be run through by hand, for its page. */
export async function listManualWorkflows(
    actor: CrmActor,
    object: CrmObject
): Promise<{ id: string; name: string }[]> {
    await requireCan(actor, object, "edit");
    const rows = (await prisma.crmWorkflow.findMany({
        where: { ...shelfWhere(actor.shelf), object, enabled: true },
        orderBy: { name: "asc" },
        take: model.MAX_WORKFLOWS
    })) as StoredWorkflow[];
    return rows
        .filter((row) => model.readTrigger(row.trigger)?.kind === "manual")
        .map((row) => ({ id: row.id, name: row.name }));
}

/**
 * Run a manual workflow on a record, for somebody who may change that record.
 * It runs as whoever saved it, like any other run; the answer says whether it
 * failed and why.
 */
export async function runManualWorkflow(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    workflowId: string
): Promise<{ error: string | null }> {
    await requireCan(actor, object, "edit");
    const t = await crmT();
    const row = (await prisma.crmWorkflow.findFirst({
        where: { id: workflowId, ...shelfWhere(actor.shelf), object, enabled: true }
    })) as StoredWorkflow | null;
    if (!row || model.readTrigger(row.trigger)?.kind !== "manual") {
        throw new CrmRefusal(t("workflows.gone"));
    }
    const record = await records.getRecord(actor, object, recordId);
    if (!record || record.deletedAt) throw new CrmRefusal(t("errors.notFound"));
    return { error: await runWorkflow(row, { object, recordId, event: null }) };
}

/**
 * What the timeline just logged, handed to the workflows it sets off. Called
 * for every logged change; reads nothing when the change can set nothing off,
 * and nothing at all from inside a workflow's own run.
 */
export async function onRecordEvents(
    actor: CrmActor,
    object: CrmObject,
    logged: readonly NewEvent[]
): Promise<void> {
    if (running.getStore()) return;
    const events = model.eventsOf(logged);
    if (events.length === 0) return;
    const rows = (await prisma.crmWorkflow.findMany({
        where: { ...shelfWhere(actor.shelf), object, enabled: true },
        take: model.MAX_WORKFLOWS
    })) as StoredWorkflow[];
    if (rows.length === 0) return;
    const fields = fieldsOf(object, await loadFields(actor.shelf, object));
    for (const row of rows) {
        const trigger = model.readTrigger(row.trigger);
        if (!trigger) continue;
        for (const event of events) {
            if (!model.triggerMatches(trigger, event, fields)) continue;
            await runWorkflow(row, { object, recordId: event.recordId, event });
        }
    }
}

/** The most scheduled runs one pass starts. The rest wait a minute. */
const SCHEDULE_BATCH = 50;

/**
 * Run the scheduled workflows that are due, once each. A run is claimed by
 * moving its next run on before it starts, so two passes never both start it;
 * a missed run is not caught up on - the next is counted from now. Returns how
 * many ran.
 */
export async function runDueSchedules(now: Date = new Date()): Promise<number> {
    const rows = (await prisma.crmWorkflow.findMany({
        where: { enabled: true, nextRunAt: { lte: now } },
        orderBy: { nextRunAt: "asc" },
        take: SCHEDULE_BATCH
    })) as (StoredWorkflow & { nextRunAt: Date })[];
    let ran = 0;
    for (const row of rows) {
        const trigger = model.readTrigger(row.trigger);
        const next = trigger ? model.nextScheduledRun(trigger, now) : null;
        const claimed = await prisma.crmWorkflow.updateMany({
            where: { id: row.id, nextRunAt: row.nextRunAt },
            data: { nextRunAt: next }
        });
        if (claimed.count === 0 || trigger?.kind !== "schedule") continue;
        await runWorkflow(row, { object: row.object as CrmObject, recordId: null, event: null });
        ran += 1;
    }
    return ran;
}

/** What an outside call to a webhook address came to. */
export type HookAnswer = "unknown" | "badBody" | { readonly error: string | null };

/**
 * An outside call to a webhook address: the enabled webhook workflow its
 * secret names, run with the call's body read as JSON (an empty body is
 * nothing). Nothing about the workflow - not even whether its body would have
 * read - is told to a caller whose address names none.
 */
export async function runHook(secret: string, text: string): Promise<HookAnswer> {
    const row = (await prisma.crmWorkflow.findFirst({
        where: { hookHash: hookHash(secret), enabled: true }
    })) as StoredWorkflow | null;
    if (!row || model.readTrigger(row.trigger)?.kind !== "webhook") return "unknown";
    let body: unknown = null;
    if (text.trim() !== "") {
        try {
            body = JSON.parse(text);
        } catch {
            return "badBody";
        }
    }
    return {
        error: await runWorkflow(row, {
            object: row.object as CrmObject,
            recordId: null,
            event: null,
            body
        })
    };
}
