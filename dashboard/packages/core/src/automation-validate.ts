/**
 * Everything worth telling the author about a graph before it is saved or
 * run, graded: an error blocks saving and publishing, a warning does not.
 *
 * It is `graphProblems` (structure, config) plus what reads wrong without
 * being malformed: steps nothing reaches, references to steps that are not
 * there or come later, a trigger the automation's own steps would fire again,
 * a call to itself, and conditions that can never hold. Calls that loop
 * through other saved automations need their graphs, so the server adds those
 * (`callCycle`); this function is pure and runs in the editor as you type.
 * The grading follows n8n's and Zapier's editors: broken wiring and missing
 * settings stop activation, style-level findings only flag the node.
 */

import * as graphs from "./automation-graph.js";
import { CORE_NODE_OUTPUT_PATHS } from "./automation-canvas.js";

export type IssueSeverity = "error" | "warning";

export type AutomationIssue = {
    readonly severity: IssueSeverity;
    readonly node?: string;
} & (
    | { readonly code: graphs.GraphProblem["code"]; readonly issue?: string; readonly port?: string }
    | { readonly code: "unreachable" }
    | { readonly code: "missingReference"; readonly reference: string }
    | { readonly code: "laterReference"; readonly reference: string }
    | { readonly code: "unknownOutput"; readonly reference: string }
    | { readonly code: "selfTrigger"; readonly trigger: string }
    | { readonly code: "selfCall" }
    | { readonly code: "contradiction" }
);

/**
 * A trigger that a step of the same automation fires again: an event the
 * automation announces itself, a record it updates while listening for
 * updates. `same` says whether this trigger and this step are about the
 * same thing. Apps add their own pairs through `automationIssues`' options.
 */
export interface SelfTriggerRule {
    readonly trigger: string;
    readonly step: string;
    readonly same: (triggerConfig: unknown, stepConfig: unknown) => boolean;
}

const eventNameOf = (config: unknown): unknown => (config as { name?: unknown } | null)?.name;

export const DEFAULT_SELF_TRIGGER_RULES: readonly SelfTriggerRule[] = [
    {
        trigger: "core.onEvent",
        step: "core.announce",
        same: (trigger, step) =>
            typeof eventNameOf(trigger) === "string" && eventNameOf(trigger) === eventNameOf(step)
    }
];

/** Nodes that check something before letting the run on: a guard against firing again. */
function isGuard(type: string): boolean {
    return (
        graphs.nodeRole(type) === "condition" ||
        type === "core.switch" ||
        type === "core.aiDecide" ||
        type === "core.stop"
    );
}

function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const entry of value) strings(entry, out);
    else if (value && typeof value === "object")
        for (const entry of Object.values(value)) strings(entry, out);
    return out;
}

/** Every node a node can be reached from, along edges. */
function ancestorsOf(graph: graphs.AutomationGraph): Map<string, Set<string>> {
    const into = new Map<string, string[]>();
    for (const edge of graph.edges)
        into.set(edge.to.node, [...(into.get(edge.to.node) ?? []), edge.from.node]);
    const out = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
        const seen = new Set<string>();
        const stack = [...(into.get(node.id) ?? [])];
        while (stack.length) {
            const at = stack.pop()!;
            if (seen.has(at)) continue;
            seen.add(at);
            stack.push(...(into.get(at) ?? []));
        }
        out.set(node.id, seen);
    }
    return out;
}

/** Whether `to` is reachable from `from` without passing through a guard. */
function unguardedPath(graph: graphs.AutomationGraph, from: string, to: string): boolean {
    const types = new Map(graph.nodes.map((node) => [node.id, node.type]));
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
        const at = stack.pop()!;
        if (at === to) return true;
        if (seen.has(at)) continue;
        seen.add(at);
        if (at !== from && isGuard(types.get(at) ?? "")) continue;
        for (const edge of graph.edges) if (edge.from.node === at) stack.push(edge.to.node);
    }
    return false;
}

const isLiteral = (value: string) => !value.includes("{{");

/** Whether every leaf of an "all" group can hold together; false means it never can. */
function canHold(group: graphs.ConditionGroup): boolean {
    if (group.negate || group.join !== "all") return true;
    const byLeft = new Map<string, graphs.CompareLeaf[]>();
    for (const item of group.items) {
        if (item.kind === "group") {
            if (!canHold(item)) return false;
            continue;
        }
        if (item.kind !== "compare" || !item.left.trim()) continue;
        const key = item.left.trim();
        byLeft.set(key, [...(byLeft.get(key) ?? []), item]);
    }
    for (const leaves of byLeft.values()) {
        const equals = new Set(
            leaves.filter((leaf) => leaf.op === "eq" && isLiteral(leaf.right)).map((leaf) => leaf.right)
        );
        if (equals.size > 1) return false;
        const ops = new Set(leaves.map((leaf) => leaf.op));
        if (ops.has("empty") && ops.has("notEmpty")) return false;
        for (const leaf of leaves)
            if (
                leaf.op === "ne" &&
                isLiteral(leaf.right) &&
                leaves.some((other) => other.op === "eq" && other.right === leaf.right)
            )
                return false;
        let low = -Infinity;
        let high = Infinity;
        let lowOpen = false;
        let highOpen = false;
        for (const leaf of leaves) {
            if (!isLiteral(leaf.right) || leaf.right.trim() === "") continue;
            const value = Number(leaf.right);
            if (!Number.isFinite(value)) continue;
            if ((leaf.op === "gt" || leaf.op === "gte") && value >= low) {
                lowOpen = value === low ? lowOpen || leaf.op === "gt" : leaf.op === "gt";
                low = value;
            }
            if ((leaf.op === "lt" || leaf.op === "lte") && value <= high) {
                highOpen = value === high ? highOpen || leaf.op === "lt" : leaf.op === "lt";
                high = value;
            }
        }
        if (low > high || (low === high && (lowOpen || highOpen))) return false;
    }
    return true;
}

function conditionsOf(node: graphs.GraphNode): graphs.ConditionGroup[] {
    if (node.type === "core.if") {
        const parsed = graphs.CORE_NODE_CONFIGS["core.if"].safeParse(node.config);
        return parsed.success ? [parsed.data.condition] : [];
    }
    if (node.type === "core.switch") {
        const parsed = graphs.switchConfigSchema.safeParse(node.config);
        return parsed.success && parsed.data.kind === "rules"
            ? parsed.data.cases.map((entry) => entry.condition)
            : [];
    }
    return [];
}

export function automationIssues(
    graph: graphs.AutomationGraph,
    options: {
        readonly automationId?: string;
        readonly forPublish?: boolean;
        /** App nodes' config problems, checked by the server with each app's schema. */
        readonly extraProblems?: readonly graphs.GraphProblem[];
        readonly selfTriggerRules?: readonly SelfTriggerRule[];
    } = {}
): AutomationIssue[] {
    const issues: AutomationIssue[] = [];
    const problems = [
        ...graphs.graphProblems(graph, { forPublish: options.forPublish }),
        ...(options.extraProblems ?? [])
    ];
    for (const problem of problems) issues.push({ severity: "error", ...problem });
    const cyclic = problems.some((problem) => problem.code === "cycle");
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    // Steps no trigger and no Finally lane reaches never run.
    const reached = new Set<string>();
    const starts = graphs.triggerNodes(graph).map((node) => node.id);
    if (graph.finally.entry) starts.push(graph.finally.entry);
    for (const start of starts)
        for (const id of graphs.reachableFrom(graph, start)) reached.add(id);
    if (starts.length > 0)
        for (const node of graph.nodes)
            if (!reached.has(node.id)) issues.push({ severity: "warning", code: "unreachable", node: node.id });

    // References: {{steps.<id>...}} must name a step that runs before this one.
    const ancestors = ancestorsOf(graph);
    const lane = graphs.finallyNodes(graph);
    for (const node of graph.nodes) {
        const seen = new Set<string>();
        for (const text of strings(node.config))
            for (const reference of graphs.automationReferencesIn(text)) {
                const parts = reference.split(".");
                if (parts[0] !== "steps" || seen.has(reference)) continue;
                seen.add(reference);
                const target = parts[1] ? byId.get(parts[1]) : undefined;
                if (!target) {
                    issues.push({ severity: "error", code: "missingReference", node: node.id, reference });
                    continue;
                }
                if (!lane.has(node.id) && !ancestors.get(node.id)?.has(target.id)) {
                    issues.push({ severity: "error", code: "laterReference", node: node.id, reference });
                    continue;
                }
                const field = parts[2];
                const known = graphs.isCoreNodeType(target.type)
                    ? CORE_NODE_OUTPUT_PATHS[target.type]
                    : null;
                if (field && known && known.length > 0 && target.pinned === undefined && !known.includes(field))
                    issues.push({ severity: "warning", code: "unknownOutput", node: node.id, reference });
            }
    }

    // A trigger the automation's own steps fire again, with nothing checking in between.
    if (!cyclic) {
        const rules = [...DEFAULT_SELF_TRIGGER_RULES, ...(options.selfTriggerRules ?? [])];
        for (const trigger of graphs.triggerNodes(graph)) {
            if (trigger.enabled === false) continue;
            for (const rule of rules) {
                if (rule.trigger !== trigger.type) continue;
                for (const step of graph.nodes)
                    if (
                        step.type === rule.step &&
                        step.enabled !== false &&
                        rule.same(trigger.config, step.config) &&
                        unguardedPath(graph, trigger.id, step.id)
                    )
                        issues.push({
                            severity: "error",
                            code: "selfTrigger",
                            node: step.id,
                            trigger: trigger.id
                        });
            }
        }
    }

    for (const node of graph.nodes) {
        if (node.type === "core.run" && options.automationId) {
            const target = (node.config as { automationId?: unknown } | null)?.automationId;
            if (target === options.automationId)
                issues.push({ severity: "error", code: "selfCall", node: node.id });
        }
        if (conditionsOf(node).some((group) => !canHold(group)))
            issues.push({ severity: "warning", code: "contradiction", node: node.id });
    }
    return issues;
}

/** Whether any issue stops a save or a publish. */
export function blockingIssues(issues: readonly AutomationIssue[]): AutomationIssue[] {
    return issues.filter((issue) => issue.severity === "error");
}
