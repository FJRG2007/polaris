"use client";

/**
 * The visual editor: an automation as a diagram - its triggers feeding a gate
 * that holds the condition groups, the gate feeding the steps in order.
 *
 * Shared by every automation editor (Places, Mail's filters). What the nodes
 * are - their kinds, their words, how a blank one starts - arrives in the
 * `vocabulary`; this file only knows the shape every automation has.
 *
 * It edits the same draft as the form and nothing else. A node is selected to
 * edit it, and what opens beside the diagram is the form's own card for it, so
 * the fields, the checks and the messages are the ones the form has. The
 * palette adds what the vocabulary has kinds for; a drag up or down, or the
 * arrow keys on a selected node, changes its place in its list; Delete removes
 * it.
 *
 * On a narrow screen a diagram is something to scroll around rather than read,
 * so the same nodes are drawn as a list there, opening the same cards.
 *
 * The diagram is drawn by `diagram.tsx`, with no library under it: the board,
 * the lines and the gestures are Polaris' own, the same as the Deploy board's.
 */

import { AlertCircle, Filter, Play, Plus, X, Zap } from "lucide-react";
import { Diagram, type DiagramNode } from "./diagram";
import { cn } from "../lib/cn";
import { Button } from "../components/button";
import * as graphs from "./graph";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "../components/dropdown-menu";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
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

/** Every word the canvas says, in the reader's language. */
export interface FlowCanvasLabels {
    /** The three stages' headings. */
    readonly when: string;
    readonly if: string;
    readonly then: string;
    /** How the groups combine at the gate, and the conditions within a group. */
    readonly allGroups: string;
    readonly anyGroup: string;
    readonly allOf: string;
    readonly anyOf: string;
    readonly addTrigger: string;
    readonly addCondition: string;
    readonly addStep: string;
    /** Why an add button does nothing: the automation holds as many as it can. */
    readonly tooMany: string;
    readonly diagram: string;
    readonly add: string;
    readonly toGroup: string;
    readonly newGroup: string;
    readonly zoomIn: string;
    readonly zoomOut: string;
    readonly fit: string;
    /** The gate's summary with no groups, and with one. */
    readonly always: string;
    readonly oneGroup: string;
    readonly group: (number: number) => string;
    readonly unfinished: string;
    readonly invalid: string;
    readonly pick: string;
    readonly inspector: string;
    readonly close: string;
    readonly reorderHint: string;
    readonly nodeHelp: string;
    readonly nodeHelpReadOnly: string;
    readonly moved: string;
    readonly handle: string;
    readonly edgeHelp: string;
}

/** One stage's nodes: the kinds that can be added, what each is called, how a
 *  blank one starts, and a node said in a sentence. */
export interface FlowKinds<N extends graphs.FlowItem> {
    readonly kinds: readonly N["kind"][];
    readonly kindText: (kind: N["kind"]) => string;
    readonly blank: (kind: N["kind"]) => N;
    readonly describe: (node: N) => string;
}

/** What an automation is made of, for the canvas to draw and add. */
export interface FlowVocabulary<D extends graphs.FlowDefinition> {
    readonly labels: FlowCanvasLabels;
    readonly triggers: FlowKinds<graphs.TriggerOf<D>> & {
        /** The triggers are set by what the automation is for, and cannot be
         *  added to, moved or removed here. */
        readonly fixed?: boolean;
    };
    readonly conditions: FlowKinds<graphs.ConditionOf<D>>;
    readonly steps: FlowKinds<graphs.StepOf<D>>;
    readonly limits: {
        readonly triggers: number;
        readonly groups: number;
        readonly conditionsPerGroup: number;
        readonly steps: number;
    };
    /** A fresh id for a new group. */
    readonly newId: () => string;
}

type ViewData = {
    readonly title: string;
    readonly summary: string;
    readonly state: NodeState;
    readonly number?: number;
    readonly readOnly: boolean;
};

type ViewNode = DiagramNode & { readonly data: ViewData };

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
export function selectionOf(
    definition: graphs.FlowDefinition,
    id: string | null
): CanvasSelection | null {
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
function targetGroup(
    definition: graphs.FlowDefinition,
    id: string | null,
    perGroup: number
): graphs.FlowGroup | null {
    const selection = selectionOf(definition, id);
    if (selection?.role !== "group") return null;
    const group = definition.conditions.groups[selection.index];
    return group && group.items.length < perGroup ? group : null;
}

function orderOf(definition: graphs.FlowDefinition): string {
    return JSON.stringify([
        definition.triggers.map((node) => node.id),
        definition.conditions.groups.map((group) => [group.id, group.items.map((item) => item.id)]),
        definition.actions.map((node) => node.id)
    ]);
}

function stateText(state: NodeState, labels: FlowCanvasLabels): string {
    if (state === "invalid") return labels.invalid;
    if (state === "incomplete") return labels.unfinished;
    return "";
}

/** What a screen reader says for a node: its kind, what it does, and whether it
 *  needs something. */
function spoken(data: ViewData, labels: FlowCanvasLabels): string {
    return [data.title, data.summary, stateText(data.state, labels)]
        .filter((part, at, all) => part && all.indexOf(part) === at)
        .join(". ");
}

/** Each node's words: what kind it is, and what it does in a sentence. */
function viewData<D extends graphs.FlowDefinition>(
    node: graphs.GraphNode<D>,
    stateOf: (path: graphs.Path) => NodeState,
    vocabulary: FlowVocabulary<D>,
    readOnly: boolean
): ViewData {
    const { labels } = vocabulary;
    switch (node.type) {
        case "trigger": {
            const state = stateOf(node.data.path);
            const { trigger } = node.data;
            return {
                title: vocabulary.triggers.kindText(trigger.kind),
                summary:
                    state === "incomplete"
                        ? stateText(state, labels)
                        : vocabulary.triggers.describe(trigger),
                state,
                readOnly
            };
        }
        case "gate": {
            const { groups, match } = node.data;
            return {
                title: labels.if,
                summary:
                    groups === 0
                        ? labels.always
                        : groups === 1
                          ? labels.oneGroup
                          : match === "all"
                            ? labels.allGroups
                            : labels.anyGroup,
                state: "ok",
                readOnly
            };
        }
        case "group": {
            const { group, index, path } = node.data;
            const many = group.items.length > 1;
            return {
                title: labels.group(index + 1),
                summary: many ? (group.match === "all" ? labels.allOf : labels.anyOf) : "",
                state: stateOf(path),
                readOnly
            };
        }
        case "condition": {
            const state = stateOf(node.data.path);
            const { condition } = node.data;
            return {
                title: vocabulary.conditions.kindText(condition.kind),
                summary:
                    state === "incomplete"
                        ? stateText(state, labels)
                        : vocabulary.conditions.describe(condition),
                state,
                readOnly
            };
        }
        case "step": {
            const state = stateOf(node.data.path);
            const { step } = node.data;
            return {
                title: vocabulary.steps.kindText(step.kind),
                summary:
                    state === "incomplete"
                        ? stateText(state, labels)
                        : vocabulary.steps.describe(step),
                state,
                number: node.data.index + 1,
                readOnly
            };
        }
    }
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

type Adding = { readonly role: "trigger" | "condition" | "step"; readonly kind: string };

/** One "add" button of the palette: a menu of the kinds it can add, or - when
 *  the automation holds as many as it can - a button that says so. */
function AddKind<K extends string>({
    label,
    kinds,
    text,
    full,
    fullLabel,
    onPick
}: {
    label: string;
    kinds: readonly K[];
    text: (kind: K) => string;
    full: boolean;
    fullLabel: string;
    onPick: (kind: K) => void;
}) {
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
                title={fullLabel}
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

/** What can be added, by stage: every kind the vocabulary has. A condition goes
 *  into the selected group while it has room, and starts a new one otherwise. */
function Palette<D extends graphs.FlowDefinition>({
    definition,
    vocabulary,
    selectedId,
    onAdd
}: {
    definition: D;
    vocabulary: FlowVocabulary<D>;
    selectedId: string | null;
    onAdd: (adding: Adding) => void;
}) {
    const { labels, limits } = vocabulary;
    const group = targetGroup(definition, selectedId, limits.conditionsPerGroup);
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div
                role="group"
                aria-label={labels.add}
                className="flex min-w-0 flex-wrap items-center gap-2"
            >
                {!vocabulary.triggers.fixed && (
                    <AddKind
                        label={labels.addTrigger}
                        kinds={vocabulary.triggers.kinds}
                        text={vocabulary.triggers.kindText}
                        full={definition.triggers.length >= limits.triggers}
                        fullLabel={labels.tooMany}
                        onPick={(kind) => onAdd({ role: "trigger", kind })}
                    />
                )}
                <AddKind
                    label={labels.addCondition}
                    kinds={vocabulary.conditions.kinds}
                    text={vocabulary.conditions.kindText}
                    full={!group && definition.conditions.groups.length >= limits.groups}
                    fullLabel={labels.tooMany}
                    onPick={(kind) => onAdd({ role: "condition", kind })}
                />
                <AddKind
                    label={labels.addStep}
                    kinds={vocabulary.steps.kinds}
                    text={vocabulary.steps.kindText}
                    full={definition.actions.length >= limits.steps}
                    fullLabel={labels.tooMany}
                    onPick={(kind) => onAdd({ role: "step", kind })}
                />
            </div>
            <p className="text-[0.6875rem] text-foreground-subtle">
                {group ? labels.toGroup : labels.newGroup}
            </p>
        </div>
    );
}

export interface FlowCanvasProps<D extends graphs.FlowDefinition> {
    definition: D;
    vocabulary: FlowVocabulary<D>;
    readOnly: boolean;
    /** Edit the draft's definition, as the form does. */
    onChange: (change: (current: D) => D) => void;
    /** How the node at a path stands against the checks the form runs. */
    stateOf: (path: graphs.Path) => NodeState;
    /** The form's own card for what is selected. */
    renderInspector: (selection: CanvasSelection) => ReactNode;
    /** Complaints about a stage as a whole - no trigger, no step - once Save
     *  has been pressed. */
    stageIssues: readonly string[];
    /** Where the selected node's card opens on a wide screen: beside the
     *  diagram, or under it - for a page whose column is too narrow to give the
     *  diagram room with a card beside it. */
    inspectorPlacement?: "beside" | "below";
}

export function FlowCanvas<D extends graphs.FlowDefinition>({
    definition,
    vocabulary,
    readOnly,
    onChange,
    stateOf,
    renderInspector,
    stageIssues,
    inspectorPlacement = "beside"
}: FlowCanvasProps<D>) {
    const { labels, limits } = vocabulary;
    const fixedTriggers = vocabulary.triggers.fixed === true;
    const wide = useWide();
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const graph = useMemo(() => graphs.automationToGraph(definition), [definition]);
    const selection = selectionOf(definition, selectedId);

    // A node removed from the card (its X) is no longer there to be selected.
    useEffect(() => {
        if (selectedId && !selection) setSelectedId(null);
    }, [selectedId, selection]);

    const laidOut = useMemo<ViewNode[]>(
        () =>
            graph.nodes.map((node) => {
                const data = viewData(node, stateOf, vocabulary, readOnly);
                const locked =
                    readOnly || node.type === "gate" || (fixedTriggers && node.type === "trigger");
                return {
                    id: node.id,
                    role: node.type,
                    position: node.position,
                    data,
                    width: node.type === "group" ? node.width : graphs.NODE_WIDTH,
                    height: node.type === "group" ? node.height : graphs.NODE_HEIGHT,
                    draggable: !locked,
                    deletable: !locked,
                    ...(node.type === "condition" ? { parentId: node.parentId } : {}),
                    ariaLabel: spoken(data, labels)
                };
            }),
        [graph, stateOf, vocabulary, labels, fixedTriggers, readOnly]
    );

    /** A node let go of at a new place, put into the definition as the order
     *  that makes - or, where nothing changed places, nothing at all: the node
     *  goes back where the layout puts it. */
    const drop = useCallback(
        (id: string, position: graphs.Position) => {
            const moved: graphs.AutomationGraph<D> = {
                ...graph,
                nodes: graph.nodes.map((node) => (node.id === id ? { ...node, position } : node))
            };
            const next = graphs.graphToAutomation(moved, definition);
            if (orderOf(next) !== orderOf(definition))
                onChange((existing) => graphs.graphToAutomation(moved, existing));
        },
        [graph, definition, onChange]
    );

    const add = (adding: Adding) => {
        if (readOnly) return;
        if (adding.role === "trigger") {
            if (fixedTriggers || definition.triggers.length >= limits.triggers) return;
            const node = vocabulary.triggers.blank(adding.kind);
            onChange((current) => ({ ...current, triggers: [...current.triggers, node] }));
            setSelectedId(node.id);
            return;
        }
        if (adding.role === "step") {
            if (definition.actions.length >= limits.steps) return;
            const node = vocabulary.steps.blank(adding.kind);
            onChange((current) => ({ ...current, actions: [...current.actions, node] }));
            setSelectedId(node.id);
            return;
        }
        const node = vocabulary.conditions.blank(adding.kind);
        const group = targetGroup(definition, selectedId, limits.conditionsPerGroup);
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
            if (definition.conditions.groups.length >= limits.groups) return;
            onChange((current) => ({
                ...current,
                conditions: {
                    ...current.conditions,
                    groups: [
                        ...current.conditions.groups,
                        { id: vocabulary.newId(), match: "all", items: [node] }
                    ]
                }
            }));
        }
        setSelectedId(node.id);
    };

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
                        ? labels.when
                        : selection.role === "step"
                          ? labels.then
                          : labels.if}
                </h3>
                {!wide && <span className="flex-1" />}
                <Button
                    size="sm"
                    variant="ghost"
                    className="size-7 p-0"
                    aria-label={labels.close}
                    title={labels.close}
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
                    <Palette
                        definition={definition}
                        vocabulary={vocabulary}
                        selectedId={selectedId}
                        onAdd={add}
                    />
                )}
                {issues}
                <NodeList
                    graph={graph}
                    labels={labels}
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
            {!readOnly && (
                <Palette
                    definition={definition}
                    vocabulary={vocabulary}
                    selectedId={selectedId}
                    onAdd={add}
                />
            )}
            {issues}
            <div
                className={cn(
                    "grid min-w-0 gap-4",
                    inspectorPlacement === "beside" && "xl:grid-cols-[minmax(0,1fr)_24rem]"
                )}
            >
                <div
                    role="region"
                    aria-label={labels.diagram}
                    className="relative h-[min(40rem,75vh)] min-h-[24rem] min-w-0 overflow-hidden rounded-lg border border-border bg-surface"
                >
                    <Diagram
                        nodes={laidOut}
                        edges={graph.edges}
                        selectedId={selectedId}
                        readOnly={readOnly}
                        labels={{
                            zoomIn: labels.zoomIn,
                            zoomOut: labels.zoomOut,
                            fit: labels.fit,
                            help: readOnly ? labels.nodeHelpReadOnly : labels.nodeHelp,
                            moved: labels.moved
                        }}
                        face={(node, selected) => (
                            <ViewFace node={node as ViewNode} selected={selected} />
                        )}
                        onSelect={setSelectedId}
                        onDrop={drop}
                        onNudge={(id, by) =>
                            onChange((current) => graphs.shiftNode(current, id, by))
                        }
                        onDelete={(id) => {
                            onChange((current) => graphs.removeNode(current, id));
                            setSelectedId(null);
                        }}
                    />
                </div>
                <aside aria-label={labels.inspector} className="min-w-0">
                    {inspector ?? <p className="text-xs text-muted-foreground">{labels.pick}</p>}
                </aside>
            </div>
            {!readOnly && (
                <p className="text-[0.6875rem] text-foreground-subtle">{labels.reorderHint}</p>
            )}
        </div>
    );
}

/** How a node is drawn on the diagram: a group is a frame its conditions sit
 *  in; every other node is its face. */
function ViewFace({ node, selected }: { node: ViewNode; selected: boolean }) {
    const { data } = node;
    if (node.role !== "group") return <NodeFace role={node.role} data={data} selected={selected} />;
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

/** The same nodes as a list, for a screen too narrow for the diagram: each one
 *  a button that opens its card under it. */
function NodeList<D extends graphs.FlowDefinition>({
    graph,
    labels,
    data,
    selectedId,
    selection,
    onSelect,
    inspector
}: {
    graph: graphs.AutomationGraph<D>;
    labels: FlowCanvasLabels;
    data: (node: graphs.GraphNode<D>) => ViewData;
    selectedId: string | null;
    selection: CanvasSelection | null;
    onSelect: (id: string) => void;
    inspector: ReactNode;
}) {
    const of = <K extends graphs.GraphNodeType>(type: K) =>
        graph.nodes.filter(
            (node): node is Extract<graphs.GraphNode<D>, { type: K }> => node.type === type
        );
    const opens = (node: graphs.GraphNode<D>): boolean => {
        if (!selection) return false;
        if (node.type === "gate") return selection.role === "gate";
        if (node.type === "group")
            return selection.role === "group" && selection.index === node.data.index;
        return node.id === selectedId;
    };
    const item = (node: graphs.GraphNode<D>, extra?: ReactNode) => {
        const open = opens(node);
        return (
            <li key={node.id} className="flex min-w-0 flex-col gap-2">
                <button
                    type="button"
                    aria-expanded={open}
                    aria-label={spoken(data(node), labels)}
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
                labels.when,
                of("trigger").map((node) => item(node))
            )}
            {stage(labels.if, [
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
                                            aria-label={spoken(data(entry), labels)}
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
                labels.then,
                of("step").map((node) => item(node))
            )}
        </div>
    );
}
