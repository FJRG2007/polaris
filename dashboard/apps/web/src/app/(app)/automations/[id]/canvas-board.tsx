"use client";

/**
 * The free canvas of an automation's graph: nodes where they were put, ports
 * on their sides, connections drawn between them, the "Always, at the end"
 * lane as its own band, sticky notes, and an overview of a large graph.
 *
 * Drawn here with no graph library (none may come back: native-board-gestures).
 * Getting around is `useBoardGestures`, `zoomViewAt` and `fitBoard`, the same
 * hand as the Deploy board and the automation diagrams. What a gesture means
 * to the graph is decided by the pure functions in `core.automation-canvas`;
 * this file only turns pointer and key presses into calls to them.
 *
 * Gestures: drag the board to move it, the wheel or a pinch to zoom, drag a
 * node to move it (the whole selection when it is selected), drag from an
 * output port onto a node to connect, Shift+drag on the board to select an
 * area, Shift+click to add to the selection. Keys are listed in the help line.
 */

import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    LayoutGrid,
    Map as MapIcon,
    Maximize,
    Plus,
    StickyNote,
    ZoomIn,
    ZoomOut
} from "lucide-react";
import {
    Badge,
    Button,
    ContextMenu,
    ContextMenuContent,
    ContextMenuTrigger,
    cn,
    fitBoard,
    useBoardGestures,
    zoomViewAt,
    type BoardView
} from "@polaris/ui";
import {
    useCallback,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode
} from "react";

const N = core.CANVAS_NODE;
const LIMITS = { min: 0.2, max: 2 };
const FIT = { padding: 0.08, minZoom: 0.4, maxZoom: 1 };
const STEP = 1.2;
const GRID = 20;
const SLOP = 4;
const PORT = 12;

export interface CanvasSelection {
    readonly nodes: ReadonlySet<string>;
    readonly notes: ReadonlySet<string>;
    readonly edge: string | null;
}

export const NO_SELECTION: CanvasSelection = { nodes: new Set(), notes: new Set(), edge: null };

type Point = { x: number; y: number };

const STATE_RING: Record<string, string> = {
    ok: "border-success-edge",
    failed: "border-danger-edge",
    refused: "border-danger-edge",
    timedOut: "border-danger-edge",
    interrupted: "border-danger-edge",
    waiting: "border-primary",
    running: "border-primary",
    ready: "border-primary"
};
const STATE_BADGE: Record<string, "success" | "danger" | "primary" | "neutral" | "warning"> = {
    ok: "success",
    failed: "danger",
    refused: "danger",
    timedOut: "danger",
    interrupted: "danger",
    waiting: "primary",
    running: "primary",
    ready: "primary",
    skipped: "neutral"
};

export function portAnchor(node: core.GraphNode, port: string | null): Point {
    const at = node.position ?? { x: 0, y: 0 };
    if (port === null) return { x: at.x, y: at.y + N.height / 2 };
    const ports = core.nodePorts(node.type);
    const index = Math.max(0, ports.indexOf(port));
    return { x: at.x + N.width, y: at.y + (N.height * (index + 1)) / (ports.length + 1) };
}

export function wirePath(from: Point, to: Point): string {
    const reach = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    return `M${from.x},${from.y} C${from.x + reach},${from.y} ${to.x - reach},${to.y} ${to.x},${to.y}`;
}

/** The middle of the curve `wirePath` draws, where its insert button sits. */
export function wireMiddle(from: Point, to: Point): Point {
    const reach = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    return {
        x: (from.x + 3 * (from.x + reach) + 3 * (to.x - reach) + to.x) / 8,
        y: (from.y + to.y) / 2
    };
}

export interface CanvasBoardProps {
    readonly graph: core.AutomationGraph;
    readonly readOnly: boolean;
    readonly selection: CanvasSelection;
    readonly onSelect: (selection: CanvasSelection) => void;
    readonly onChange: (
        update: (graph: core.AutomationGraph) => core.AutomationGraph,
        options?: { group?: boolean }
    ) => void;
    readonly onOpen: (nodeId: string) => void;
    readonly onPalette: () => void;
    /** Add a node on a connection, between its two ends. */
    readonly onInsert?: (edgeKey: string) => void;
    /** Lay every node out again. */
    readonly onTidy?: () => void;
    readonly onAddNote: (at: Point) => void;
    readonly onRefused: (code: core.ConnectRefusal) => void;
    readonly onKey?: (event: KeyboardEvent<HTMLDivElement>, center: () => Point) => boolean;
    readonly title: (node: core.GraphNode) => string;
    readonly subtitle: (node: core.GraphNode) => string | null;
    readonly incomplete: (node: core.GraphNode) => boolean;
    /** Each node's step status in the run being shown. */
    readonly states?: Readonly<Record<string, string>>;
    /** The items of a node's right-click menu; the node is selected first when it was not already. */
    readonly menu?: (node: core.GraphNode) => ReactNode;
    /** Bumped by the editor to frame the whole graph again (after a tidy). */
    readonly refit?: number;
}

export function CanvasBoard(props: CanvasBoardProps) {
    const { graph, readOnly, selection, onSelect, onChange, states } = props;
    const t = useTranslations("automations");
    const frame = useRef<HTMLDivElement>(null);
    const [view, setView] = useState<BoardView>({ x: 0, y: 0, zoom: 1 });
    const viewRef = useRef(view);
    viewRef.current = view;
    const [drag, setDrag] = useState<Point | null>(null);
    const [wire, setWire] = useState<{ from: { node: string; port: string }; to: Point } | null>(
        null
    );
    const [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null);
    const [editingNote, setEditingNote] = useState<string | null>(null);
    const [overview, setOverview] = useState(graph.nodes.length >= 8);
    const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
    const [resizing, setResizing] = useState<{ id: string; width: number; height: number } | null>(
        null
    );
    const shift = useRef(false);
    const help = useId();

    const toBoard = useCallback((clientX: number, clientY: number): Point => {
        const rect = frame.current?.getBoundingClientRect();
        const current = viewRef.current;
        return {
            x: (clientX - (rect?.left ?? 0) - current.x) / current.zoom,
            y: (clientY - (rect?.top ?? 0) - current.y) / current.zoom
        };
    }, []);

    const center = useCallback((): Point => {
        const rect = frame.current?.getBoundingClientRect();
        return toBoard(
            (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
            (rect?.top ?? 0) + (rect?.height ?? 0) / 2
        );
    }, [toBoard]);

    const fit = useCallback(() => {
        const element = frame.current;
        const bounds = core.graphBounds(graph);
        if (!element || !bounds) return;
        const rect = element.getBoundingClientRect();
        setView(fitBoard(bounds, { width: rect.width, height: rect.height }, FIT));
    }, [graph]);

    // Framed once, when first drawn; afterwards the reader's view is theirs.
    const framed = useRef(false);
    useLayoutEffect(() => {
        if (framed.current) return;
        framed.current = true;
        fit();
    }, [fit]);

    const refit = useRef(props.refit);
    useLayoutEffect(() => {
        if (refit.current === props.refit) return;
        refit.current = props.refit;
        fit();
    }, [props.refit, fit]);

    useBoardGestures(frame, {
        onZoom: (factor, at) => setView((current) => zoomViewAt(current, factor, at, LIMITS)),
        onPan: (dx, dy) =>
            setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy })),
        grabs: (target) =>
            !shift.current &&
            !target.closest("[data-canvas-item], [data-port], button, textarea, input")
    });

    const zoomCentre = (factor: number) => {
        const rect = frame.current?.getBoundingClientRect();
        setView((current) =>
            zoomViewAt(
                current,
                factor,
                { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 },
                LIMITS
            )
        );
    };

    // ---- moving the selection -------------------------------------------------
    function pressItem(event: ReactPointerEvent, kind: "node" | "note", id: string): void {
        if (event.button !== 0) return;
        event.stopPropagation();
        const inSelection = kind === "node" ? selection.nodes.has(id) : selection.notes.has(id);
        let picked = selection;
        if (event.shiftKey) {
            const nodes = new Set(selection.nodes);
            const notes = new Set(selection.notes);
            const set = kind === "node" ? nodes : notes;
            if (set.has(id)) set.delete(id);
            else set.add(id);
            picked = { nodes, notes, edge: null };
            onSelect(picked);
            return;
        }
        if (!inSelection) {
            picked =
                kind === "node"
                    ? { nodes: new Set([id]), notes: new Set(), edge: null }
                    : { nodes: new Set(), notes: new Set([id]), edge: null };
            onSelect(picked);
        }
        if (readOnly) return;
        const start = { x: event.clientX, y: event.clientY };
        let moved: Point | null = null;
        const move = (next: PointerEvent) => {
            const zoom = viewRef.current.zoom;
            const delta = {
                x: (next.clientX - start.x) / zoom,
                y: (next.clientY - start.y) / zoom
            };
            if (
                !moved &&
                Math.abs(next.clientX - start.x) + Math.abs(next.clientY - start.y) <= SLOP
            )
                return;
            moved = delta;
            setDrag(delta);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            setDrag(null);
            if (moved) {
                const delta = moved;
                onChange(
                    (current) =>
                        core.moveInGraph(current, picked.nodes, picked.notes, delta.x, delta.y),
                    { group: false }
                );
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    // ---- resizing a note --------------------------------------------------------
    function pressResize(event: ReactPointerEvent, note: core.GraphNote): void {
        if (event.button !== 0 || readOnly) return;
        event.stopPropagation();
        event.preventDefault();
        const start = { x: event.clientX, y: event.clientY };
        let size: { width: number; height: number } | null = null;
        const move = (next: PointerEvent) => {
            const zoom = viewRef.current.zoom;
            size = core.clampNoteSize({
                width: note.size.width + (next.clientX - start.x) / zoom,
                height: note.size.height + (next.clientY - start.y) / zoom
            });
            setResizing({ id: note.id, ...size });
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            setResizing(null);
            if (size) {
                const done = size;
                onChange((current) => core.resizeNote(current, note.id, done), { group: false });
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    // ---- connecting -----------------------------------------------------------
    function pressPort(event: ReactPointerEvent, from: { node: string; port: string }): void {
        if (event.button !== 0 || readOnly) return;
        event.stopPropagation();
        event.preventDefault();
        setWire({ from, to: toBoard(event.clientX, event.clientY) });
        const move = (next: PointerEvent) =>
            setWire({ from, to: toBoard(next.clientX, next.clientY) });
        const up = (next: PointerEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            setWire(null);
            const over = document
                .elementFromPoint(next.clientX, next.clientY)
                ?.closest<HTMLElement>("[data-node-id]");
            const target = over?.dataset.nodeId;
            if (!target) return;
            const refusal = core.connectRefusal(graph, from, target);
            if (refusal) return props.onRefused(refusal);
            onChange((current) => core.connect(current, from, target), { group: false });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    // ---- selecting an area ------------------------------------------------------
    function pressBoard(event: ReactPointerEvent<HTMLDivElement>): void {
        shift.current = event.shiftKey;
        if (!event.shiftKey || event.button !== 0) return;
        const target = event.target as Element;
        if (target.closest("[data-canvas-item], [data-port], button")) return;
        const a = toBoard(event.clientX, event.clientY);
        setMarquee({ a, b: a });
        const move = (next: PointerEvent) =>
            setMarquee({ a, b: toBoard(next.clientX, next.clientY) });
        const up = (next: PointerEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            shift.current = false;
            setMarquee(null);
            const b = toBoard(next.clientX, next.clientY);
            const box = {
                left: Math.min(a.x, b.x),
                right: Math.max(a.x, b.x),
                top: Math.min(a.y, b.y),
                bottom: Math.max(a.y, b.y)
            };
            const inside = (at: Point, width: number, height: number) =>
                at.x < box.right &&
                at.x + width > box.left &&
                at.y < box.bottom &&
                at.y + height > box.top;
            onSelect({
                nodes: new Set([
                    ...selection.nodes,
                    ...graph.nodes
                        .filter((node) =>
                            inside(node.position ?? { x: 0, y: 0 }, N.width, N.height)
                        )
                        .map((node) => node.id)
                ]),
                notes: new Set([
                    ...selection.notes,
                    ...graph.notes
                        .filter((note) => inside(note.position, note.size.width, note.size.height))
                        .map((note) => note.id)
                ]),
                edge: null
            });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // ---- keys -------------------------------------------------------------------
    function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, [role=menu]")) return;
        if (props.onKey?.(event, center)) return;
        const key = event.key;
        if (key === "+" || key === "=") zoomCentre(STEP);
        else if (key === "-") zoomCentre(1 / STEP);
        else if (key === "1" && !event.ctrlKey && !event.metaKey) fit();
        else if (key === "0" && !event.ctrlKey && !event.metaKey)
            setView((current) => zoomViewAt(current, 1 / current.zoom, { x: 0, y: 0 }, LIMITS));
        else if (
            key.startsWith("Arrow") &&
            event.altKey &&
            !readOnly &&
            selection.notes.size === 1 &&
            selection.nodes.size === 0
        ) {
            const note = graph.notes.find((entry) => selection.notes.has(entry.id));
            if (!note) return;
            const by = event.shiftKey ? 60 : 20;
            const width =
                note.size.width + (key === "ArrowLeft" ? -by : key === "ArrowRight" ? by : 0);
            const height =
                note.size.height + (key === "ArrowUp" ? -by : key === "ArrowDown" ? by : 0);
            onChange((current) => core.resizeNote(current, note.id, { width, height }));
        } else if (
            key.startsWith("Arrow") &&
            !readOnly &&
            (selection.nodes.size > 0 || selection.notes.size > 0)
        ) {
            const by = event.shiftKey ? 60 : 12;
            const dx = key === "ArrowLeft" ? -by : key === "ArrowRight" ? by : 0;
            const dy = key === "ArrowUp" ? -by : key === "ArrowDown" ? by : 0;
            onChange((current) =>
                core.moveInGraph(current, selection.nodes, selection.notes, dx, dy)
            );
        } else if (key === "Escape") onSelect(NO_SELECTION);
        else return;
        event.preventDefault();
    }

    // ---- drawing ----------------------------------------------------------------
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const shifted = (node: core.GraphNode): core.GraphNode =>
        drag && selection.nodes.has(node.id)
            ? {
                  ...node,
                  position: {
                      x: (node.position?.x ?? 0) + drag.x,
                      y: (node.position?.y ?? 0) + drag.y
                  }
              }
            : node;
    const lanes = core.lanesOf(graph);
    const band = core.finallyBand(graph);
    const bounds = core.graphBounds(graph) ?? { x: 0, y: 0, width: N.width, height: N.height };
    const bandLeft = Math.min(bounds.x, 0) - 48;
    const bandWidth = Math.max(bounds.width, N.width * 2) + 96;
    const finallySource = { x: bandLeft, y: (band.top + band.bottom) / 2 };

    const edges = graph.edges.map((edge) => {
        const from = byId.get(edge.from.node);
        const to = byId.get(edge.to.node);
        if (!from || !to) return null;
        const a = portAnchor(shifted(from), edge.from.port);
        const b = portAnchor(shifted(to), null);
        return { key: core.edgeKey(edge), d: wirePath(a, b), middle: wireMiddle(a, b) };
    });
    const entry = graph.finally.entry ? byId.get(graph.finally.entry) : undefined;
    if (entry) {
        const b = portAnchor(shifted(entry), null);
        edges.push({
            key: `${core.FINALLY_SOURCE}>${entry.id}`,
            d: wirePath(finallySource, b),
            middle: wireMiddle(finallySource, b)
        });
    }
    const insertAt =
        !readOnly && props.onInsert && !drag && !wire
            ? edges.find(
                  (edge) => edge && (edge.key === hoveredEdge || edge.key === selection.edge)
              )
            : undefined;

    const frameRect = frame.current?.getBoundingClientRect();

    return (
        <div
            ref={frame}
            tabIndex={0}
            role="application"
            aria-roledescription={t("canvas.board")}
            aria-describedby={help}
            className="relative h-full min-h-[24rem] w-full cursor-grab touch-none overflow-hidden rounded-lg border border-border bg-surface outline-none data-[panning]:cursor-grabbing"
            style={{
                backgroundImage: "radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)",
                backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`,
                backgroundPosition: `${view.x}px ${view.y}px`
            }}
            onPointerDownCapture={pressBoard}
            onKeyDown={keyDown}
            onClick={(event) => {
                if (
                    !(event.target as Element).closest(
                        "[data-canvas-item], [data-edge], button, [data-port]"
                    )
                )
                    onSelect(NO_SELECTION);
            }}
        >
            <p id={help} className="sr-only">
                {readOnly ? t("canvas.helpReadOnly") : t("canvas.help")}
            </p>
            <div
                className="absolute left-0 top-0 origin-top-left"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
            >
                <div
                    className="absolute rounded-lg border border-dashed border-border-strong bg-card/40"
                    style={{
                        left: bandLeft,
                        top: band.top,
                        width: bandWidth,
                        height: band.bottom - band.top
                    }}
                    aria-hidden="true"
                >
                    <span className="absolute left-6 top-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("editor.always")}
                    </span>
                    {!graph.finally.entry ? (
                        <span className="absolute left-6 top-6 max-w-[16rem] text-xs text-foreground-subtle">
                            {readOnly ? t("canvas.alwaysEmpty") : t("canvas.alwaysHint")}
                        </span>
                    ) : null}
                </div>
                <svg
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 top-0 overflow-visible"
                    width={1}
                    height={1}
                >
                    {edges.map((edge) =>
                        edge ? (
                            <g key={edge.key}>
                                <path
                                    d={edge.d}
                                    data-edge
                                    fill="none"
                                    stroke="transparent"
                                    strokeWidth={14}
                                    style={{
                                        pointerEvents: readOnly ? "none" : "stroke",
                                        cursor: "pointer"
                                    }}
                                    onPointerEnter={() => setHoveredEdge(edge.key)}
                                    onPointerLeave={() =>
                                        setHoveredEdge((current) =>
                                            current === edge.key ? null : current
                                        )
                                    }
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onSelect({
                                            nodes: new Set(),
                                            notes: new Set(),
                                            edge: edge.key
                                        });
                                    }}
                                />
                                <path
                                    d={edge.d}
                                    fill="none"
                                    stroke={
                                        selection.edge === edge.key
                                            ? "hsl(var(--primary))"
                                            : "hsl(var(--border-strong))"
                                    }
                                    strokeWidth={selection.edge === edge.key ? 2.5 : 1.5}
                                />
                            </g>
                        ) : null
                    )}
                    {wire ? (
                        <path
                            d={wirePath(
                                wire.from.node === core.FINALLY_SOURCE
                                    ? finallySource
                                    : portAnchor(byId.get(wire.from.node)!, wire.from.port),
                                wire.to
                            )}
                            fill="none"
                            stroke="hsl(var(--primary))"
                            strokeWidth={2}
                            strokeDasharray="5 4"
                        />
                    ) : null}
                </svg>
                {insertAt ? (
                    <button
                        type="button"
                        aria-label={t("canvas.insertHere")}
                        title={t("canvas.insertHere")}
                        className="absolute flex size-6 items-center justify-center rounded-full border border-border-strong bg-elevated text-muted-foreground shadow-popover hover:border-primary hover:text-primary focus-visible:border-primary"
                        style={{ left: insertAt.middle.x - 12, top: insertAt.middle.y - 12 }}
                        onPointerEnter={() => setHoveredEdge(insertAt.key)}
                        onPointerLeave={() => setHoveredEdge(null)}
                        onClick={(event) => {
                            event.stopPropagation();
                            setHoveredEdge(null);
                            props.onInsert?.(insertAt.key);
                        }}
                    >
                        <Plus className="size-3.5" aria-hidden="true" />
                    </button>
                ) : null}
                {!readOnly ? (
                    <span
                        data-port
                        role="presentation"
                        title={t("canvas.alwaysStart")}
                        className="absolute cursor-crosshair rounded-full border-2 border-background bg-muted-foreground hover:bg-primary"
                        style={{
                            left: finallySource.x - PORT / 2,
                            top: finallySource.y - PORT / 2,
                            width: PORT,
                            height: PORT
                        }}
                        onPointerDown={(event) =>
                            pressPort(event, { node: core.FINALLY_SOURCE, port: "next" })
                        }
                    />
                ) : null}
                {graph.notes.map((note) => {
                    const at =
                        drag && selection.notes.has(note.id)
                            ? { x: note.position.x + drag.x, y: note.position.y + drag.y }
                            : note.position;
                    const selected = selection.notes.has(note.id);
                    const size = resizing?.id === note.id ? resizing : note.size;
                    return (
                        <div
                            key={note.id}
                            data-canvas-item
                            className={cn(
                                "absolute overflow-hidden rounded-md border bg-warning-soft p-2 text-xs text-foreground",
                                selected
                                    ? "border-primary ring-1 ring-primary"
                                    : "border-warning-edge"
                            )}
                            style={{
                                left: at.x,
                                top: at.y,
                                width: size.width,
                                height: size.height
                            }}
                            onPointerDown={(event) =>
                                editingNote !== note.id && pressItem(event, "note", note.id)
                            }
                            onDoubleClick={() => !readOnly && setEditingNote(note.id)}
                        >
                            {editingNote === note.id ? (
                                <textarea
                                    autoFocus
                                    aria-label={t("canvas.note")}
                                    maxLength={core.AUTOMATION_LIMITS.noteLength}
                                    className="size-full resize-none bg-transparent outline-none"
                                    defaultValue={note.text}
                                    onBlur={(event) => {
                                        const text = event.target.value;
                                        setEditingNote(null);
                                        if (text !== note.text)
                                            onChange((current) => ({
                                                ...current,
                                                notes: current.notes.map((entry) =>
                                                    entry.id === note.id
                                                        ? { ...entry, text }
                                                        : entry
                                                )
                                            }));
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Escape")
                                            (event.target as HTMLTextAreaElement).blur();
                                        event.stopPropagation();
                                    }}
                                />
                            ) : (
                                <p className="whitespace-pre-wrap break-words">
                                    {note.text || (
                                        <span className="text-foreground-subtle">
                                            {t("canvas.notePlaceholder")}
                                        </span>
                                    )}
                                </p>
                            )}
                            {selected && !readOnly && editingNote !== note.id ? (
                                <span
                                    data-port
                                    role="presentation"
                                    title={t("canvas.resizeNote")}
                                    className="absolute bottom-0 right-0 size-3 cursor-nwse-resize rounded-tl-sm border-l border-t border-warning-edge bg-warning-edge/60"
                                    onPointerDown={(event) => pressResize(event, note)}
                                />
                            ) : null}
                        </div>
                    );
                })}
                {graph.nodes.map((raw) => {
                    const node = shifted(raw);
                    const at = node.position ?? { x: 0, y: 0 };
                    const selected = selection.nodes.has(node.id);
                    const state = states?.[node.id];
                    const ports = core.nodePorts(node.type);
                    const trigger = core.nodeRole(node.type) === "trigger";
                    const subtitle = props.subtitle(node);
                    const card = (
                        <div
                            key={node.id}
                            data-canvas-item
                            data-node-id={node.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={selected}
                            aria-label={`${props.title(node)}${state ? ` - ${t(`stepStatus.${stepKey(state)}`)}` : ""}`}
                            className={cn(
                                "absolute flex items-center gap-2 rounded-lg border-2 bg-card px-3 shadow-none",
                                state ? (STATE_RING[state] ?? "border-border") : "border-border",
                                selected &&
                                    "ring-2 ring-primary ring-offset-1 ring-offset-background",
                                node.enabled === false && "opacity-60",
                                state === "skipped" && "opacity-60",
                                !readOnly && "cursor-grab"
                            )}
                            style={{ left: at.x, top: at.y, width: N.width, height: N.height }}
                            onPointerDown={(event) => pressItem(event, "node", node.id)}
                            onContextMenu={() =>
                                !selected &&
                                onSelect({
                                    nodes: new Set([node.id]),
                                    notes: new Set(),
                                    edge: null
                                })
                            }
                            onDoubleClick={() => props.onOpen(node.id)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onSelect({
                                        nodes: new Set([node.id]),
                                        notes: new Set(),
                                        edge: null
                                    });
                                    props.onOpen(node.id);
                                }
                            }}
                            onFocus={(event) => {
                                // Only a keyboard arrival selects: a press already chose (and Shift+click added to) the selection.
                                if (!selected && !drag && focusedByKey(event.currentTarget))
                                    onSelect({
                                        nodes: new Set([node.id]),
                                        notes: new Set(),
                                        edge: null
                                    });
                            }}
                        >
                            <div className="min-w-0 flex-1">
                                <p
                                    className="truncate text-sm font-medium"
                                    title={props.title(node)}
                                >
                                    {props.title(node)}
                                </p>
                                {subtitle ? (
                                    <p
                                        className="truncate text-xs text-muted-foreground"
                                        title={subtitle}
                                    >
                                        {subtitle}
                                    </p>
                                ) : null}
                                <div className="mt-0.5 flex min-w-0 gap-1">
                                    {props.incomplete(node) ? (
                                        <span className="truncate text-[11px] text-warning-ink">
                                            {t("runErrors.badConfig")}
                                        </span>
                                    ) : null}
                                    {node.pinned !== undefined ? (
                                        <span className="truncate text-[11px] text-primary">
                                            {t("canvas.pinned")}
                                        </span>
                                    ) : null}
                                    {node.enabled === false ? (
                                        <span className="truncate text-[11px] text-muted-foreground">
                                            {t("canvas.off")}
                                        </span>
                                    ) : null}
                                    {lanes.get(node.id) === "loose" && !trigger ? (
                                        <span className="truncate text-[11px] text-foreground-subtle">
                                            {t("canvas.loose")}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                            {state ? (
                                <Badge
                                    variant={STATE_BADGE[state] ?? "neutral"}
                                    className="shrink-0"
                                >
                                    {t(`stepStatus.${stepKey(state)}`)}
                                </Badge>
                            ) : null}
                            {!trigger ? (
                                <span
                                    aria-hidden="true"
                                    className="pointer-events-none absolute rounded-full border-2 border-background bg-border-strong"
                                    style={{
                                        left: -PORT / 2,
                                        top: N.height / 2 - PORT / 2,
                                        width: PORT,
                                        height: PORT
                                    }}
                                />
                            ) : null}
                            {ports.map((port, index) => {
                                const y = (N.height * (index + 1)) / (ports.length + 1);
                                return (
                                    <span key={port}>
                                        {port !== "next" ? (
                                            <span
                                                className="pointer-events-none absolute text-[10px] font-medium text-muted-foreground"
                                                style={{ right: 10, top: y - 7 }}
                                            >
                                                {t(
                                                    `canvas.ports.${port === "then" ? "then" : port === "else" ? "else" : "next"}`
                                                )}
                                            </span>
                                        ) : null}
                                        <span
                                            data-port
                                            role="presentation"
                                            title={t("canvas.dragToConnect")}
                                            className={cn(
                                                "absolute rounded-full border-2 border-background bg-muted-foreground",
                                                !readOnly && "cursor-crosshair hover:bg-primary"
                                            )}
                                            style={{
                                                left: N.width - PORT / 2,
                                                top: y - PORT / 2,
                                                width: PORT,
                                                height: PORT
                                            }}
                                            onPointerDown={(event) =>
                                                pressPort(event, { node: node.id, port })
                                            }
                                        />
                                    </span>
                                );
                            })}
                        </div>
                    );
                    return props.menu ? (
                        <ContextMenu key={node.id}>
                            <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
                            <ContextMenuContent>{props.menu(raw)}</ContextMenuContent>
                        </ContextMenu>
                    ) : (
                        card
                    );
                })}
                {marquee ? (
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute border border-primary bg-primary/10"
                        style={{
                            left: Math.min(marquee.a.x, marquee.b.x),
                            top: Math.min(marquee.a.y, marquee.b.y),
                            width: Math.abs(marquee.a.x - marquee.b.x),
                            height: Math.abs(marquee.a.y - marquee.b.y)
                        }}
                    />
                ) : null}
            </div>

            {overview && frameRect ? (
                <Overview
                    graph={graph}
                    view={view}
                    frame={{ width: frameRect.width, height: frameRect.height }}
                    onCentre={(at) =>
                        setView((current) => ({
                            ...current,
                            x: frameRect.width / 2 - at.x * current.zoom,
                            y: frameRect.height / 2 - at.y * current.zoom
                        }))
                    }
                    label={t("canvas.minimap")}
                />
            ) : null}

            <div
                className="absolute bottom-2 right-2 flex items-center rounded-md border border-border bg-elevated shadow-popover"
                onClick={(event) => event.stopPropagation()}
            >
                {!readOnly ? (
                    <>
                        <ToolButton label={t("canvas.addNode")} onClick={props.onPalette}>
                            <Plus aria-hidden="true" />
                        </ToolButton>
                        <ToolButton
                            label={t("canvas.addNote")}
                            onClick={() => props.onAddNote(center())}
                        >
                            <StickyNote aria-hidden="true" />
                        </ToolButton>
                        {props.onTidy && graph.nodes.length > 1 ? (
                            <ToolButton label={t("canvas.tidy")} onClick={props.onTidy}>
                                <LayoutGrid aria-hidden="true" />
                            </ToolButton>
                        ) : null}
                    </>
                ) : null}
                <ToolButton label={t("canvas.zoomIn")} onClick={() => zoomCentre(STEP)}>
                    <ZoomIn aria-hidden="true" />
                </ToolButton>
                <ToolButton label={t("canvas.zoomOut")} onClick={() => zoomCentre(1 / STEP)}>
                    <ZoomOut aria-hidden="true" />
                </ToolButton>
                <ToolButton label={t("canvas.fit")} onClick={fit}>
                    <Maximize aria-hidden="true" />
                </ToolButton>
                <ToolButton
                    label={t("canvas.minimap")}
                    pressed={overview}
                    onClick={() => setOverview(!overview)}
                >
                    <MapIcon aria-hidden="true" />
                </ToolButton>
            </div>
        </div>
    );
}

function focusedByKey(element: Element): boolean {
    try {
        return element.matches(":focus-visible");
    } catch {
        return true;
    }
}

const STEP_KEYS = [
    "ready",
    "running",
    "waiting",
    "ok",
    "failed",
    "skipped",
    "refused",
    "timedOut",
    "interrupted"
] as const;
export function stepKey(status: string): (typeof STEP_KEYS)[number] {
    return (STEP_KEYS as readonly string[]).includes(status)
        ? (status as (typeof STEP_KEYS)[number])
        : "failed";
}

function ToolButton({
    label,
    pressed,
    onClick,
    children
}: {
    label: string;
    pressed?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <Button
            size="sm"
            variant="ghost"
            className="size-8 p-0"
            aria-label={label}
            title={label}
            aria-pressed={pressed}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}

/** The whole graph in miniature with the part on screen outlined; a click centres the board there. */
function Overview({
    graph,
    view,
    frame,
    onCentre,
    label
}: {
    graph: core.AutomationGraph;
    view: BoardView;
    frame: { width: number; height: number };
    onCentre: (at: Point) => void;
    label: string;
}) {
    const width = 176;
    const height = 112;
    const bounds = core.graphBounds(graph);
    if (!bounds) return null;
    const pad = 40;
    const scale = Math.min(width / (bounds.width + pad * 2), height / (bounds.height + pad * 2));
    const ox = bounds.x - pad;
    const oy = bounds.y - pad;
    const seen = {
        x: -view.x / view.zoom,
        y: -view.y / view.zoom,
        width: frame.width / view.zoom,
        height: frame.height / view.zoom
    };
    return (
        <svg
            role="img"
            aria-label={label}
            width={width}
            height={height}
            className="absolute bottom-2 left-2 cursor-pointer rounded-md border border-border bg-elevated shadow-popover"
            onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                onCentre({
                    x: (event.clientX - rect.left) / scale + ox,
                    y: (event.clientY - rect.top) / scale + oy
                });
            }}
        >
            {graph.nodes.map((node) => (
                <rect
                    key={node.id}
                    x={((node.position?.x ?? 0) - ox) * scale}
                    y={((node.position?.y ?? 0) - oy) * scale}
                    width={N.width * scale}
                    height={N.height * scale}
                    rx={2}
                    fill="hsl(var(--border-strong))"
                />
            ))}
            {graph.notes.map((note) => (
                <rect
                    key={note.id}
                    x={(note.position.x - ox) * scale}
                    y={(note.position.y - oy) * scale}
                    width={note.size.width * scale}
                    height={note.size.height * scale}
                    rx={2}
                    fill="hsl(var(--warning) / 0.4)"
                />
            ))}
            <rect
                x={(seen.x - ox) * scale}
                y={(seen.y - oy) * scale}
                width={seen.width * scale}
                height={seen.height * scale}
                fill="none"
                stroke="hsl(var(--primary))"
                strokeWidth={1.5}
            />
        </svg>
    );
}
