/**
 * Places' node types in the central automations engine: what each is called,
 * what it is set to, and what role it plays.
 *
 * A node's config is the Places block it stands for - the same schema the
 * Places editor wrote - plus the place it belongs to, so every trigger,
 * condition and step keeps exactly the meaning it had: a set's any or all, a
 * room or a floor read again each time, "for at least", the sun, "Triggered
 * by" (which reads the trigger node ids, the old trigger ids kept as they were).
 *
 * Pure and client-safe: the converter, the server nodes and the editor read it.
 */

import { z } from "zod";
import * as auto from "./automation-kinds";

/** The catalog id: an app's node types start with it (`<app>.<role>.<name>`). */
export const NODE_APP = "home";

const placeId = z.string().uuid();

export const TRIGGER_NODE_KINDS = [
    "time",
    "interval",
    "change",
    "stays",
    "threshold",
    "sun"
] as const satisfies readonly auto.TriggerKind[];
export type TriggerNodeKind = (typeof TRIGGER_NODE_KINDS)[number];

export const STEP_NODE_KINDS = [
    "device",
    "wait",
    "notify",
    "run"
] as const satisfies readonly auto.StepKind[];
export type StepNodeKind = (typeof STEP_NODE_KINDS)[number];

export function triggerNodeType(kind: TriggerNodeKind): string {
    return `${NODE_APP}.trigger.${kind}`;
}

export function stepNodeType(kind: StepNodeKind): string {
    return `${NODE_APP}.action.${kind}`;
}

export const CONDITION_NODE_TYPE = `${NODE_APP}.condition.check`;

function variant<K extends string>(
    union: { optionsMap: Map<unknown, z.ZodObject<z.ZodRawShape>> },
    kind: K
): z.ZodObject<z.ZodRawShape> {
    const found = union.optionsMap.get(kind);
    if (!found) throw new Error(`no Places block of kind ${kind}`);
    return found;
}

/** A trigger node's config: the Places trigger without its id (the node's id is it), and its place. */
export function triggerNodeConfig(kind: TriggerNodeKind) {
    return variant(auto.triggerSchema as never, kind)
        .omit({ id: true })
        .extend({ placeId });
}

/** The conditions node: the whole Places conditions block, groups and all. */
export const conditionNodeConfig = z.object({
    placeId,
    match: z.enum(["all", "any"]),
    groups: z.array(auto.conditionGroupSchema).min(1).max(auto.LIMITS.groups)
});
export type ConditionNodeConfig = z.infer<typeof conditionNodeConfig>;

/** A step node's config: the Places step without its id, and its place. "Run another" names a central automation. */
export function stepNodeConfig(kind: StepNodeKind) {
    return variant(auto.actionSchema as never, kind)
        .omit({ id: true })
        .extend({ placeId });
}

/** The Places trigger a node's config stands for, its id the node's. */
export function triggerOfNode(nodeId: string, config: unknown): auto.Trigger | null {
    const parsed = auto.triggerSchema.safeParse({ ...(config as object), id: nodeId });
    return parsed.success ? parsed.data : null;
}

/** The Places step a node's config stands for. */
export function stepOfNode(nodeId: string, config: unknown): auto.Step | null {
    const parsed = auto.actionSchema.safeParse({ ...(config as object), id: nodeId });
    return parsed.success ? parsed.data : null;
}

/** Every Places node type, for the registry and the boundary tests. */
export const PLACES_NODE_TYPES = [
    ...TRIGGER_NODE_KINDS.map(triggerNodeType),
    CONDITION_NODE_TYPE,
    ...STEP_NODE_KINDS.map(stepNodeType)
];
