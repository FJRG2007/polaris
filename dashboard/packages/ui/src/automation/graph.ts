/**
 * An automation drawn as a graph: its triggers on the left, feeding one gate
 * that holds its condition groups, feeding its steps in order.
 *
 * Shared by every automation editor in Polaris - Places' device automations and
 * Mail's filters store different nodes, but both store the same shape: triggers,
 * condition groups under one all/any, and an ordered list of steps. Everything
 * here is about that shape and nothing about what a node does.
 *
 * The graph is a view of the stored definition, never a second format. Every
 * node carries the very object it was drawn from, the layout is worked out from
 * the definition's order alone, and reading the graph back keeps everything it
 * did not move - so an automation opened in the canvas and saved untouched is
 * the same JSON it was. Positions are not stored: where a node ends up after a
 * drag only decides its place in its list.
 *
 * Issue paths are relative to the draft being edited, which holds the
 * definition under `definition` - the shape both editors give their drafts.
 *
 * Pure and client-safe.
 */

/** The gate's id. Not a node id any schema accepts, so it cannot collide with
 *  one. */
export const GATE_ID = "$gate";

export const NODE_WIDTH = 248;
export const NODE_HEIGHT = 76;
const GAP = 20;
const ROW = NODE_HEIGHT + GAP;
const COLUMN = NODE_WIDTH + 112;
/** Room inside a group for its heading, and around its conditions. */
export const GROUP_HEADER = 36;
export const GROUP_PADDING = 12;

export type Path = readonly (string | number)[];

export type FlowMatch = "all" | "any";

/** One trigger, condition or step: whatever else it holds, it has an id unique
 *  within its automation and a kind. */
export interface FlowItem {
    readonly id: string;
    readonly kind: string;
}

export interface FlowGroup<C extends FlowItem = FlowItem> {
    readonly id: string;
    readonly match: FlowMatch;
    readonly items: readonly C[];
}

/** The shape every automation definition shares. */
export interface FlowDefinition {
    readonly triggers: readonly FlowItem[];
    readonly conditions: { readonly match: FlowMatch; readonly groups: readonly FlowGroup[] };
    readonly actions: readonly FlowItem[];
}

export type TriggerOf<D extends FlowDefinition> = D["triggers"][number];
export type GroupOf<D extends FlowDefinition> = D["conditions"]["groups"][number];
export type ConditionOf<D extends FlowDefinition> = GroupOf<D>["items"][number];
export type StepOf<D extends FlowDefinition> = D["actions"][number];

export interface Position {
    readonly x: number;
    readonly y: number;
}

export type GraphNode<D extends FlowDefinition = FlowDefinition> =
    | {
          readonly id: string;
          readonly type: "trigger";
          readonly position: Position;
          readonly data: {
              readonly trigger: TriggerOf<D>;
              readonly index: number;
              readonly path: Path;
          };
      }
    | {
          readonly id: typeof GATE_ID;
          readonly type: "gate";
          readonly position: Position;
          readonly data: {
              readonly match: FlowMatch;
              readonly groups: number;
          };
      }
    | {
          readonly id: string;
          readonly type: "group";
          readonly position: Position;
          readonly width: number;
          readonly height: number;
          readonly data: {
              readonly group: GroupOf<D>;
              readonly index: number;
              readonly path: Path;
          };
      }
    | {
          readonly id: string;
          readonly type: "condition";
          readonly parentId: string;
          readonly position: Position;
          readonly data: {
              readonly condition: ConditionOf<D>;
              readonly group: number;
              readonly index: number;
              readonly path: Path;
          };
      }
    | {
          readonly id: string;
          readonly type: "step";
          readonly position: Position;
          readonly data: { readonly step: StepOf<D>; readonly index: number; readonly path: Path };
      };

export type GraphNodeType = GraphNode["type"];

export interface GraphEdge {
    readonly id: string;
    readonly source: string;
    readonly target: string;
    readonly sourceHandle: "out";
    readonly targetHandle: "in" | "prev" | "conditions";
    /** `flow` is the order things happen in; `feeds` is a group answering the
     *  gate. */
    readonly kind: "flow" | "feeds";
}

export interface AutomationGraph<D extends FlowDefinition = FlowDefinition> {
    readonly nodes: readonly GraphNode<D>[];
    readonly edges: readonly GraphEdge[];
}

export function groupHeight(items: number): number {
    return GROUP_HEADER + Math.max(1, items) * ROW - GAP + GROUP_PADDING;
}

/** Lay an automation out as a graph. Deterministic: the same definition always
 *  draws the same nodes in the same places. */
export function automationToGraph<D extends FlowDefinition>(definition: D): AutomationGraph<D> {
    const nodes: GraphNode<D>[] = [];
    const edges: GraphEdge[] = [];

    definition.triggers.forEach((trigger, index) => {
        nodes.push({
            id: trigger.id,
            type: "trigger",
            position: { x: 0, y: index * ROW },
            data: { trigger, index, path: ["definition", "triggers", index] }
        });
        edges.push({
            id: `${trigger.id}->${GATE_ID}`,
            source: trigger.id,
            target: GATE_ID,
            sourceHandle: "out",
            targetHandle: "in",
            kind: "flow"
        });
    });

    const { match, groups } = definition.conditions;
    nodes.push({
        id: GATE_ID,
        type: "gate",
        position: { x: COLUMN, y: 0 },
        data: { match, groups: groups.length }
    });

    let top = ROW;
    groups.forEach((group, index) => {
        const height = groupHeight(group.items.length);
        const path = ["definition", "conditions", "groups", index];
        nodes.push({
            id: group.id,
            type: "group",
            position: { x: COLUMN - GROUP_PADDING, y: top },
            width: NODE_WIDTH + GROUP_PADDING * 2,
            height,
            data: { group, index, path }
        });
        group.items.forEach((condition, item) => {
            nodes.push({
                id: condition.id,
                type: "condition",
                parentId: group.id,
                position: { x: GROUP_PADDING, y: GROUP_HEADER + item * ROW },
                data: { condition, group: index, index: item, path: [...path, "items", item] }
            });
        });
        edges.push({
            id: `${group.id}->${GATE_ID}`,
            source: group.id,
            target: GATE_ID,
            sourceHandle: "out",
            targetHandle: "conditions",
            kind: "feeds"
        });
        top += height + GAP;
    });

    definition.actions.forEach((step, index) => {
        nodes.push({
            id: step.id,
            type: "step",
            position: { x: COLUMN * 2, y: index * ROW },
            data: { step, index, path: ["definition", "actions", index] }
        });
        const before = index === 0 ? GATE_ID : definition.actions[index - 1]!.id;
        edges.push({
            id: `${before}->${step.id}`,
            source: before,
            target: step.id,
            sourceHandle: "out",
            targetHandle: index === 0 ? "in" : "prev",
            kind: "flow"
        });
    });

    return { nodes, edges };
}

/** Top to bottom; a tie keeps the order the list already had. */
function byHeight<
    T extends { readonly position: Position; readonly data: { readonly index: number } }
>(nodes: readonly T[]): T[] {
    return [...nodes].sort((a, b) => a.position.y - b.position.y || a.data.index - b.data.index);
}

/**
 * Read a graph back into the definition it was drawn from, `base`.
 *
 * Each list is put in the order its nodes stand in, top to bottom, which is all
 * a drag can change. Everything else - any field of the definition beside the
 * three lists, every node's own fields, the key order of each object - is
 * `base`'s, so a graph nobody moved reads back as exactly `base`.
 */
export function graphToAutomation<D extends FlowDefinition>(graph: AutomationGraph<D>, base: D): D {
    const of = <K extends GraphNodeType>(type: K) =>
        graph.nodes.filter(
            (node): node is Extract<GraphNode<D>, { type: K }> => node.type === type
        );
    const gate = of("gate")[0];
    const conditions = of("condition");
    return {
        ...base,
        triggers: byHeight(of("trigger")).map((node) => node.data.trigger),
        conditions: {
            ...base.conditions,
            match: gate?.data.match ?? base.conditions.match,
            groups: byHeight(of("group")).map((node) => ({
                ...node.data.group,
                items: byHeight(conditions.filter((item) => item.parentId === node.id)).map(
                    (item) => item.data.condition
                )
            }))
        },
        actions: byHeight(of("step")).map((node) => node.data.step)
    } as D;
}

/** A graph with one node somewhere else, as a drag leaves it. */
export function moveNode<D extends FlowDefinition>(
    graph: AutomationGraph<D>,
    id: string,
    position: Position
): AutomationGraph<D> {
    return {
        ...graph,
        nodes: graph.nodes.map((node) => (node.id === id ? { ...node, position } : node))
    };
}

/** A list with the entry at `index` swapped one place earlier (-1) or later
 *  (1). Out of range leaves it as it was. */
export function swap<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
    const next = [...list];
    const target = index + by;
    if (index < 0 || target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
}

/** One node one place earlier (-1) or later (1) in its own list: a trigger
 *  among the triggers, a condition within its group, a group among the groups,
 *  a step among the steps. Anything else is left as it is. */
export function shiftNode<D extends FlowDefinition>(definition: D, id: string, by: -1 | 1): D {
    const trigger = definition.triggers.findIndex((node) => node.id === id);
    if (trigger >= 0) return { ...definition, triggers: swap(definition.triggers, trigger, by) };
    const step = definition.actions.findIndex((node) => node.id === id);
    if (step >= 0) return { ...definition, actions: swap(definition.actions, step, by) };
    const groups = definition.conditions.groups;
    const group = groups.findIndex((node) => node.id === id);
    if (group >= 0) {
        return {
            ...definition,
            conditions: { ...definition.conditions, groups: swap(groups, group, by) }
        };
    }
    return {
        ...definition,
        conditions: {
            ...definition.conditions,
            groups: groups.map((entry) => {
                const item = entry.items.findIndex((node) => node.id === id);
                return item >= 0 ? { ...entry, items: swap(entry.items, item, by) } : entry;
            })
        }
    };
}

/** The definition without one node. A group goes with its conditions; the gate
 *  is not something that can go. */
export function removeNode<D extends FlowDefinition>(definition: D, id: string): D {
    if (id === GATE_ID) return definition;
    const groups = definition.conditions.groups;
    return {
        ...definition,
        triggers: definition.triggers.filter((node) => node.id !== id),
        conditions: {
            ...definition.conditions,
            groups: groups
                .filter((group) => group.id !== id)
                .map((group) =>
                    group.items.some((item) => item.id === id)
                        ? { ...group, items: group.items.filter((item) => item.id !== id) }
                        : group
                )
        },
        actions: definition.actions.filter((node) => node.id !== id)
    };
}

/** Whether `path` is `prefix` or lies under it: a complaint about a field of a
 *  node is a complaint about the node. */
export function within(path: Path, prefix: Path): boolean {
    return prefix.length <= path.length && prefix.every((part, at) => path[at] === part);
}
