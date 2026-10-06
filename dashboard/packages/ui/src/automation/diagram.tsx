"use client";

/**
 * The automation diagram itself: nodes on a dotted board, the lines between
 * them, and the hand that gets around it.
 *
 * Drawn here rather than by a diagram library. What an automation needs of one
 * is small - nodes that sit where the layout puts them, lines from one side of
 * a node to a side of another, a drag up or down that reorders, the keyboard -
 * and a library for it was a dependency, a stylesheet and its own credit in the
 * corner of every editor. The board answers the same gestures as the Deploy
 * board (`useBoardGestures`): the wheel zooms towards the pointer, dragging the
 * board moves it, two fingers pinch.
 *
 * Positions are the layout's (`graph.ts`): a condition's is inside its group.
 * The canvas decides what a move means; this only reports where a node was
 * dropped, a nudge of one place, or a removal.
 */

import { cn } from "../lib/cn";
import * as graphs from "./graph";
import { Button } from "../components/button";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import {
    fitBoard,
    swallowNextClick,
    useBoardGestures,
    zoomViewAt,
    type BoardBounds,
    type BoardView
} from "../lib/board-gestures";
import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode
} from "react";

export interface DiagramNode {
    readonly id: string;
    readonly role: graphs.GraphNodeType;
    /** The layout's position: a condition's is inside its group. */
    readonly position: graphs.Position;
    readonly parentId?: string;
    readonly width: number;
    readonly height: number;
    readonly draggable: boolean;
    readonly deletable: boolean;
    readonly ariaLabel: string;
}

export interface DiagramLabels {
    readonly zoomIn: string;
    readonly zoomOut: string;
    readonly fit: string;
    readonly help: string;
    readonly moved: string;
}

/** How the whole diagram is framed: never past life size, and never so small
 *  that a node's words cannot be read - a long automation is moved instead. */
const FIT = { padding: 0.1, maxZoom: 1, minZoom: 0.6 };
const LIMITS = { min: 0.25, max: 1.75 };
const STEP = 1.2;
const GRID = 20;
/** How far a press on a node may wander and still be a click. */
const SLOP = 4;
const HANDLE = 8;

type Side = "left" | "right" | "top" | "bottom";

/** Where each kind of node is joined, by handle. */
const SIDES: Readonly<Record<graphs.GraphNodeType, Readonly<Record<string, Side>>>> = {
    trigger: { out: "right" },
    gate: { in: "left", conditions: "bottom", out: "right" },
    group: { out: "top" },
    condition: {},
    step: { in: "left", prev: "top", out: "bottom" }
};

interface Box {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

function anchor(box: Box, side: Side): graphs.Position {
    if (side === "left") return { x: box.x, y: box.y + box.height / 2 };
    if (side === "right") return { x: box.x + box.width, y: box.y + box.height / 2 };
    if (side === "top") return { x: box.x + box.width / 2, y: box.y };
    return { x: box.x + box.width / 2, y: box.y + box.height };
}

const OUTWARD: Readonly<Record<Side, graphs.Position>> = {
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
    top: { x: 0, y: -1 },
    bottom: { x: 0, y: 1 }
};

/** A curve leaving one side and arriving at another, as diagram tools draw
 *  them: each end leaves straight out of its side before it bends. Exported
 *  for the tests. */
export function edgePath(
    from: graphs.Position,
    fromSide: Side,
    to: graphs.Position,
    toSide: Side
): string {
    const reach = Math.max(30, Math.hypot(to.x - from.x, to.y - from.y) * 0.4);
    const a = { x: from.x + OUTWARD[fromSide].x * reach, y: from.y + OUTWARD[fromSide].y * reach };
    const b = { x: to.x + OUTWARD[toSide].x * reach, y: to.y + OUTWARD[toSide].y * reach };
    return `M${from.x},${from.y} C${a.x},${a.y} ${b.x},${b.y} ${to.x},${to.y}`;
}

function boundsOf(boxes: readonly Box[]): BoardBounds | null {
    if (boxes.length === 0) return null;
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

export function Diagram({
    nodes,
    edges,
    selectedId,
    readOnly,
    labels,
    face,
    onSelect,
    onDrop,
    onNudge,
    onDelete
}: {
    nodes: readonly DiagramNode[];
    edges: readonly graphs.GraphEdge[];
    selectedId: string | null;
    readOnly: boolean;
    labels: DiagramLabels;
    /** What a node looks like. */
    face: (node: DiagramNode, selected: boolean) => ReactNode;
    onSelect: (id: string | null) => void;
    /** A node let go of somewhere else, at this layout position. */
    onDrop: (id: string, position: graphs.Position) => void;
    /** One place up or down, from the keyboard. */
    onNudge: (id: string, by: -1 | 1) => void;
    onDelete: (id: string) => void;
}) {
    const frame = useRef<HTMLDivElement>(null);
    const [view, setView] = useState<BoardView>({ x: 0, y: 0, zoom: 1 });
    const viewRef = useRef(view);
    viewRef.current = view;
    // The node being dragged, and where it is now.
    const [held, setHeld] = useState<{ id: string; position: graphs.Position } | null>(null);
    const [said, setSaid] = useState("");
    const help = useId();

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const positionOf = (node: DiagramNode): graphs.Position =>
        held?.id === node.id ? held.position : node.position;
    const boxOf = (node: DiagramNode): Box => {
        const own = positionOf(node);
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        const origin = parent ? boxOf(parent) : { x: 0, y: 0 };
        return { x: origin.x + own.x, y: origin.y + own.y, width: node.width, height: node.height };
    };

    const fit = useCallback(() => {
        const element = frame.current;
        const bounds = boundsOf(
            nodes
                .filter((node) => !node.parentId)
                .map((node) => ({ ...node.position, width: node.width, height: node.height }))
        );
        if (!element || !bounds) return;
        const rect = element.getBoundingClientRect();
        setView(fitBoard(bounds, { width: rect.width, height: rect.height }, FIT));
    }, [nodes]);

    // Framed when it is first drawn, and again when a node is added or the last
    // of a column removed, so what changed is in the frame rather than off it.
    const count = nodes.length;
    useLayoutEffect(() => {
        // Only the count decides it: refitting on every edit would undo every
        // move the reader made.
        fit();
    }, [count]);

    useBoardGestures(frame, {
        onZoom: (factor, at) => setView((current) => zoomViewAt(current, factor, at, LIMITS)),
        onPan: (dx, dy) =>
            setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy })),
        grabs: (target) => !target.closest("[data-flow-node], button")
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

    useEffect(() => {
        if (!said) return;
        const timer = setTimeout(() => setSaid(""), 1500);
        return () => clearTimeout(timer);
    }, [said]);

    function press(event: ReactPointerEvent<HTMLDivElement>, node: DiagramNode): void {
        if (event.button !== 0) return;
        event.stopPropagation();
        if (readOnly || !node.draggable) return;
        const start = { x: event.clientX, y: event.clientY };
        const origin = node.position;
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        let moved = false;
        let last = origin;
        const move = (next: PointerEvent) => {
            const dx = next.clientX - start.x;
            const dy = next.clientY - start.y;
            if (!moved && Math.abs(dx) + Math.abs(dy) <= SLOP) return;
            moved = true;
            const zoom = viewRef.current.zoom;
            let position = { x: origin.x + dx / zoom, y: origin.y + dy / zoom };
            // A condition stays inside its group, as it is drawn.
            if (parent) {
                position = {
                    x: Math.min(Math.max(position.x, 0), parent.width - node.width),
                    y: Math.min(Math.max(position.y, 0), parent.height - node.height)
                };
            }
            last = position;
            setHeld({ id: node.id, position });
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            setHeld(null);
            if (moved) {
                onDrop(node.id, last);
                // The press that dragged is not also a click on the node.
                swallowNextClick();
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    function key(event: ReactKeyboardEvent<HTMLDivElement>, node: DiagramNode): void {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(node.id);
        } else if (
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !readOnly &&
            node.draggable
        ) {
            event.preventDefault();
            onSelect(node.id);
            onNudge(node.id, event.key === "ArrowUp" ? -1 : 1);
            setSaid(labels.moved);
        } else if (
            (event.key === "Delete" || event.key === "Backspace") &&
            !readOnly &&
            node.deletable
        ) {
            event.preventDefault();
            onDelete(node.id);
        }
    }

    // Groups first, so the conditions inside them are drawn on top.
    const ordered = [...nodes].sort(
        (a, b) => Number(b.role === "group") - Number(a.role === "group")
    );

    return (
        <div
            ref={frame}
            className="absolute inset-0 cursor-grab touch-none overflow-hidden data-[panning]:cursor-grabbing"
            style={{
                backgroundImage: "radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)",
                backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`,
                backgroundPosition: `${view.x}px ${view.y}px`
            }}
            onClick={(event) => {
                if (!(event.target as Element).closest("[data-flow-node]")) onSelect(null);
            }}
        >
            <p id={help} className="sr-only">
                {labels.help}
            </p>
            <p aria-live="polite" className="sr-only">
                {said}
            </p>
            <div
                className="absolute left-0 top-0 origin-top-left"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
            >
                <svg
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 top-0 overflow-visible"
                    width={1}
                    height={1}
                >
                    {edges.map((edge) => {
                        const source = byId.get(edge.source);
                        const target = byId.get(edge.target);
                        if (!source || !target) return null;
                        const fromSide = SIDES[source.role][edge.sourceHandle] ?? "right";
                        const toSide = SIDES[target.role][edge.targetHandle] ?? "left";
                        return (
                            <path
                                key={edge.id}
                                d={edgePath(
                                    anchor(boxOf(source), fromSide),
                                    fromSide,
                                    anchor(boxOf(target), toSide),
                                    toSide
                                )}
                                fill="none"
                                stroke="hsl(var(--border-strong))"
                                strokeWidth={1.5}
                                strokeDasharray={edge.kind === "feeds" ? "4 4" : undefined}
                            />
                        );
                    })}
                </svg>
                {ordered.map((node) => {
                    const box = boxOf(node);
                    const selected = node.id === selectedId;
                    return (
                        <div
                            key={node.id}
                            data-flow-node
                            data-id={node.id}
                            role="button"
                            tabIndex={0}
                            aria-label={node.ariaLabel}
                            aria-describedby={help}
                            aria-pressed={selected}
                            className={cn(
                                "flow-node absolute rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                selected && "selected",
                                held?.id === node.id && "z-10 cursor-grabbing",
                                !readOnly && node.draggable && held?.id !== node.id && "cursor-grab"
                            )}
                            style={{
                                left: box.x,
                                top: box.y,
                                width: box.width,
                                height: box.height
                            }}
                            onPointerDown={(event) => press(event, node)}
                            onClick={(event) => {
                                event.stopPropagation();
                                onSelect(node.id);
                            }}
                            onKeyDown={(event) => key(event, node)}
                        >
                            {face(node, selected)}
                            {Object.values(SIDES[node.role]).map((side) => {
                                const at = anchor(
                                    { x: 0, y: 0, width: box.width, height: box.height },
                                    side
                                );
                                return (
                                    <span
                                        key={side}
                                        aria-hidden="true"
                                        className="pointer-events-none absolute rounded-full bg-border-strong"
                                        style={{
                                            width: HANDLE,
                                            height: HANDLE,
                                            left: at.x - HANDLE / 2,
                                            top: at.y - HANDLE / 2
                                        }}
                                    />
                                );
                            })}
                        </div>
                    );
                })}
            </div>
            <div
                className="absolute bottom-2 left-2 flex items-center rounded-md border border-border bg-elevated"
                onClick={(event) => event.stopPropagation()}
            >
                {(
                    [
                        [
                            labels.zoomIn,
                            <ZoomIn key="in" className="size-4" />,
                            () => zoomCentre(STEP)
                        ],
                        [
                            labels.zoomOut,
                            <ZoomOut key="out" className="size-4" />,
                            () => zoomCentre(1 / STEP)
                        ],
                        [labels.fit, <Maximize key="fit" className="size-4" />, fit]
                    ] as const
                ).map(([label, icon, run]) => (
                    <Button
                        key={label}
                        size="sm"
                        variant="ghost"
                        className="size-8 p-0"
                        aria-label={label}
                        title={label}
                        onClick={run}
                    >
                        {icon}
                    </Button>
                ))}
            </div>
        </div>
    );
}
