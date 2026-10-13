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
import type { RowProblem } from "../model/import";
import { fieldsOf, primaryField, type CrmObject, type CrmRecord } from "../model/objects";
import { AsyncLocalStorage } from "node:async_hooks";
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
}

/** What a run knows about why it started. */
export interface RunContext {
    readonly object: CrmObject;
    /** The record it is about, when it is about one. */
    readonly recordId: string | null;
    readonly event: model.RecordEvent | null;
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
        lastError: row.lastError
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
    const { id, name, trigger, actions, enabled } = parsed.data;
    await checkActions(actor, object, trigger, actions);
    const data = {
        name,
        trigger: JSON.stringify(trigger),
        actions: JSON.stringify(actions),
        enabled,
        runAsId: actor.user.id,
        lastError: null
    };
    const where = { ...shelfWhere(actor.shelf), object };
    let row: StoredWorkflow;
    if (id) {
        const found = (await prisma.crmWorkflow.findFirst({
            where: { id, ...where }
        })) as StoredWorkflow | null;
        if (!found) throw new CrmRefusal(t("errors.notFound"));
        row = (await prisma.crmWorkflow.update({ where: { id }, data })) as StoredWorkflow;
    } else {
        const count = await prisma.crmWorkflow.count({ where });
        if (count >= model.MAX_WORKFLOWS) {
            throw new CrmRefusal(t("workflows.tooMany", { max: model.MAX_WORKFLOWS }));
        }
        row = (await prisma.crmWorkflow.create({
            data: { ...shelfData(actor.shelf), object, ...data }
        })) as StoredWorkflow;
    }
    return { workflow: toView(row)! };
}

/** Switch a workflow on or off. */
export async function setWorkflowEnabled(
    actor: CrmActor,
    object: CrmObject,
    id: string,
    enabled: boolean
): Promise<void> {
    await requireCan(actor, object, "edit");
    const result = await prisma.crmWorkflow.updateMany({
        where: { id, ...shelfWhere(actor.shelf), object },
        data: { enabled }
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
): Promise<{ keys: string[]; cells: string[] }> {
    const record = await recordOf(runner, context);
    const fields = record
        ? fieldsOf(context.object, await loadFields(runner.shelf, context.object))
        : [];
    const keys = Object.keys(values);
    const cells = keys.map((key) =>
        model.renderTemplate(values[key]!, fields, record?.values ?? {})
    );
    return { keys, cells };
}

/** One action, done as the runner. */
async function runAction(
    runner: CrmActor,
    _workflow: StoredWorkflow,
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
export async function runWorkflow(workflow: StoredWorkflow, context: RunContext): Promise<void> {
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
