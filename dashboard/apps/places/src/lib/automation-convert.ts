/**
 * A Places automation as a central automations graph.
 *
 * Pure. Every id is kept: a trigger's id becomes its node's id, so a
 * "Triggered by" condition still names the triggers it named, and a firing's
 * cause carries the same trigger id it always did. The steps become one chain
 * in their order; the conditions one node in front of it, whose "else" leads
 * nowhere - the run ends there, as a Places run whose conditions failed.
 *
 * Read with the Places schema itself, so every shape the Places engine could
 * run (a block from before targets, two levels of groups) converts, and a shape
 * it could not run is refused rather than guessed at.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import * as auto from "./automation-kinds";
import * as nodes from "./automation-nodes";

export interface LegacyAutomation {
    readonly id: string;
    readonly placeId: string;
    readonly definition: unknown;
}

export type Converted =
    | { readonly ok: true; readonly graph: core.AutomationGraph }
    | { readonly ok: false; readonly reason: "unreadable" | "invalid" };

type GraphNode = core.AutomationGraph["nodes"][number];

function base(block: { alias?: string; note?: string }): Pick<GraphNode, "alias" | "note"> {
    return {
        ...(block.alias ? { alias: block.alias } : {}),
        ...(block.note ? { note: block.note } : {})
    };
}

function without<T extends { id: string; alias?: string; note?: string }>(block: T) {
    const { id: _id, alias: _alias, note: _note, ...rest } = block;
    return rest;
}

function triggerNode(trigger: auto.Trigger, placeId: string): GraphNode {
    if (trigger.kind === "manual")
        return {
            id: trigger.id,
            type: "core.manual",
            typeVersion: 1,
            config: {},
            ...base(trigger)
        };
    return {
        id: trigger.id,
        type: nodes.triggerNodeType(trigger.kind),
        typeVersion: 1,
        config: { ...without(trigger), placeId },
        ...base(trigger)
    };
}

function stepNode(step: auto.Step, placeId: string): GraphNode {
    if (step.kind === "delay")
        return {
            id: step.id,
            type: "core.wait",
            typeVersion: 1,
            config: { kind: "duration", duration: core.durationOf(step.seconds) },
            ...base(step)
        };
    return {
        id: step.id,
        type: nodes.stepNodeType(step.kind),
        typeVersion: 1,
        config: { ...without(step), placeId },
        ...base(step)
    };
}

export function convertPlaceAutomation(row: LegacyAutomation): Converted {
    const parsed = auto.definitionSchema.safeParse(row.definition);
    if (!parsed.success) return { ok: false, reason: "unreadable" };
    const checked = core.automationGraphSchema.safeParse(assemble(parsed.data, row.placeId));
    if (!checked.success || core.graphProblems(checked.data, { forPublish: true }).length > 0)
        return { ok: false, reason: "invalid" };
    return { ok: true, graph: checked.data };
}

/** The block shapes a draft must have to be laid out; each block's own fields are the editor's to check. */
const draftBlock = (kinds: readonly string[]) =>
    z
        .object({
            id: z.string().min(1).max(64),
            kind: z.string().refine((kind) => kinds.includes(kind))
        })
        .passthrough();
const draftDefinition = z.object({
    timeZone: z.string().min(1).max(64),
    triggers: z.array(draftBlock(auto.TRIGGER_KINDS)).max(50),
    conditions: z
        .object({
            match: z.enum(["all", "any"]),
            groups: z.array(z.object({ id: z.string().min(1).max(64) }).passthrough()).max(20)
        })
        .default({ match: "all", groups: [] }),
    actions: z.array(draftBlock(auto.STEP_KINDS)).max(100)
});

/**
 * A template or a blank Places start as a central draft, before anything in it
 * is filled in: laid out exactly as a saved one converts, but not required to
 * be publishable, so a step still waiting for its device opens in the central
 * editor with that field marked rather than being refused. Null when the input
 * is not a Places definition at all.
 */
export function draftGraph(placeId: string, definition: unknown): core.AutomationGraph | null {
    const parsed = draftDefinition.safeParse(definition);
    if (!parsed.success) return null;
    let graph: core.AutomationGraph;
    try {
        graph = assemble(parsed.data as unknown as auto.AutomationDefinition, placeId);
    } catch {
        return null;
    }
    const checked = core.automationGraphSchema.safeParse(graph);
    return checked.success ? checked.data : null;
}

function assemble(definition: auto.AutomationDefinition, placeId: string): core.AutomationGraph {
    const graph = core.emptyGraph(definition.timeZone);
    const edges: core.AutomationGraph["edges"] = [];
    const link = (from: string, port: string, to: string) =>
        edges.push({ from: { node: from, port }, to: { node: to } });

    const triggers = definition.triggers.map((trigger) => triggerNode(trigger, placeId));
    const steps = definition.actions.map((step) => stepNode(step, placeId));
    const groups = definition.conditions.groups;
    const condition: GraphNode | null =
        groups.length > 0
            ? {
                  id: groups[0]!.id,
                  type: nodes.CONDITION_NODE_TYPE,
                  typeVersion: 1,
                  config: {
                      placeId: placeId,
                      match: definition.conditions.match,
                      groups
                  }
              }
            : null;
    const first = condition ?? steps[0];
    if (first) for (const trigger of triggers) link(trigger.id, "next", first.id);
    if (condition && steps[0]) link(condition.id, "then", steps[0].id);
    for (let index = 1; index < steps.length; index++)
        link(steps[index - 1]!.id, "next", steps[index]!.id);

    graph.nodes = [...triggers, ...(condition ? [condition] : []), ...steps];
    graph.edges = edges;
    return graph;
}
