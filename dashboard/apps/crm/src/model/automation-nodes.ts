/**
 * The CRM's building blocks in the central automations engine, and how a CRM
 * workflow becomes an automation made of them.
 *
 * A node names the CRM shelf it works on (`orgId`, null for the run-as
 * account's own) and the kind of record it is about. Every action keeps the
 * shape a workflow saved it in, so the engine runs it with the same code a
 * workflow did.
 *
 * Pure and client-safe.
 */

import { z } from "zod";
import * as model from "./workflows";
import * as core from "@polaris/core";
import { filterSchema } from "./filters";
import { CRM_OBJECTS, type CrmObject } from "./objects";

/** The app id the CRM's node types start with. */
export const CRM_NODE_APP = "crm";

/** Prefix of a moved workflow's `legacyRef`. */
export const LEGACY_PREFIX = "crm-workflow:";

export const TRIGGER_NODE_TYPE = `${CRM_NODE_APP}.trigger.record`;
export const CONDITION_NODE_TYPE = `${CRM_NODE_APP}.condition.match`;
export const WAIT_NODE_TYPE = `${CRM_NODE_APP}.action.waitFor`;

/** The actions that each become a step of their own, in the order the picker offers them. */
export const STEP_KINDS = [...model.LEAF_KINDS, "forEach"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export function stepNodeType(kind: StepKind): string {
    return `${CRM_NODE_APP}.action.${kind}`;
}

/** The step kind a node type is, or null for any other node. */
export function stepKindOf(type: string): StepKind | null {
    const prefix = `${CRM_NODE_APP}.action.`;
    if (!type.startsWith(prefix)) return null;
    const kind = type.slice(prefix.length);
    return (STEP_KINDS as readonly string[]).includes(kind) ? (kind as StepKind) : null;
}

/** Every node type the CRM brings. */
export const CRM_NODE_TYPES: readonly string[] = [
    TRIGGER_NODE_TYPE,
    CONDITION_NODE_TYPE,
    ...STEP_KINDS.map(stepNodeType),
    WAIT_NODE_TYPE
];

const where = {
    orgId: z.string().uuid().nullable().default(null),
    object: z.enum(CRM_OBJECTS)
};

export const triggerNodeConfig = z.object({ ...where, trigger: model.workflowTriggerSchema });
export type TriggerNodeConfig = z.infer<typeof triggerNodeConfig>;

export const conditionNodeConfig = z.object({ ...where, when: filterSchema });
export type ConditionNodeConfig = z.infer<typeof conditionNodeConfig>;

export const waitNodeConfig = z.object({
    ...where,
    when: filterSchema,
    days: z.number().int().min(1).max(model.MAX_WAIT_DAYS),
    onTimeout: z.enum(model.WAIT_TIMEOUTS)
});
export type WaitNodeConfig = z.infer<typeof waitNodeConfig>;

/** A step's settings: the action, in the shape a workflow saved it, of the node's own kind. */
export function stepNodeConfig(kind: StepKind) {
    return z
        .object({ ...where, action: model.workflowActionSchema })
        .refine((config) => config.action.kind === kind, { message: "actionKind" });
}
export type StepNodeConfig = z.infer<ReturnType<typeof stepNodeConfig>>;

/** What a CRM trigger hands the run: the record and the change, read by every CRM step after it. */
export interface CrmCause {
    readonly object: CrmObject;
    readonly recordId: string | null;
    readonly event: model.RecordEvent | null;
    readonly body?: unknown;
}

/** The key a CRM firing's cause is kept under on the run's trigger. */
export const CAUSE_KEY = "crm";

/** The CRM cause of a run's trigger, or null when a trigger of another kind started it. */
export function causeOf(trigger: Record<string, unknown>): CrmCause | null {
    const cause = trigger[CAUSE_KEY];
    if (!cause || typeof cause !== "object") return null;
    const { object, recordId } = cause as Record<string, unknown>;
    if (!(CRM_OBJECTS as readonly unknown[]).includes(object)) return null;
    return {
        ...(cause as CrmCause),
        recordId: typeof recordId === "string" ? recordId : null
    };
}

/** A workflow as the move reads it. */
export interface LegacyWorkflow {
    readonly id: string;
    readonly orgId: string | null;
    readonly object: string;
    readonly trigger: string;
    readonly actions: string;
}

export type Converted =
    | { readonly ok: true; readonly graph: core.AutomationGraph }
    | { readonly ok: false; readonly reason: "unreadable" | "invalid" };

/** The automation a workflow becomes, or why it cannot become one yet. */
export function convertWorkflow(row: LegacyWorkflow): Converted {
    const object = z.enum(CRM_OBJECTS).safeParse(row.object);
    const trigger = model.readTrigger(row.trigger);
    if (!object.success || !trigger) return { ok: false, reason: "unreadable" };
    let actions: unknown;
    try {
        actions = JSON.parse(row.actions);
    } catch {
        return { ok: false, reason: "unreadable" };
    }
    const list = z.array(model.workflowActionSchema).safeParse(actions);
    if (!list.success) return { ok: false, reason: "unreadable" };
    const graph = workflowGraph(row.orgId, object.data, trigger, list.data);
    const checked = core.automationGraphSchema.safeParse(graph);
    if (!checked.success || core.graphProblems(checked.data, { forPublish: true }).length > 0)
        return { ok: false, reason: "invalid" };
    return { ok: true, graph: checked.data };
}

/** The ends a chain leaves open: each the node and the port the next node hangs from. */
type Ends = { readonly node: string; readonly port: string }[];

/**
 * A trigger and its actions as a graph, laid out as the workflow ran: one node
 * per action, a check's "then" going on and its "else" going the other way, and
 * both ways of an if/else meeting again at the action after it.
 */
export function workflowGraph(
    orgId: string | null,
    object: CrmObject,
    trigger: model.WorkflowTrigger,
    actions: readonly model.WorkflowAction[]
): core.AutomationGraph {
    const graph = core.emptyGraph(trigger.kind === "schedule" ? trigger.timeZone : "UTC");
    const nodes: core.GraphNode[] = [];
    const edges: core.AutomationGraph["edges"] = [];
    const add = (type: string, config: unknown): string => {
        const id = core.automationNodeId();
        nodes.push({ id, type, typeVersion: 1, config });
        return id;
    };
    const join = (ends: Ends, to: string) => {
        for (const end of ends) edges.push({ from: { node: end.node, port: end.port }, to: { node: to } });
    };
    const chain = (list: readonly model.WorkflowAction[], from: Ends): Ends => {
        let ends = from;
        for (const action of list) {
            if (action.kind === "filter") {
                const id = add(CONDITION_NODE_TYPE, { orgId, object, when: action.when });
                join(ends, id);
                // Nothing on "else": a record that does not match ends the run there.
                ends = [{ node: id, port: "then" }];
            } else if (action.kind === "ifElse") {
                const id = add(CONDITION_NODE_TYPE, { orgId, object, when: action.when });
                join(ends, id);
                ends = [
                    ...chain(action.then, [{ node: id, port: "then" }]),
                    ...chain(action.otherwise, [{ node: id, port: "else" }])
                ];
            } else if (action.kind === "delay") {
                const id = add("core.wait", {
                    kind: "duration",
                    duration: { amount: action.minutes, unit: "minutes" }
                });
                join(ends, id);
                ends = [{ node: id, port: "next" }];
            } else if (action.kind === "waitFor") {
                const { kind: _kind, ...rest } = action;
                const id = add(WAIT_NODE_TYPE, { orgId, object, ...rest });
                join(ends, id);
                ends = [{ node: id, port: "next" }];
            } else {
                const id = add(stepNodeType(action.kind), { orgId, object, action });
                join(ends, id);
                ends = [{ node: id, port: "next" }];
            }
        }
        return ends;
    };
    const first = add(TRIGGER_NODE_TYPE, { orgId, object, trigger });
    chain(actions, [{ node: first, port: "next" }]);
    graph.nodes = nodes;
    graph.edges = edges;
    return graph;
}
