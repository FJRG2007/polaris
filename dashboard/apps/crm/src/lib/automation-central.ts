/**
 * The CRM in the central automations engine: the node types it contributes,
 * and the bridge that hands record changes, schedules, webhook calls and
 * "Run on this record" to the automations whose CRM trigger they match.
 *
 * Nothing is re-implemented. A step runs an action with the same function a
 * workflow ran it with, as the automation's run-as account on the node's shelf,
 * with what that account may do there at the moment it runs - never more than
 * they could do by hand.
 *
 * Server-only.
 */

import { loadFields } from "./fields";
import { randomUUID } from "node:crypto";
import * as workflows from "./workflows";
import * as model from "../model/workflows";
import type { ZodType, ZodTypeDef } from "zod";
import * as nodes from "../model/automation-nodes";
import { host, type AppHostTypes } from "@polaris/app-host";
import { fieldsOf, type CrmObject } from "../model/objects";
import { actorOn, requireCan, type CrmActor } from "./access";

type AnyServerNode = Awaited<
    ReturnType<NonNullable<AppHostTypes["AppExtension"]["automationNodes"]>>
>[number];
type NodeRun = NonNullable<AnyServerNode["run"]>;
/** The engine's node with its config typed, as the dashboard declares it. */
type ServerNode<Config = unknown> = Omit<AnyServerNode, "config" | "run"> & {
    readonly config: ZodType<Config, ZodTypeDef, unknown>;
    readonly run?: (
        config: Config,
        context: Parameters<NodeRun>[1],
        io: Parameters<NodeRun>[2]
    ) => ReturnType<NodeRun>;
};

/** The engine's step errors, read when used: the module loads before the host is wired. */
const stepRefusal = (code: string) => new host.automations.StepRefusal(code);
const stepError = (code: string, details: Record<string, unknown>) =>
    new host.automations.StepError(code, details);

/** The wait key a "wait until the record matches" step rechecks under; woken on every record change. */
export const RECHECK_KEY = "recheck:crm";

/** How often a waiting step looks again with no record change to wake it. */
const RECHECK_MS = 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** The run-as account on a node's shelf, held to what they may do with its records now. */
async function runnerFor(
    actorId: string,
    orgId: string | null,
    object: CrmObject,
    verb: "read" | "edit"
): Promise<CrmActor> {
    const user = await host.crmHost.crmRunner(actorId);
    if (!user) throw stepRefusal("crmRunner");
    const runner = await actorOn(user, orgId, null);
    await requireCan(runner, object, verb).catch(() => {
        throw stepRefusal("crmForbidden");
    });
    return runner;
}

/** The record and change a run is about, as the CRM engine reads them. */
function contextOf(object: CrmObject, trigger: Record<string, unknown>): workflows.RunContext {
    const cause = nodes.causeOf(trigger);
    if (!cause || cause.object !== object) return { object, recordId: null, event: null };
    return { object, recordId: cause.recordId, event: cause.event, body: cause.body };
}

/** A CRM refusal is the sentence the run shows; anything else is said without internals. */
async function asStepError(caught: unknown): Promise<never> {
    if (caught instanceof host.automations.StepError) throw caught;
    throw stepError("crmActionFailed", { said: await workflows.failureText(caught) });
}

const triggerNode: ServerNode<nodes.TriggerNodeConfig> = {
    type: nodes.TRIGGER_NODE_TYPE,
    meta: { role: "trigger", ports: [], idempotent: true } as never,
    config: nodes.triggerNodeConfig
};

const conditionNode: ServerNode<nodes.ConditionNodeConfig> = {
    type: nodes.CONDITION_NODE_TYPE,
    meta: { role: "condition", ports: ["then", "else"], idempotent: true } as never,
    config: nodes.conditionNodeConfig,
    run: async (config, context, io) => {
        const runner = await runnerFor(io.actor.id, config.orgId, config.object, "read");
        const run = contextOf(config.object, context.trigger);
        io.recordInput({ object: config.object, recordId: run.recordId });
        const holds = await workflows.centralMatches(runner, run, config.when).catch(asStepError);
        // Nothing wired to "else": the run ends there, as a workflow's filter ended it.
        if (!holds && !io.leads("else")) return { stop: { as: "skipped", reason: "conditions" } };
        return { output: { holds }, port: holds ? "then" : "else" };
    }
};

function stepNode(kind: nodes.StepKind): ServerNode<nodes.StepNodeConfig> {
    return {
        type: nodes.stepNodeType(kind),
        meta: { role: "action", ports: [], idempotent: false } as never,
        config: nodes.stepNodeConfig(kind),
        run: async (config, context, io) => {
            const runner = await runnerFor(io.actor.id, config.orgId, config.object, "edit");
            const run = contextOf(config.object, context.trigger);
            io.recordInput({ object: config.object, recordId: run.recordId, do: kind });
            await workflows
                .centralAction(runner, context.automation, config.action, run)
                .catch(asStepError);
            return { output: { done: kind, recordId: run.recordId } };
        }
    };
}

const waitNode: ServerNode<nodes.WaitNodeConfig> = {
    type: nodes.WAIT_NODE_TYPE,
    meta: { role: "action", ports: [], idempotent: true } as never,
    config: nodes.waitNodeConfig,
    run: async (config, context, io) => {
        const runner = await runnerFor(io.actor.id, config.orgId, config.object, "read");
        const run = contextOf(config.object, context.trigger);
        const deadline = io.since.getTime() + config.days * DAY_MS;
        io.recordInput({ recordId: run.recordId, until: new Date(deadline).toISOString() });
        if (await workflows.centralMatches(runner, run, config.when).catch(asStepError))
            return { output: { matched: true, timedOut: false } };
        const now = Date.now();
        if (now < deadline)
            return {
                wait: { until: new Date(Math.min(deadline, now + RECHECK_MS)), recheck: RECHECK_KEY }
            };
        return config.onTimeout === "stop"
            ? { stop: { as: "succeeded", reason: "timedOut" } }
            : { output: { matched: false, timedOut: true } };
    }
};

/** Every node type the CRM contributes. */
export function crmAutomationNodes(): ServerNode[] {
    return [
        triggerNode as ServerNode,
        conditionNode as ServerNode,
        ...nodes.STEP_KINDS.map((kind) => stepNode(kind) as ServerNode),
        waitNode as ServerNode
    ];
}

/** One armed CRM trigger, its config read. */
interface ArmedTrigger {
    readonly automationId: string;
    readonly nodeId: string;
    readonly name: string;
    readonly runAsId: string | null;
    readonly armedAt: Date;
    readonly config: nodes.TriggerNodeConfig;
}

/** Every armed CRM trigger of a published, enabled automation. */
export async function armedTriggers(): Promise<ArmedTrigger[]> {
    const rows = await host.automations.appTriggers(nodes.CRM_NODE_APP);
    return rows.flatMap((row) => {
        if (row.type !== nodes.TRIGGER_NODE_TYPE) return [];
        const config = nodes.triggerNodeConfig.safeParse(row.config);
        return config.success
            ? [
                  {
                      automationId: row.automationId,
                      nodeId: row.nodeId,
                      name: row.name,
                      runAsId: row.runAsId,
                      armedAt: row.armedAt,
                      config: config.data
                  }
              ]
            : [];
    });
}

/** Whether a trigger is about the records of this shelf: an organization's, or its run-as account's own. */
function onShelf(trigger: ArmedTrigger, actor: CrmActor, object: CrmObject): boolean {
    if (trigger.config.object !== object) return false;
    if (trigger.config.orgId !== actor.shelf.orgId) return false;
    return actor.shelf.orgId !== null || trigger.runAsId === actor.shelf.userId;
}

function fire(
    trigger: ArmedTrigger,
    firingKey: string,
    cause: nodes.CrmCause,
    depth = 0
): Promise<boolean> {
    return host.automations.fireAppTrigger({
        automationId: trigger.automationId,
        nodeId: trigger.nodeId,
        firingKey,
        cause: { kind: cause.event?.kind ?? trigger.config.trigger.kind, [nodes.CAUSE_KEY]: cause },
        depth
    });
}

/**
 * Record changes the timeline just logged, handed to the automations whose CRM
 * trigger they match - once each, since every change is fired from here alone.
 * Changes a run makes itself set nothing off; they only wake the steps waiting
 * for a record to match.
 */
export async function fireRecordEvents(
    actor: CrmActor,
    object: CrmObject,
    events: readonly model.RecordEvent[],
    inRun: boolean
): Promise<void> {
    if (events.length === 0) return;
    if (!inRun) {
        const armed = (await armedTriggers()).filter((trigger) => onShelf(trigger, actor, object));
        if (armed.length > 0) {
            const fields = fieldsOf(object, await loadFields(actor.shelf, object));
            for (const trigger of armed)
                for (const event of events) {
                    if (!model.triggerMatches(trigger.config.trigger, event, fields)) continue;
                    await fire(trigger, `${event.kind}:${event.recordId}:${randomUUID()}`, {
                        object,
                        recordId: event.recordId,
                        event
                    });
                }
        }
    }
    await host.automations.wakeAppWaits(nodes.CRM_NODE_APP);
}

/** The minute `now` falls in. */
function minuteOf(now: Date): Date {
    return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

/**
 * The schedules due this minute, fired once each: the firing is keyed by the
 * minute, so a second pass in the same minute starts nothing. A minute missed
 * is not caught up on, as a workflow's schedule never was.
 */
export async function fireDueSchedules(now: Date = new Date()): Promise<number> {
    const minute = minuteOf(now);
    let fired = 0;
    for (const trigger of await armedTriggers()) {
        const schedule = trigger.config.trigger;
        if (schedule.kind !== "schedule" || trigger.armedAt > minute) continue;
        const next = model.nextScheduledRun(schedule, new Date(minute.getTime() - 1));
        if (next?.getTime() !== minute.getTime()) continue;
        const started = await fire(trigger, `schedule:${minute.toISOString()}`, {
            object: trigger.config.object,
            recordId: null,
            event: null
        });
        if (started) fired += 1;
    }
    return fired;
}

/** A call to the address of a workflow that moved: its automation runs with the body. */
export async function fireHook(
    automationId: string,
    object: CrmObject,
    body: unknown
): Promise<boolean> {
    const trigger = (await armedTriggers()).find(
        (one) => one.automationId === automationId && one.config.trigger.kind === "webhook"
    );
    if (!trigger) return false;
    return fire(trigger, `hook:${randomUUID()}`, { object, recordId: null, event: null, body });
}

/** The automations "Run on this record" offers for a kind of record on the reader's shelf. */
export async function manualAutomations(
    actor: CrmActor,
    object: CrmObject
): Promise<{ id: string; name: string }[]> {
    return (await armedTriggers())
        .filter((trigger) => trigger.config.trigger.kind === "manual" && onShelf(trigger, actor, object))
        .map((trigger) => ({ id: trigger.automationId, name: trigger.name }));
}

/** Run one of them on a record. False when it is gone, switched off or held back. */
export async function runManualAutomation(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    automationId: string
): Promise<boolean | null> {
    const trigger = (await armedTriggers()).find(
        (one) =>
            one.automationId === automationId &&
            one.config.trigger.kind === "manual" &&
            onShelf(one, actor, object)
    );
    if (!trigger) return null;
    return fire(trigger, `manual:${randomUUID()}`, { object, recordId, event: null });
}
