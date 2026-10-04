"use client";

/**
 * The visual editor: an automation as a diagram - its triggers feeding a gate
 * that holds the condition groups, the gate feeding the steps in order.
 *
 * It edits the same draft as the form and nothing else. A node is selected to
 * edit it, and what opens beside the diagram is the form's own card for it, so
 * the fields, the checks and the messages are the ones the form has. The
 * palette adds what the schema has kinds for; a drag up or down, or the arrow
 * keys on a selected node, changes its place in its list; Delete removes it.
 *
 * On a narrow screen a diagram is something to scroll around rather than read,
 * so the same nodes are drawn as a list there, opening the same cards.
 *
 * The diagram is React Flow (`@xyflow/react`). Its stylesheet comes from the
 * dashboard's global CSS: an app's bundle carries no CSS of its own.
 */

import {
    Background,
    Handle,
    Panel,
    Position,
    ReactFlow,
    ReactFlowProvider,
    applyNodeChanges,
    useReactFlow,
    type Edge,
    type Node,
    type NodeChange,
    type NodeProps,
    type OnSelectionChangeFunc
} from "@xyflow/react";
import { AlertCircle, Filter, Maximize, Play, Plus, X, Zap, ZoomIn, ZoomOut } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    cn
} from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import * as auto from "../../lib/automation-kinds";
import * as words from "../../lib/automation-words";
import * as graphs from "../../lib/automation-graph";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type CSSProperties,
    type ReactNode
} from "react";

/** Which card the inspector draws: a condition opens its group's. */
export type CanvasSelection =
    | { readonly role: "trigger"; readonly index: number }
    | { readonly role: "gate" }
    | { readonly role: "group"; readonly index: number }
    | { readonly role: "step"; readonly index: number };

/** How a node stands against the checks: fine, not filled in yet, or wrong. */
export type NodeState = "ok" | "incomplete" | "invalid";

type Definition = auto.AutomationDefinition;
type Translator = ReturnType<typeof usePlacesT>;

type ViewData = {
    readonly title: string;
    readonly summary: string;
    readonly state: NodeState;
    readonly number?: number;
    readonly readOnly: boolean;
};

type ViewNode = Node<ViewData>;

/** How the whole diagram is framed: never past life size, and never so small
 *  that a node's words cannot be read - a long automation is panned instead. */
const FIT = { padding: 0.1, maxZoom: 1, minZoom: 0.6 };

/** What removes the selected node: Delete, and the key Macs label delete. */
const DELETE_KEYS = ["Delete", "Backspace"];

/** The width at which a diagram is worth drawing rather than a list. */
const WIDE = "(min-width: 768px)";

function subscribeWide(change: () => void): () => void {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const query = window.matchMedia(WIDE);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
}

function wideNow(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(WIDE).matches
        : false;
}

function useWide(): boolean {
    return useSyncExternalStore(subscribeWide, wideNow, () => false);
}

/** Where a node is in the definition, as the inspector asks for it. */
export function selectionOf(definition: Definition, id: string | null): CanvasSelection | null {
    if (!id) return null;
    if (id === graphs.GATE_ID) return { role: "gate" };
    const trigger = definition.triggers.findIndex((node) => node.id === id);
    if (trigger >= 0) return { role: "trigger", index: trigger };
    const step = definition.actions.findIndex((node) => node.id === id);
    if (step >= 0) return { role: "step", index: step };
    const group = definition.conditions.groups.findIndex(
        (entry) => entry.id === id || entry.items.some((item) => item.id === id)
    );
    return group >= 0 ? { role: "group", index: group } : null;
}

/** The group new conditions go into: the selected one, while it has room. */
function targetGroup(definition: Definition, id: string | null): auto.ConditionGroup | null {
    const selection = selectionOf(definition, id);
    if (selection?.role !== "group") return null;
    const group = definition.conditions.groups[selection.index];
    return group && group.items.length < auto.LIMITS.conditionsPerGroup ? group : null;
}

function orderOf(definition: Definition): string {
    return JSON.stringify([
        definition.triggers.map((node) => node.id),
        definition.conditions.groups.map((group) => [group.id, group.items.map((item) => item.id)]),
        definition.actions.map((node) => node.id)
    ]);
}

function stateText(state: NodeState, t: Translator): string {
    if (state === "invalid") return t("automations.canvas.invalid");
    if (state === "incomplete") return t("automations.canvas.unfinished");
    return "";
}

/** What a screen reader says for a node: its kind, what it does, and whether it
 *  needs something. */
function spoken(data: ViewData, t: Translator): string {
    return [data.title, data.summary, stateText(data.state, t)]
        .filter((part, at, all) => part && all.indexOf(part) === at)
        .join(". ");
}

/** Each node's words: what kind it is, and what it does in a sentence. */
function viewData(
    node: graphs.GraphNode,
    stateOf: (path: graphs.Path) => NodeState,
    lookup: words.DeviceLookup,
    automationName: (id: string) => string | undefined,
    readOnly: boolean,
    t: Translator
): ViewData {
    switch (node.type) {
        case "trigger": {
            const state = stateOf(node.data.path);
            return {
                title: words.triggerKindText(node.data.trigger.kind, t),
                summary:
                    state === "incomplete"
                        ? stateText(state, t)
                        : words.describeTrigger(node.data.trigger, lookup, t),
                state,
                readOnly
            };
        }
        case "gate": {
            const { groups, match } = node.data;
            return {
                title: t("automations.editor.if"),
                summary:
                    groups === 0
                        ? t("automations.canvas.always")
                        : groups === 1
                          ? t("automations.canvas.oneGroup")
                          : match === "all"
                            ? t("automations.editor.allGroups")
                            : t("automations.editor.anyGroup"),
                state: "ok",
                readOnly
            };
        }
        case "group": {
            const { group, index, path } = node.data;
            const many = group.items.length > 1;
            return {
                title: t("automations.canvas.group", { number: index + 1 }),
                summary: many
                    ? group.match === "all"
                        ? t("automations.editor.allOf")
                        : t("automations.editor.anyOf")
                    : "",
                state: stateOf(path),
                readOnly
            };
        }
        case "condition": {
            const state = stateOf(node.data.path);
            return {
                title: words.conditionKindText(node.data.condition.kind, t),
                summary:
                    state === "incomplete"
                        ? stateText(state, t)
                        : words.describeCondition(node.data.condition, lookup, t),
                state,
                readOnly
            };
        }
        case "step": {
            const state = stateOf(node.data.path);
            return {
                title: words.stepKindText(node.data.step.kind, t),
                summary:
                    state === "incomplete"
                        ? stateText(state, t)
                        : words.describeStep(node.data.step, lookup, automationName, t),
                state,
                number: node.data.index + 1,
                readOnly
            };
        }
    }
}

const HANDLE_STYLE = {
    width: 8,
    height: 8,
    minWidth: 0,
    minHeight: 0,
    border: "none",
    background: "hsl(var(--border-strong))"
} as const;

function Port({
    type,
    position,
    id
}: {
    type: "source" | "target";
    position: Position;
    id: string;
}) {
    return (
        <Handle
            type={type}
            position={position}
            id={id}
            isConnectable={false}
            style={HANDLE_STYLE}
        />
    );
}

function RoleIcon({ role }: { role: graphs.GraphNodeType }) {
    if (role === "trigger") return <Zap aria-hidden="true" className="size-3.5 shrink-0" />;
    if (role === "step") return <Play aria-hidden="true" className="size-3.5 shrink-0" />;
    return <Filter aria-hidden="true" className="size-3.5 shrink-0" />;
}

/** One node's face, in the diagram and in the narrow list alike. */
function NodeFace({
    role,
    data,
    selected
}: {
    role: graphs.GraphNodeType;
    data: ViewData;
    selected: boolean;
}) {
    return (
        <span
            className={cn(
                "flex h-full w-full min-w-0 flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-left transition-colors",
                selected
                    ? "border-primary ring-1 ring-primary"
                    : data.state === "invalid"
                      ? "border-danger-edge"
                      : data.state === "incomplete"
                        ? "border-dashed border-border-strong"
                        : "border-border",
                !data.readOnly && "cursor-pointer"
            )}
        >
            <span className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground">
                <RoleIcon role={role} />
                {data.number !== undefined && (
                    <span className="shrink-0 tabular-nums">{data.number}.</span>
                )}
                <span className="min-w-0 flex-1 truncate" title={data.title}>
                    {data.title}
                </span>
                {data.state === "invalid" && (
                    <AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
                )}
            </span>
            {data.summary && (
                <span
                    className={cn(
                        "line-clamp-2 min-w-0 break-words text-xs",
                        data.state === "incomplete" ? "text-muted-foreground" : "text-foreground"
                    )}
                    title={data.summary}
                >
                    {data.summary}
                </span>
            )}
        </span>
    );
}

function TriggerNode({ data, selected }: NodeProps<ViewNode>) {
    return (
        <>
            <NodeFace role="trigger" data={data} selected={selected} />
            <Port type="source" position={Position.Right} id="out" />
        </>
    );
}

function GateNode({ data, selected }: NodeProps<ViewNode>) {
    return (
        <>
            <Port type="target" position={Position.Left} id="in" />
            <NodeFace role="gate" data={data} selected={selected} />
            <Port type="target" position={Position.Bottom} id="conditions" />
            <Port type="source" position={Position.Right} id="out" />
        </>
    );
}

function GroupNode({ data, selected }: NodeProps<ViewNode>) {
    return (
        <div
            className={cn(
                "h-full w-full rounded-lg border border-dashed bg-muted/40",
                selected
                    ? "border-primary"
                    : data.state === "invalid"
                      ? "border-danger-edge"
                      : "border-border-strong"
            )}
        >
            <Port type="source" position={Position.Top} id="out" />
            <p className="flex min-w-0 items-center gap-1.5 px-3 pt-2 text-[0.6875rem] font-medium text-muted-foreground">
                <span className="shrink-0">{data.title}</span>
                {data.summary && (
                    <span className="min-w-0 truncate" title={data.summary}>
                        {data.summary}
                    </span>
                )}
                {data.state === "invalid" && (
                    <AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
                )}
            </p>
        </div>
    );
}

function ConditionNode({ data, selected }: NodeProps<ViewNode>) {
    return <NodeFace role="condition" data={data} selected={selected} />;
}

function StepNode({ data, selected }: NodeProps<ViewNode>) {
    return (
        <>
            <Port type="target" position={Position.Left} id="in" />
            <Port type="target" position={Position.Top} id="prev" />
            <NodeFace role="step" data={data} selected={selected} />
            <Port type="source" position={Position.Bottom} id="out" />
        </>
    );
}

/** React Flow's name for each kind of node. Prefixed because a node's type is
 *  also its class, and React Flow's own sheet styles `react-flow__node-group`. */
const FLOW_TYPE: Readonly<Record<graphs.GraphNodeType, string>> = {
    trigger: "automation-trigger",
    gate: "automation-gate",
    group: "automation-group",
    condition: "automation-condition",
    step: "automation-step"
};

/** Module level, so React Flow is handed the same object every render. */
const NODE_TYPES = {
    [FLOW_TYPE.trigger]: TriggerNode,
    [FLOW_TYPE.gate]: GateNode,
    [FLOW_TYPE.group]: GroupNode,
    [FLOW_TYPE.condition]: ConditionNode,
    [FLOW_TYPE.step]: StepNode
};

type Adding =
    | { readonly role: "trigger"; readonly kind: auto.TriggerKind }
    | { readonly role: "condition"; readonly kind: auto.ConditionKind }
    | { readonly role: "step"; readonly kind: auto.StepKind };

/** One "add" button of the palette: a menu of the kinds it can add, or - when
 *  the automation holds as many as it can - a button that says so. */
function AddKind<K extends string>({
    label,
    kinds,
    text,
    full,
    onPick
}: {
    label: string;
    kinds: readonly K[];
    text: (kind: K) => string;
    full: boolean;
    onPick: (kind: K) => void;
}) {
    const t = usePlacesT();
    const face = (
        <>
            <Plus className="size-4 shrink-0" />
            <span className="truncate" title={label}>
                {label}
            </span>
        </>
    );
    if (full) {
        return (
            <Button
                size="sm"
                variant="outline"
                className="max-w-full border-dashed opacity-60"
                aria-disabled="true"
                title={t("automations.errors.tooMany")}
            >
                {face}
            </Button>
        );
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="max-w-full border-dashed">
                    {face}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                {kinds.map((kind) => (
                    <DropdownMenuItem key={kind} onSelect={() => onPick(kind)}>
                        {text(kind)}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** What can be added, by stage: every kind the schema has. A condition goes
 *  into the selected group while it has room, and starts a new one otherwise. */
function Palette({
    definition,
    selectedId,
    onAdd
}: {
    definition: Definition;
    selectedId: string | null;
    onAdd: (adding: Adding) => void;
}) {
    const t = usePlacesT();
    const group = targetGroup(definition, selectedId);
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div
                role="group"
                aria-label={t("automations.canvas.add")}
                className="flex min-w-0 flex-wrap items-center gap-2"
            >
                <AddKind
                    label={t("automations.editor.addTrigger")}
                    kinds={auto.TRIGGER_KINDS}
                    text={(kind) => words.triggerKindText(kind, t)}
                    full={definition.triggers.length >= auto.LIMITS.triggers}
                    onPick={(kind) => onAdd({ role: "trigger", kind })}
                />
                <AddKind
                    label={t("automations.editor.addCondition")}
                    kinds={auto.CONDITION_KINDS}
                    text={(kind) => words.conditionKindText(kind, t)}
                    full={!group && definition.conditions.groups.length >= auto.LIMITS.groups}
                    onPick={(kind) => onAdd({ role: "condition", kind })}
                />
                <AddKind
                    label={t("automations.editor.addStep")}
                    kinds={auto.STEP_KINDS}
                    text={(kind) => words.stepKindText(kind, t)}
                    full={definition.actions.length >= auto.LIMITS.steps}
                    onPick={(kind) => onAdd({ role: "step", kind })}
                />
            </div>
            <p className="text-[0.6875rem] text-foreground-subtle">
                {group ? t("automations.canvas.toGroup") : t("automations.canvas.newGroup")}
            </p>
        </div>
    );
}
function Toolbar() {
    const t = usePlacesT();
    const flow = useReactFlow();
    const button = (label: string, icon: ReactNode, run: () => void) => (
        <Button
            size="sm"
            variant="ghost"
            className="size-8 p-0"
            aria-label={label}
            title={label}
            onClick={run}
        >
            {icon}
        </Button>
    );
    return (
        <div className="flex items-center rounded-md border border-border bg-elevated">
            {button(
                t("automations.canvas.zoomIn"),
                <ZoomIn className="size-4" />,
                () => void flow.zoomIn({ duration: 150 })
            )}
            {button(
                t("automations.canvas.zoomOut"),
                <ZoomOut className="size-4" />,
                () => void flow.zoomOut({ duration: 150 })
            )}
            {button(
                t("automations.canvas.fit"),
                <Maximize className="size-4" />,
                () => void flow.fitView({ ...FIT, duration: 200 })
            )}
        </div>
    );
}

export interface AutomationCanvasProps {
    definition: Definition;
    readOnly: boolean;
    /** Edit the draft's definition, as the form does. */
    onChange: (change: (current: Definition) => Definition) => void;
    /** How the node at a path stands against the checks the form runs. */
    stateOf: (path: graphs.Path) => NodeState;
    lookup: words.DeviceLookup;
    automationName: (id: string) => string | undefined;
    /** The form's own card for what is selected. */
    renderInspector: (selection: CanvasSelection) => ReactNode;
    /** Complaints about a stage as a whole - no trigger, no step - once Save
     *  has been pressed. */
    stageIssues: readonly string[];
}

export function AutomationCanvas(props: AutomationCanvasProps) {
    return (
        <ReactFlowProvider>
            <CanvasBody {...props} />
        </ReactFlowProvider>
    );
}

function CanvasBody({
    definition,
    readOnly,
    onChange,
    stateOf,
    lookup,
    automationName,
    renderInspector,
    stageIssues
}: AutomationCanvasProps) {
    const t = usePlacesT();
    const wide = useWide();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const dragging = useRef(false);

    const graph = useMemo(() => graphs.automationToGraph(definition), [definition]);
    const selection = selectionOf(definition, selectedId);

    // A node removed from the card (its X) is no longer there to be selected.
    useEffect(() => {
        if (selectedId && !selection) setSelectedId(null);
    }, [selectedId, selection]);

    const laidOut = useMemo<ViewNode[]>(
        () =>
            graph.nodes.map((node) => {
                const data = viewData(node, stateOf, lookup, automationName, readOnly, t);
                return {
                    id: node.id,
                    type: FLOW_TYPE[node.type],
                    className:
                        "rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    position: node.position,
                    data,
                    width: node.type === "group" ? node.width : graphs.NODE_WIDTH,
                    height: node.type === "group" ? node.height : graphs.NODE_HEIGHT,
                    selected: node.id === selectedId,
                    draggable: !readOnly && node.type !== "gate",
                    deletable: !readOnly && node.type !== "gate",
                    ...(node.type === "condition"
                        ? { parentId: node.parentId, extent: "parent" as const }
                        : {}),
                    ...(node.type === "group" ? { zIndex: -1 } : {}),
                    ariaLabel: spoken(data, t)
                };
            }),
        [graph, stateOf, lookup, automationName, readOnly, selectedId, t]
    );

    const [nodes, setNodes] = useState<ViewNode[]>(laidOut);
    useEffect(() => setNodes(laidOut), [laidOut]);

    // A node added below the fold, or the last of a column removed, is brought
    // back into the frame rather than left for the reader to go looking for.
    const flow = useReactFlow();
    const count = graph.nodes.length;
    const framed = useRef(count);
    useEffect(() => {
        if (!wide || framed.current === count) return;
        framed.current = count;
        const frame = requestAnimationFrame(() => void flow.fitView({ ...FIT, duration: 200 }));
        return () => cancelAnimationFrame(frame);
    }, [count, wide, flow]);

    const edges = useMemo<Edge[]>(
        () =>
            graph.edges.map((edge) => ({
                id: edge.id,
                source: edge.source,
                target: edge.target,
                sourceHandle: edge.sourceHandle,
                targetHandle: edge.targetHandle,
                selectable: false,
                focusable: false,
                // The lines only repeat what the nodes' order already says, and
                // React Flow would name each by its two node ids.
                domAttributes: { "aria-hidden": true },
                style: {
                    stroke: "hsl(var(--border-strong))",
                    strokeWidth: 1.5,
                    ...(edge.kind === "feeds" ? { strokeDasharray: "4 4" } : {})
                }
            })),
        [graph]
    );

    /** The order the nodes stand in now, put into the definition - or, where
     *  nothing changed places, every node back where the layout puts it. */
    const settle = useCallback(
        (current: readonly ViewNode[]) => {
            const moved: graphs.AutomationGraph = {
                ...graph,
                nodes: graph.nodes.map((node) => {
                    const now = current.find((entry) => entry.id === node.id);
                    return now ? { ...node, position: now.position } : node;
                })
            };
            const next = graphs.graphToAutomation(moved, definition);
            if (orderOf(next) === orderOf(definition)) setNodes(laidOut);
            else onChange((existing) => graphs.graphToAutomation(moved, existing));
        },
        [graph, definition, laidOut, onChange]
    );

    const onNodesChange = useCallback(
        (changes: NodeChange<ViewNode>[]) => {
            if (readOnly) {
                setNodes((current) =>
                    applyNodeChanges(
                        changes.filter((change) => change.type === "dimensions"),
                        current
                    )
                );
                return;
            }
            // The arrow keys on a selected node move it a few pixels, which is
            // never far enough to pass another: read as one place up or down.
            const nudged = dragging.current
                ? undefined
                : changes.find(
                      (change) =>
                          change.type === "position" && change.dragging === false && change.position
                  );
            if (nudged && nudged.type === "position" && nudged.position) {
                const before = nodes.find((node) => node.id === nudged.id);
                const by = before ? Math.sign(nudged.position.y - before.position.y) : 0;
                if (by !== 0)
                    onChange((current) => graphs.shiftNode(current, nudged.id, by as -1 | 1));
                else setNodes(laidOut);
                return;
            }
            // Removal is the definition's to do (`onNodesDelete`); selection is
            // `selectedId`'s.
            setNodes((current) =>
                applyNodeChanges(
                    changes.filter(
                        (change) => change.type !== "remove" && change.type !== "select"
                    ),
                    current
                )
            );
        },
        [readOnly, nodes, laidOut, onChange]
    );

    const onSelectionChange = useCallback<OnSelectionChangeFunc<ViewNode>>(
        ({ nodes: selected }) => {
            const id = selected[0]?.id ?? null;
            setSelectedId((current) => (current === id ? current : id));
        },
        []
    );

    const add = (adding: Adding) => {
        if (readOnly) return;
        if (adding.role === "trigger") {
            if (definition.triggers.length >= auto.LIMITS.triggers) return;
            const node = auto.blankTrigger(adding.kind);
            onChange((current) => ({ ...current, triggers: [...current.triggers, node] }));
            setSelectedId(node.id);
            return;
        }
        if (adding.role === "step") {
            if (definition.actions.length >= auto.LIMITS.steps) return;
            const node = auto.blankStep(adding.kind);
            onChange((current) => ({ ...current, actions: [...current.actions, node] }));
            setSelectedId(node.id);
            return;
        }
        const node = auto.blankCondition(adding.kind);
        const group = targetGroup(definition, selectedId);
        if (group) {
            onChange((current) => ({
                ...current,
                conditions: {
                    ...current.conditions,
                    groups: current.conditions.groups.map((entry) =>
                        entry.id === group.id ? { ...entry, items: [...entry.items, node] } : entry
                    )
                }
            }));
        } else {
            if (definition.conditions.groups.length >= auto.LIMITS.groups) return;
            onChange((current) => ({
                ...current,
                conditions: {
                    ...current.conditions,
                    groups: [
                        ...current.conditions.groups,
                        { id: auto.nodeIdOf(), match: "all", items: [node] }
                    ]
                }
            }));
        }
        setSelectedId(node.id);
    };

    // React Flow reads one of the two descriptions depending on whether its
    // keyboard handling is on, and it is; both say the same here, for the reader
    // who can change the automation and for the one who cannot.
    const ariaLabelConfig = useMemo(() => {
        const help = readOnly
            ? t("automations.canvas.nodeHelpReadOnly")
            : t("automations.canvas.nodeHelp");
        return {
            "node.a11yDescription.default": help,
            "node.a11yDescription.keyboardDisabled": help,
            "node.a11yDescription.ariaLiveMessage": () => t("automations.canvas.moved"),
            "edge.a11yDescription.default": t("automations.canvas.edgeHelp"),
            "handle.ariaLabel": t("automations.canvas.handle")
        };
    }, [readOnly, t]);

    // Beside the diagram the card says which stage it is from; under a node of
    // the narrow list, which already sits under that stage's heading, it does not.
    const inspector = selection ? (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
                <h3
                    className={cn(
                        "min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide",
                        !wide && "sr-only"
                    )}
                >
                    {selection.role === "trigger"
                        ? t("automations.editor.when")
                        : selection.role === "step"
                          ? t("automations.editor.then")
                          : t("automations.editor.if")}
                </h3>
                {!wide && <span className="flex-1" />}
                <Button
                    size="sm"
                    variant="ghost"
                    className="size-7 p-0"
                    aria-label={t("automations.canvas.close")}
                    title={t("automations.canvas.close")}
                    onClick={() => setSelectedId(null)}
                >
                    <X className="size-3.5" />
                </Button>
            </div>
            {renderInspector(selection)}
        </div>
    ) : null;

    const issues = stageIssues.length > 0 && (
        <ul className="flex flex-col gap-0.5">
            {stageIssues.map((issue) => (
                <li key={issue} className="text-xs text-danger">
                    {issue}
                </li>
            ))}
        </ul>
    );

    if (!wide) {
        return (
            <div className="flex flex-col gap-4">
                {!readOnly && (
                    <Palette definition={definition} selectedId={selectedId} onAdd={add} />
                )}
                {issues}
                <NodeList
                    graph={graph}
                    data={(node) => laidOut.find((entry) => entry.id === node.id)!.data}
                    selectedId={selectedId}
                    selection={selection}
                    onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
                    inspector={inspector}
                />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {!readOnly && <Palette definition={definition} selectedId={selectedId} onAdd={add} />}
            {issues}
            <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
                <div
                    role="region"
                    aria-label={t("automations.canvas.diagram")}
                    className="relative h-[min(40rem,75vh)] min-h-[24rem] min-w-0 overflow-hidden rounded-lg border border-border bg-surface"
                >
                    <ReactFlow<ViewNode>
                        nodes={nodes}
                        edges={edges}
                        nodeTypes={NODE_TYPES}
                        onNodesChange={onNodesChange}
                        onSelectionChange={onSelectionChange}
                        onNodeDragStart={() => {
                            dragging.current = true;
                        }}
                        onNodeDragStop={(_, __, dragged) => {
                            dragging.current = false;
                            settle(
                                nodes.map(
                                    (node) => dragged.find((entry) => entry.id === node.id) ?? node
                                )
                            );
                        }}
                        onNodesDelete={(removed) => {
                            onChange((current) =>
                                removed.reduce(
                                    (next, node) => graphs.removeNode(next, node.id),
                                    current
                                )
                            );
                            setSelectedId(null);
                        }}
                        nodesDraggable={!readOnly}
                        nodesConnectable={false}
                        edgesFocusable={false}
                        elementsSelectable
                        selectionKeyCode={null}
                        multiSelectionKeyCode={null}
                        deleteKeyCode={readOnly ? null : DELETE_KEYS}
                        fitView
                        fitViewOptions={FIT}
                        minZoom={0.25}
                        maxZoom={1.75}
                        ariaLabelConfig={ariaLabelConfig}
                        style={
                            {
                                "--xy-attribution-background-color": "transparent"
                            } as CSSProperties
                        }
                    >
                        <Background gap={20} size={1} color="hsl(var(--border))" />
                        <Panel position="bottom-left" className="!m-2">
                            <Toolbar />
                        </Panel>
                    </ReactFlow>
                </div>
                <aside aria-label={t("automations.canvas.inspector")} className="min-w-0">
                    {inspector ?? (
                        <p className="text-xs text-muted-foreground">
                            {t("automations.canvas.pick")}
                        </p>
                    )}
                </aside>
            </div>
            {!readOnly && (
                <p className="text-[0.6875rem] text-foreground-subtle">
                    {t("automations.canvas.reorderHint")}
                </p>
            )}
        </div>
    );
}

/** The same nodes as a list, for a screen too narrow for the diagram: each one
 *  a button that opens its card under it. */
function NodeList({
    graph,
    data,
    selectedId,
    selection,
    onSelect,
    inspector
}: {
    graph: graphs.AutomationGraph;
    data: (node: graphs.GraphNode) => ViewData;
    selectedId: string | null;
    selection: CanvasSelection | null;
    onSelect: (id: string) => void;
    inspector: ReactNode;
}) {
    const t = usePlacesT();
    const of = <K extends graphs.GraphNodeType>(type: K) =>
        graph.nodes.filter(
            (node): node is Extract<graphs.GraphNode, { type: K }> => node.type === type
        );
    const opens = (node: graphs.GraphNode): boolean => {
        if (!selection) return false;
        if (node.type === "gate") return selection.role === "gate";
        if (node.type === "group")
            return selection.role === "group" && selection.index === node.data.index;
        return node.id === selectedId;
    };
    const item = (node: graphs.GraphNode, extra?: ReactNode) => {
        const open = opens(node);
        return (
            <li key={node.id} className="flex min-w-0 flex-col gap-2">
                <button
                    type="button"
                    aria-expanded={open}
                    aria-label={spoken(data(node), t)}
                    className="min-h-[3.5rem] w-full min-w-0 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onSelect(node.id)}
                >
                    <NodeFace role={node.type} data={data(node)} selected={open} />
                </button>
                {extra}
                {open && inspector}
            </li>
        );
    };
    const stage = (title: string, children: ReactNode) => (
        <section className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide">{title}</h3>
            <ul className="flex min-w-0 flex-col gap-2">{children}</ul>
        </section>
    );
    const conditions = of("condition");
    return (
        <div className="flex min-w-0 flex-col gap-4">
            {stage(
                t("automations.editor.when"),
                of("trigger").map((node) => item(node))
            )}
            {stage(t("automations.editor.if"), [
                ...of("gate").map((node) => item(node)),
                ...of("group").map((node) =>
                    item(
                        node,
                        <ul className="flex min-w-0 flex-col gap-1 border-l border-dashed border-border-strong pl-3">
                            {conditions
                                .filter((entry) => entry.parentId === node.id)
                                .map((entry) => (
                                    <li key={entry.id} className="min-w-0">
                                        <button
                                            type="button"
                                            aria-label={spoken(data(entry), t)}
                                            className="w-full min-w-0 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            onClick={() => onSelect(entry.id)}
                                        >
                                            <NodeFace
                                                role="condition"
                                                data={data(entry)}
                                                selected={entry.id === selectedId}
                                            />
                                        </button>
                                    </li>
                                ))}
                        </ul>
                    )
                )
            ])}
            {stage(
                t("automations.editor.then"),
                of("step").map((node) => item(node))
            )}
        </div>
    );
}
