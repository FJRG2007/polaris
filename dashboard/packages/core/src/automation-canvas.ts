/**
 * The canvas editor's arithmetic, pure so the editor, the server and the tests
 * agree on it: where nodes without a position are drawn, which lane a node
 * belongs to, whether a connection may be made, what a copy carries, and which
 * earlier values a field may reference.
 *
 * Nothing here draws anything. The canvas calls these and renders the result.
 */

import { z } from "zod";
import * as graphs from "./automation-graph.js";

/** The size every node card is drawn at, in board units. */
export const CANVAS_NODE = { width: 240, height: 72 } as const;
/** Room each output port needs, so a Choose with many cases keeps its port labels apart. */
export const CANVAS_PORT_PITCH = 18;

/** How tall a node card is drawn: the standard height, taller when its ports need the room. */
export function canvasNodeHeight(node: {
    readonly type: string;
    readonly config?: unknown;
    readonly onError?: string;
}): number {
    const ports = graphs.nodePorts(node.type, node).length;
    return Math.max(CANVAS_NODE.height, (ports + 1) * CANVAS_PORT_PITCH);
}

/** The box a node occupies on the board. */
function nodeBox(node: graphs.GraphNode, at: { x: number; y: number }): CanvasBox {
    return { ...at, width: CANVAS_NODE.width, height: canvasNodeHeight(node) };
}

/** Room between layout columns and rows. */
export const CANVAS_GAP = { x: 96, y: 36 } as const;
/** How far the "Always, at the end" lane sits below the main flow. */
export const FINALLY_LANE_GAP = 140;
/** The pseudo-node on the Always lane's edge that a connection starts the lane from. */
export const FINALLY_SOURCE = "$finally";

export type Lane = "main" | "finally" | "loose";

/** Which lane each node is in: reached from a trigger, reached from the Always lane's start, or neither yet. */
export function lanesOf(graph: graphs.AutomationGraph): Map<string, Lane> {
    const main = new Set<string>();
    for (const trigger of graphs.triggerNodes(graph))
        for (const id of graphs.reachableFrom(graph, trigger.id)) main.add(id);
    const lane = graphs.finallyNodes(graph);
    const out = new Map<string, Lane>();
    for (const node of graph.nodes)
        out.set(node.id, lane.has(node.id) ? "finally" : main.has(node.id) ? "main" : "loose");
    return out;
}

/** Columns by longest path from the roots, so every edge runs left to right. Cycles (a broken draft) end the walk. */
function columns(graph: graphs.AutomationGraph, ids: ReadonlySet<string>): Map<string, number> {
    const inbound = new Map<string, number>([...ids].map((id) => [id, 0]));
    for (const edge of graph.edges)
        if (ids.has(edge.from.node) && ids.has(edge.to.node))
            inbound.set(edge.to.node, inbound.get(edge.to.node)! + 1);
    const column = new Map<string, number>();
    const queue = graph.nodes
        .filter((node) => ids.has(node.id) && inbound.get(node.id) === 0)
        .map((node) => node.id);
    for (const id of queue) column.set(id, 0);
    while (queue.length) {
        const at = queue.shift()!;
        for (const edge of graph.edges) {
            if (edge.from.node !== at || !ids.has(edge.to.node)) continue;
            column.set(edge.to.node, Math.max(column.get(edge.to.node) ?? 0, column.get(at)! + 1));
            const left = inbound.get(edge.to.node)! - 1;
            inbound.set(edge.to.node, left);
            if (left === 0) queue.push(edge.to.node);
        }
    }
    for (const id of ids) if (!column.has(id)) column.set(id, 0);
    return column;
}

function placeBand(
    graph: graphs.AutomationGraph,
    ids: ReadonlySet<string>,
    top: number,
    into: Map<string, { x: number; y: number }>
): number {
    if (ids.size === 0) return top;
    const column = columns(graph, ids);
    const next = new Map<number, number>();
    let bottom = top;
    for (const node of graph.nodes) {
        if (!ids.has(node.id)) continue;
        const at = column.get(node.id)!;
        const y = next.get(at) ?? top;
        const height = canvasNodeHeight(node);
        next.set(at, y + height + CANVAS_GAP.y);
        into.set(node.id, { x: at * (CANVAS_NODE.width + CANVAS_GAP.x), y });
        bottom = Math.max(bottom, y + height);
    }
    return bottom;
}

/**
 * Where every node is drawn. Stored positions win; a node without one (every
 * graph built in the list view) is laid out by lane: the main flow on top, the
 * Always lane below it, nodes wired to neither under both. `tidy` lays out
 * every node, stored position or not.
 */
export function layoutGraph(
    graph: graphs.AutomationGraph,
    options: { tidy?: boolean } = {}
): graphs.AutomationGraph {
    if (!options.tidy && graph.nodes.every((node) => node.position)) return graph;
    const lanes = lanesOf(graph);
    const pick = (lane: Lane) =>
        new Set(graph.nodes.filter((node) => lanes.get(node.id) === lane).map((node) => node.id));
    const placed = new Map<string, { x: number; y: number }>();
    const mainBottom = placeBand(graph, pick("main"), 0, placed);
    const finallyBottom = placeBand(graph, pick("finally"), mainBottom + FINALLY_LANE_GAP, placed);
    placeBand(graph, pick("loose"), finallyBottom + FINALLY_LANE_GAP, placed);
    return {
        ...graph,
        nodes: graph.nodes.map((node) =>
            node.position && !options.tidy
                ? node
                : { ...node, position: placed.get(node.id) ?? { x: 0, y: 0 } }
        )
    };
}

export interface CanvasBox {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

function overlaps(a: CanvasBox, b: CanvasBox): boolean {
    return (
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    );
}

/**
 * Positions for the nodes that have none (a step added in the list view)
 * without moving the ones that do: next to the node it follows, else before
 * the node it leads to, else under everything, then down until it lands on a
 * free spot. A graph with no positions at all is laid out whole.
 */
export function placeNew(graph: graphs.AutomationGraph): graphs.AutomationGraph {
    if (graph.nodes.every((node) => node.position)) return graph;
    if (graph.nodes.every((node) => !node.position)) return layoutGraph(graph);
    const placed = new Map<string, { x: number; y: number }>();
    for (const node of graph.nodes) if (node.position) placed.set(node.id, node.position);
    const boxes: CanvasBox[] = [
        ...graph.nodes.filter((node) => node.position).map((node) => nodeBox(node, node.position!)),
        ...graph.notes.map((note) => ({ ...note.position, ...note.size }))
    ];
    const settle = (node: graphs.GraphNode, at: { x: number; y: number }) => {
        const box = { ...nodeBox(node, at) };
        while (boxes.some((other) => overlaps(box, other)))
            box.y += CANVAS_NODE.height + CANVAS_GAP.y;
        boxes.push(box);
        return { x: Math.round(box.x), y: Math.round(box.y) };
    };
    const near = (id: string): { x: number; y: number } | null => {
        const before = graph.edges.find(
            (edge) => edge.to.node === id && placed.has(edge.from.node)
        );
        if (before) {
            const at = placed.get(before.from.node)!;
            return { x: at.x + CANVAS_NODE.width + CANVAS_GAP.x, y: at.y };
        }
        const after = graph.edges.find((edge) => edge.from.node === id && placed.has(edge.to.node));
        if (after) {
            const at = placed.get(after.to.node)!;
            return { x: at.x - CANVAS_NODE.width - CANVAS_GAP.x, y: at.y };
        }
        if (graph.finally.entry === id) {
            const band = finallyBand(graph);
            return { x: 0, y: band.top + 36 };
        }
        return null;
    };
    let progress = true;
    while (progress) {
        progress = false;
        for (const node of graph.nodes) {
            if (placed.has(node.id)) continue;
            const at = near(node.id);
            if (!at) continue;
            placed.set(node.id, settle(node, at));
            progress = true;
        }
    }
    for (const node of graph.nodes) {
        if (placed.has(node.id)) continue;
        const bottom = Math.max(0, ...boxes.map((box) => box.y + box.height));
        const left = Math.min(...boxes.map((box) => box.x));
        placed.set(
            node.id,
            settle(node, { x: Number.isFinite(left) ? left : 0, y: bottom + CANVAS_GAP.y })
        );
    }
    return {
        ...graph,
        nodes: graph.nodes.map((node) =>
            node.position ? node : { ...node, position: placed.get(node.id)! }
        )
    };
}

/** The box around every node and note, or null for an empty canvas. */
export function graphBounds(graph: graphs.AutomationGraph): CanvasBox | null {
    const boxes: CanvasBox[] = [
        ...graph.nodes.map((node) => nodeBox(node, node.position ?? { x: 0, y: 0 })),
        ...graph.notes.map((note) => ({ ...note.position, ...note.size }))
    ];
    if (boxes.length === 0) return null;
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The vertical band the Always lane is drawn in, from its nodes, or a band under the main flow when it is empty. */
export function finallyBand(graph: graphs.AutomationGraph): { top: number; bottom: number } {
    const lanes = lanesOf(graph);
    const ys = (lane: Lane) =>
        graph.nodes
            .filter((node) => lanes.get(node.id) === lane)
            .map((node) => (node.position?.y ?? 0) + canvasNodeHeight(node));
    const lane = ys("finally");
    const main = ys("main");
    const tops = graph.nodes
        .filter((node) => lanes.get(node.id) === "finally")
        .map((node) => node.position?.y ?? 0);
    const mainBottom = main.length ? Math.max(...main) : 0;
    if (lane.length === 0)
        return {
            top: mainBottom + FINALLY_LANE_GAP / 2,
            bottom: mainBottom + FINALLY_LANE_GAP / 2 + CANVAS_NODE.height + 48
        };
    return { top: Math.min(...tops) - 36, bottom: Math.max(...lane) + 24 };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export type ConnectRefusal =
    | "self"
    | "intoTrigger"
    | "unknownPort"
    | "duplicate"
    | "cycle"
    | "crossesLane"
    | "intoLaneStart"
    | "laneTaken"
    | "intoLoopBody"
    | "intoTryBody";

/** Why a connection from `from` to `to` may not be made, or null when it may. */
export function connectRefusal(
    graph: graphs.AutomationGraph,
    from: { node: string; port: string },
    to: string
): ConnectRefusal | null {
    const target = graph.nodes.find((node) => node.id === to);
    if (!target) return "unknownPort";
    if (graphs.nodeRole(target.type) === "trigger") return "intoTrigger";
    const lanes = lanesOf(graph);
    if (from.node === FINALLY_SOURCE) {
        if (graph.finally.entry) return "laneTaken";
        if (graph.edges.some((edge) => edge.to.node === to) || lanes.get(to) !== "loose")
            return "crossesLane";
        return null;
    }
    if (from.node === to) return "self";
    const source = graph.nodes.find((node) => node.id === from.node);
    if (!source || !graphs.nodePorts(source.type, source).includes(from.port)) return "unknownPort";
    if (
        graph.edges.some(
            (edge) =>
                edge.from.node === from.node && edge.from.port === from.port && edge.to.node === to
        )
    )
        return "duplicate";
    if (to === graph.finally.entry) return "intoLaneStart";
    if (graphs.reachableFrom(graph, to).has(from.node)) return "cycle";
    const a = lanes.get(from.node);
    const b = lanes.get(to);
    if (a !== "loose" && b !== "loose" && a !== b) return "crossesLane";
    const wired = { ...graph, edges: [...graph.edges, { from: { ...from }, to: { node: to } }] };
    const leaking = new Set(graphs.loopBodyLeaks(graph));
    if (graphs.loopBodyLeaks(wired).some((node) => !leaking.has(node))) return "intoLoopBody";
    const tryLeaking = new Set(graphs.tryBodyLeaks(graph));
    if (graphs.tryBodyLeaks(wired).some((node) => !tryLeaking.has(node))) return "intoTryBody";
    return null;
}

/** The graph with one more connection, or the same graph when it is refused. */
export function connect(
    graph: graphs.AutomationGraph,
    from: { node: string; port: string },
    to: string
): graphs.AutomationGraph {
    if (connectRefusal(graph, from, to)) return graph;
    if (from.node === FINALLY_SOURCE) return { ...graph, finally: { ...graph.finally, entry: to } };
    return { ...graph, edges: [...graph.edges, { from: { ...from }, to: { node: to } }] };
}

export function edgeKey(edge: graphs.GraphEdge): string {
    return `${edge.from.node}:${edge.from.port}>${edge.to.node}`;
}

export function disconnect(graph: graphs.AutomationGraph, key: string): graphs.AutomationGraph {
    if (key === `${FINALLY_SOURCE}>${graph.finally.entry}`)
        return { ...graph, finally: { ...graph.finally, entry: null } };
    return { ...graph, edges: graph.edges.filter((edge) => edgeKey(edge) !== key) };
}

/**
 * The graph without some nodes and notes and every connection touching them.
 * Removing the Always lane's first node hands the lane to the node it led to.
 */
export function removeFromGraph(
    graph: graphs.AutomationGraph,
    nodeIds: Iterable<string>,
    noteIds: Iterable<string> = []
): graphs.AutomationGraph {
    const gone = new Set(nodeIds);
    const notesGone = new Set(noteIds);
    let entry = graph.finally.entry;
    while (entry && gone.has(entry)) {
        const next = graph.edges.filter((edge) => edge.from.node === entry);
        entry = next.length === 1 ? next[0]!.to.node : null;
    }
    return {
        ...graph,
        nodes: graph.nodes.filter((node) => !gone.has(node.id)),
        edges: graph.edges.filter((edge) => !gone.has(edge.from.node) && !gone.has(edge.to.node)),
        notes: graph.notes.filter((note) => !notesGone.has(note.id)),
        finally: { ...graph.finally, entry }
    };
}

/**
 * The graph with `node` put on a connection: what led into the connection's
 * end now leads into the new node, and the new node's first output leads on to
 * it. Nodes downstream move right when there is no room. Null when the
 * connection is gone, the node is a trigger, or the node limit is reached.
 */
export function insertOnEdge(
    graph: graphs.AutomationGraph,
    key: string,
    node: graphs.GraphNode
): graphs.AutomationGraph | null {
    if (
        graph.nodes.length >= graphs.AUTOMATION_LIMITS.nodes ||
        graphs.nodeRole(node.type) === "trigger"
    )
        return null;
    const lane = key === `${FINALLY_SOURCE}>${graph.finally.entry}`;
    const edge = lane ? null : graph.edges.find((entry) => edgeKey(entry) === key);
    const toId = lane ? graph.finally.entry : edge?.to.node;
    const target = graph.nodes.find((entry) => entry.id === toId);
    if (!target || (!lane && !edge)) return null;
    if (graph.edges.length + 1 > graphs.AUTOMATION_LIMITS.edges) return null;
    const source = edge ? graph.nodes.find((entry) => entry.id === edge.from.node) : undefined;
    const to = target.position ?? { x: 0, y: 0 };
    const from = source?.position ?? { x: to.x - CANVAS_NODE.width - CANVAS_GAP.x, y: to.y };
    const step = CANVAS_NODE.width + CANVAS_GAP.x;
    const at = { x: Math.round(from.x + step), y: Math.round(lane ? to.y : from.y) };
    const room = to.x - at.x - step;
    const shift = room < 0 ? -room : 0;
    const moving = shift ? graphs.reachableFrom(graph, target.id) : new Set<string>();
    const port = graphs.nodePorts(node.type, node)[0]!;
    const placed: graphs.GraphNode = { ...node, position: at };
    const nodes = [
        ...graph.nodes.map((entry) =>
            moving.has(entry.id) && entry.position
                ? { ...entry, position: { x: entry.position.x + shift, y: entry.position.y } }
                : entry
        ),
        placed
    ];
    if (lane)
        return {
            ...graph,
            nodes,
            edges: [...graph.edges, { from: { node: node.id, port }, to: { node: target.id } }],
            finally: { ...graph.finally, entry: node.id }
        };
    return {
        ...graph,
        nodes,
        edges: [
            ...graph.edges.filter((entry) => entry !== edge),
            { from: { ...edge!.from }, to: { node: node.id } },
            { from: { node: node.id, port }, to: { node: target.id } }
        ]
    };
}

/** The smallest and largest a sticky note may be, the bounds `graphNoteSchema` holds it to. */
export const NOTE_SIZE = {
    min: { width: 120, height: 60 },
    max: { width: 1200, height: 1200 }
} as const;

/** A note's size kept inside `NOTE_SIZE`, whole units. */
export function clampNoteSize(size: { width: number; height: number }): {
    width: number;
    height: number;
} {
    const clamp = (value: number, min: number, max: number) =>
        Math.round(Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)));
    return {
        width: clamp(size.width, NOTE_SIZE.min.width, NOTE_SIZE.max.width),
        height: clamp(size.height, NOTE_SIZE.min.height, NOTE_SIZE.max.height)
    };
}

/** The graph with one note resized; the same graph when the note is gone or the size did not change. */
export function resizeNote(
    graph: graphs.AutomationGraph,
    noteId: string,
    size: { width: number; height: number }
): graphs.AutomationGraph {
    const note = graph.notes.find((entry) => entry.id === noteId);
    if (!note) return graph;
    const next = clampNoteSize(size);
    if (next.width === note.size.width && next.height === note.size.height) return graph;
    return {
        ...graph,
        notes: graph.notes.map((entry) => (entry.id === noteId ? { ...entry, size: next } : entry))
    };
}

/** Move nodes and notes by the same distance, as a drag of a selection does. */
export function moveInGraph(
    graph: graphs.AutomationGraph,
    nodeIds: ReadonlySet<string>,
    noteIds: ReadonlySet<string>,
    dx: number,
    dy: number
): graphs.AutomationGraph {
    const snap = (value: number) => Math.round(value);
    return {
        ...graph,
        nodes: graph.nodes.map((node) =>
            nodeIds.has(node.id)
                ? {
                      ...node,
                      position: {
                          x: snap((node.position?.x ?? 0) + dx),
                          y: snap((node.position?.y ?? 0) + dy)
                      }
                  }
                : node
        ),
        notes: graph.notes.map((note) =>
            noteIds.has(note.id)
                ? {
                      ...note,
                      position: { x: snap(note.position.x + dx), y: snap(note.position.y + dy) }
                  }
                : note
        )
    };
}

// ---------------------------------------------------------------------------
// Copy and paste
// ---------------------------------------------------------------------------

const FRAGMENT_TAG = "polaris-automation-fragment";

export const fragmentSchema = z.object({
    kind: z.literal(FRAGMENT_TAG),
    version: z.literal(1),
    nodes: z.array(graphs.graphNodeSchema).max(graphs.AUTOMATION_LIMITS.nodes),
    edges: z.array(graphs.graphEdgeSchema).max(graphs.AUTOMATION_LIMITS.edges),
    notes: z.array(graphs.graphNoteSchema).max(graphs.AUTOMATION_LIMITS.notes)
});
export type GraphFragment = z.infer<typeof fragmentSchema>;

const SECRET_KEYS = new Set(["secretId", "urlSecretId"]);

/** A config with every secret reference emptied: a copy never carries a credential to another shelf. */
export function withoutSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutSecrets);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        out[key] = SECRET_KEYS.has(key)
            ? key === "urlSecretId" && entry === null
                ? null
                : ""
            : withoutSecrets(entry);
    }
    return out;
}

/** The selected nodes, the connections among them, and the selected notes. Pins and secrets stay behind. */
export function copyFragment(
    graph: graphs.AutomationGraph,
    nodeIds: ReadonlySet<string>,
    noteIds: ReadonlySet<string> = new Set()
): GraphFragment {
    return {
        kind: FRAGMENT_TAG,
        version: 1,
        nodes: graph.nodes
            .filter((node) => nodeIds.has(node.id))
            .map(({ pinned: _pinned, ...node }) => ({
                ...node,
                config: withoutSecrets(node.config)
            })),
        edges: graph.edges.filter(
            (edge) => nodeIds.has(edge.from.node) && nodeIds.has(edge.to.node)
        ),
        notes: graph.notes.filter((note) => noteIds.has(note.id))
    };
}

export function fragmentText(fragment: GraphFragment): string {
    return JSON.stringify(fragment);
}

/** A fragment out of clipboard text, or null when the text is not one. Validated, never trusted. */
export function parseFragment(text: string): GraphFragment | null {
    if (text.length > 2 * graphs.AUTOMATION_LIMITS.eventPayloadBytes) return null;
    try {
        const parsed = fragmentSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * The graph with a fragment added, every id fresh and every position moved by
 * `offset`. Null when it would pass the node or note limit.
 */
export function pasteFragment(
    graph: graphs.AutomationGraph,
    fragment: GraphFragment,
    offset: { x: number; y: number },
    newId: () => string
): { graph: graphs.AutomationGraph; nodeIds: string[]; noteIds: string[] } | null {
    if (graph.nodes.length + fragment.nodes.length > graphs.AUTOMATION_LIMITS.nodes) return null;
    if (graph.notes.length + fragment.notes.length > graphs.AUTOMATION_LIMITS.notes) return null;
    if (graph.edges.length + fragment.edges.length > graphs.AUTOMATION_LIMITS.edges) return null;
    const ids = new Map(fragment.nodes.map((node) => [node.id, newId()]));
    const nodes: graphs.GraphNode[] = fragment.nodes.map((node) => ({
        ...node,
        id: ids.get(node.id)!,
        position: { x: (node.position?.x ?? 0) + offset.x, y: (node.position?.y ?? 0) + offset.y }
    }));
    const edges: graphs.GraphEdge[] = fragment.edges
        .filter((edge) => ids.has(edge.from.node) && ids.has(edge.to.node))
        .map((edge) => ({
            from: { node: ids.get(edge.from.node)!, port: edge.from.port },
            to: { node: ids.get(edge.to.node)! }
        }));
    const notes: graphs.GraphNote[] = fragment.notes.map((note) => ({
        ...note,
        id: newId(),
        position: { x: note.position.x + offset.x, y: note.position.y + offset.y }
    }));
    return {
        graph: {
            ...graph,
            nodes: [...graph.nodes, ...nodes],
            edges: [...graph.edges, ...edges],
            notes: [...graph.notes, ...notes]
        },
        nodeIds: nodes.map((node) => node.id),
        noteIds: notes.map((note) => note.id)
    };
}

// ---------------------------------------------------------------------------
// Pins and versions
// ---------------------------------------------------------------------------

/** What a version stores: the draft without its pinned samples, which belong to test runs only. */
export function withoutPins(graph: graphs.AutomationGraph): graphs.AutomationGraph {
    if (!graph.nodes.some((node) => node.pinned !== undefined)) return graph;
    return { ...graph, nodes: graph.nodes.map(({ pinned: _pinned, ...node }) => node) };
}

/** Whether the draft differs from the published graph in anything a run would notice (pins and positions do not count). */
export function draftDiffers(
    draft: graphs.AutomationGraph,
    published: graphs.AutomationGraph | null
): boolean {
    if (!published) return true;
    const shape = (graph: graphs.AutomationGraph) =>
        JSON.stringify({
            timeZone: graph.timeZone,
            finally: graph.finally,
            nodes: graph.nodes.map(({ position: _position, pinned: _pinned, ...node }) => node),
            edges: graph.edges.map(edgeKey)
        });
    return shape(draft) !== shape(published);
}

// ---------------------------------------------------------------------------
// Data mapping
// ---------------------------------------------------------------------------

/** What each core node adds to the context when there is no sample to read it from. */
export const CORE_NODE_OUTPUT_PATHS: Readonly<Record<graphs.CoreNodeType, readonly string[]>> = {
    "core.manual": ["id", "at", "by", "kind"],
    "core.schedule": ["id", "at", "kind"],
    "core.webhook": ["id", "at", "method", "query", "headers", "body"],
    "core.if": ["matched"],
    "core.wait": ["waitedUntil"],
    "core.notify": ["sent"],
    "core.http": ["status", "ok", "headers", "body"],
    "core.chat": ["status", "ok"],
    "core.called": ["id", "at", "inputs"],
    "core.onEvent": ["id", "at", "name", "payload"],
    "core.failed": ["id", "at", "automationId", "automationName", "runId", "status", "error"],
    "core.switch": ["matched"],
    "core.parallel": ["lanes"],
    "core.join": ["inputs", "items", "arrived", "missing"],
    "core.forEach": ["count", "passes"],
    "core.repeat": ["passes"],
    "core.stop": ["as", "reason"],
    "core.waitEvent": ["name", "payload", "timedOut"],
    "core.run": ["runId", "status", "outputs"],
    "core.answer": ["outputs"],
    "core.announce": ["name", "eventId"],
    "core.try": ["failed", "error", "node", "recovered"],
    "core.waitCondition": ["matched", "checks", "timedOut"]
};

export interface ReferenceOption {
    /** What goes between the braces. */
    readonly path: string;
    /** A short preview of the sample value, when a sample exists. */
    readonly preview?: string;
}

export interface ReferenceGroup {
    /** The node the values come from, or "run" for the run itself. */
    readonly nodeId: string;
    readonly root: string;
    readonly fromSample: boolean;
    readonly options: readonly ReferenceOption[];
}

function preview(value: unknown): string {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    return text.length > 40 ? `${text.slice(0, 39)}...` : text;
}

/** Every leaf path of a sample, depth and count bounded; a list offers its first entry. */
export function samplePaths(
    value: unknown,
    prefix: string,
    limits = { depth: 5, max: 80 }
): ReferenceOption[] {
    const out: ReferenceOption[] = [];
    const visit = (at: unknown, path: string, depth: number) => {
        if (out.length >= limits.max) return;
        if (at !== null && typeof at === "object" && depth < limits.depth) {
            const entries = Array.isArray(at)
                ? at.length
                    ? [["0", at[0]] as const]
                    : []
                : Object.entries(at);
            if (entries.length === 0) out.push({ path, preview: preview(at) });
            for (const [key, entry] of entries)
                if (/^[\w-]+$/.test(key)) visit(entry, `${path}.${key}`, depth + 1);
            return;
        }
        out.push({ path, preview: preview(at) });
    };
    visit(value, prefix, 0);
    return out;
}

/** Nodes upstream of `nodeId`, nearest first. */
export function upstreamOf(graph: graphs.AutomationGraph, nodeId: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>([nodeId]);
    let frontier = [nodeId];
    while (frontier.length) {
        const next: string[] = [];
        for (const at of frontier)
            for (const edge of graph.edges)
                if (edge.to.node === at && !seen.has(edge.from.node)) {
                    seen.add(edge.from.node);
                    order.push(edge.from.node);
                    next.push(edge.from.node);
                }
        frontier = next;
    }
    return order;
}

/**
 * What a field of `nodeId` may reference: the trigger's values, every earlier
 * step's output, and in the Always lane the run's outcome and every main-flow
 * step. Paths come from a sample (a pinned one or the last test run's output)
 * when there is one, else from what the node type is known to give.
 */
export function referenceOptions(
    graph: graphs.AutomationGraph,
    nodeId: string,
    samples: Readonly<Record<string, unknown>>
): ReferenceGroup[] {
    const lane = lanesOf(graph).get(nodeId);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const upstream = new Set(upstreamOf(graph, nodeId));
    if (lane === "finally")
        for (const [id, at] of lanesOf(graph)) if (at === "main") upstream.add(id);
    const groups: ReferenceGroup[] = [];
    const known = (node: graphs.GraphNode) =>
        graphs.isCoreNodeType(node.type) ? CORE_NODE_OUTPUT_PATHS[node.type] : [];
    for (const id of upstream) {
        const node = byId.get(id);
        if (!node) continue;
        const trigger = graphs.nodeRole(node.type) === "trigger";
        const root = trigger ? "trigger" : `steps.${id}`;
        const sample = node.pinned !== undefined ? node.pinned : samples[id];
        const fromSample = sample !== undefined && sample !== null;
        const options = fromSample
            ? samplePaths(sample, root)
            : known(node).map((path) => ({ path: `${root}.${path}` }));
        groups.push({ nodeId: id, root, fromSample, options });
    }
    if (lane === "finally")
        groups.push({
            nodeId: "run",
            root: "run",
            fromSample: false,
            options: ["status", "error", "startedAt", "id"].map((path) => ({ path: `run.${path}` }))
        });
    return groups;
}

/** Text with `{{path}}` put where the caret was (replacing a selection), and where the caret goes after it. */
export function insertReference(
    text: string,
    start: number,
    end: number,
    path: string
): { text: string; caret: number } {
    const from = Math.max(0, Math.min(start, text.length));
    const to = Math.max(from, Math.min(end, text.length));
    const token = `{{${path}}}`;
    return { text: text.slice(0, from) + token + text.slice(to), caret: from + token.length };
}

export type PartialRunRefusal = "notFound" | "notMainFlow" | "noTriggerData" | "missingData";

export type PartialRun =
    | {
          readonly graph: graphs.AutomationGraph;
          readonly triggerId: string;
          readonly cause: unknown;
      }
    | { readonly refusal: PartialRunRefusal; readonly nodes: readonly string[] };

/**
 * The graph a "Run from here" test runs: the chosen node and everything after
 * it really run; everything before it stands in with data it already has - its
 * pinned sample, else what it gave in the last test run (`samples`). Conditions
 * before it are worked out again from that data, which sends nothing. Branches
 * that do not lead to the node, other triggers and the Always lane are left out,
 * so nothing else is sent. The node's own pin is dropped: it is the one being
 * tried. Refused when a step before it has no data, naming those steps.
 */
export function partialRunGraph(
    graph: graphs.AutomationGraph,
    nodeId: string,
    samples: Readonly<Record<string, unknown>>
): PartialRun {
    const target = graph.nodes.find((node) => node.id === nodeId);
    if (!target || graphs.nodeRole(target.type) === "trigger")
        return { refusal: "notFound", nodes: [] };
    if (lanesOf(graph).get(nodeId) !== "main") return { refusal: "notMainFlow", nodes: [nodeId] };
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const data = (node: graphs.GraphNode) => {
        const value = node.pinned !== undefined ? node.pinned : samples[node.id];
        return value === undefined || value === null ? undefined : value;
    };
    const upstream = upstreamOf(graph, nodeId);
    const triggers = upstream
        .map((id) => byId.get(id)!)
        .filter((node) => graphs.nodeRole(node.type) === "trigger");
    const trigger = triggers.find((node) => data(node) !== undefined);
    if (!trigger) return { refusal: "noTriggerData", nodes: triggers.map((node) => node.id) };
    const fromTrigger = graphs.reachableFrom(graph, trigger.id);
    const before = upstream
        .filter((id) => id !== trigger.id && fromTrigger.has(id))
        .map((id) => byId.get(id)!);
    const missing = before
        .filter((node) => needsData(node) && data(node) === undefined)
        .map((node) => node.id);
    if (missing.length > 0) return { refusal: "missingData", nodes: missing };
    const after = graphs.reachableFrom(graph, nodeId);
    const keep = new Set<string>([trigger.id, ...before.map((node) => node.id), ...after]);
    const filled = new Set(before.filter((node) => needsData(node)).map((node) => node.id));
    const nodes = graph.nodes
        .filter((node) => keep.has(node.id))
        .map((node) => {
            if (node.id === nodeId) {
                const { pinned: _pinned, ...rest } = node;
                return rest;
            }
            return filled.has(node.id) ? { ...node, pinned: data(node) } : node;
        });
    return {
        graph: {
            ...graph,
            nodes,
            edges: graph.edges.filter((edge) => keep.has(edge.from.node) && keep.has(edge.to.node)),
            notes: [],
            finally: { ...graph.finally, entry: null }
        },
        triggerId: trigger.id,
        cause: data(trigger)
    };
}

/** A step that would send something if it ran: switched on and pinnable (conditions only read). */
function needsData(node: graphs.GraphNode): boolean {
    return node.enabled !== false && canPin(node.type);
}

/** Whether a node of this type may hold a pinned sample: triggers and actions, not conditions. */
export function canPin(type: string): boolean {
    return graphs.nodeRole(type) !== "condition";
}

/** The node types the palette offers, by role, in a stable order. */
export function paletteTypes(): {
    type: graphs.CoreNodeType;
    role: graphs.NodeRole;
}[] {
    return (Object.keys(graphs.CORE_NODE_META) as graphs.CoreNodeType[]).map((type) => ({
        type,
        role: graphs.CORE_NODE_META[type].role
    }));
}

// ---------------------------------------------------------------------------
// Comparing versions
// ---------------------------------------------------------------------------

/** The longest name a published version may be given. */
export const VERSION_NAME_LENGTH = 80;

export const versionNameSchema = z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(VERSION_NAME_LENGTH))
    .transform((value) => (value === "" ? null : value));

export interface GraphComparison {
    /** In `next`, not in `base`. */
    readonly added: readonly string[];
    /** In `base`, not in `next`. */
    readonly removed: readonly string[];
    /** In both, set up differently (settings, name, switch, retry, note). Moving one does not count. */
    readonly changed: readonly string[];
    /** Whether the connections or the Always lane differ. */
    readonly rewired: boolean;
}

/** What changed from `base` to `next`, node by node. Positions and pinned samples are not part of a version's meaning. */
export function compareGraphs(
    base: graphs.AutomationGraph,
    next: graphs.AutomationGraph
): GraphComparison {
    const shape = ({ position: _position, pinned: _pinned, ...node }: graphs.GraphNode) =>
        JSON.stringify(node);
    const before = new Map(base.nodes.map((node) => [node.id, node]));
    const after = new Map(next.nodes.map((node) => [node.id, node]));
    const wiring = (graph: graphs.AutomationGraph) =>
        JSON.stringify({ edges: graph.edges.map(edgeKey).sort(), finally: graph.finally });
    return {
        added: next.nodes.filter((node) => !before.has(node.id)).map((node) => node.id),
        removed: base.nodes.filter((node) => !after.has(node.id)).map((node) => node.id),
        changed: next.nodes
            .filter((node) => before.has(node.id) && shape(before.get(node.id)!) !== shape(node))
            .map((node) => node.id),
        rewired: wiring(base) !== wiring(next)
    };
}

// ---------------------------------------------------------------------------
// Folders and tags
// ---------------------------------------------------------------------------

export const AUTOMATION_ORGANIZE_LIMITS = {
    foldersPerShelf: 100,
    folderNameLength: 60,
    tagsPerAutomation: 10,
    tagLength: 32
} as const;

/** A folder name as stored: trimmed, inner spaces collapsed, never empty. */
export const automationFolderNameSchema = z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(AUTOMATION_ORGANIZE_LIMITS.folderNameLength));

/** One tag as stored: trimmed, lower case, inner spaces collapsed, so "Billing " and "billing" are one tag. */
export function normalizeAutomationTag(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export const automationTagSchema = z
    .string()
    .transform(normalizeAutomationTag)
    .pipe(z.string().min(1).max(AUTOMATION_ORGANIZE_LIMITS.tagLength));

/** An automation's tags: each normalized, duplicates dropped, at most ten. */
export const automationTagsSchema = z
    .array(automationTagSchema)
    .transform((tags) => [...new Set(tags)])
    .pipe(z.array(z.string()).max(AUTOMATION_ORGANIZE_LIMITS.tagsPerAutomation));
