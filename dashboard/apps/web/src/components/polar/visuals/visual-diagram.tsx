"use client";

/**
 * A small diagram Polar drew: boxes in layers, arrows between them. Laid out
 * here, not by the model - each node sits one layer past the longest chain that
 * leads to it (the layering step of Sugiyama-style layout, which Graphviz's
 * dot and dagre both start from), a loop is cut where it closes, and the
 * picture is one SVG that shrinks to the column and never grows past its own
 * size, so it cannot push the page wider.
 */

import { useId, useMemo } from "react";
import type { DiagramView } from "@/lib/polar/visuals";

const NODE_W = 152;
const NODE_H = 40;
const GAP_ALONG = 56;
const GAP_ACROSS = 24;
const LABEL_MAX = 22;

interface Placed {
    id: string;
    label: string;
    x: number;
    y: number;
}

/** Layer of every node: one past the deepest node pointing at it, loops cut. */
export function layersOf(view: DiagramView): Map<string, number> {
    const out = new Map<string, string[]>(view.nodes.map((node) => [node.id, []]));
    for (const edge of view.edges) if (edge.from !== edge.to) out.get(edge.from)!.push(edge.to);
    // Depth-first order marks the edges that close a loop, which are left out.
    const state = new Map<string, "open" | "done">();
    const forward = new Map<string, string[]>(view.nodes.map((node) => [node.id, []]));
    const visit = (id: string) => {
        state.set(id, "open");
        for (const next of out.get(id) ?? []) {
            if (state.get(next) === "open") continue;
            forward.get(id)!.push(next);
            if (!state.has(next)) visit(next);
        }
        state.set(id, "done");
    };
    for (const node of view.nodes) if (!state.has(node.id)) visit(node.id);
    const layer = new Map<string, number>(view.nodes.map((node) => [node.id, 0]));
    // Longest path over what is now acyclic: relax in topological order.
    const indegree = new Map<string, number>(view.nodes.map((node) => [node.id, 0]));
    for (const targets of forward.values()) for (const to of targets) indegree.set(to, indegree.get(to)! + 1);
    const queue = view.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
    while (queue.length > 0) {
        const id = queue.shift()!;
        for (const to of forward.get(id)!) {
            layer.set(to, Math.max(layer.get(to)!, layer.get(id)! + 1));
            indegree.set(to, indegree.get(to)! - 1);
            if (indegree.get(to) === 0) queue.push(to);
        }
    }
    return layer;
}

function shorten(text: string): string {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > LABEL_MAX ? `${clean.slice(0, LABEL_MAX - 3)}...` : clean;
}

export function VisualDiagram({ view, label }: { view: DiagramView; label: string }) {
    const down = view.direction !== "right";
    const { placed, width, height } = useMemo(() => {
        const layers = layersOf(view);
        const rows: string[][] = [];
        for (const node of view.nodes) (rows[layers.get(node.id)!] ??= []).push(node.id);
        const widest = Math.max(...rows.map((row) => row?.length ?? 0));
        const names = new Map(view.nodes.map((node) => [node.id, node.label]));
        const placed = new Map<string, Placed>();
        rows.forEach((row, depth) => {
            const offset = ((widest - row.length) * (down ? NODE_W + GAP_ACROSS : NODE_H + GAP_ACROSS)) / 2;
            row.forEach((id, index) => {
                const along = depth * ((down ? NODE_H : NODE_W) + GAP_ALONG);
                const across = offset + index * ((down ? NODE_W : NODE_H) + GAP_ACROSS);
                placed.set(id, { id, label: names.get(id)!, x: down ? across : along, y: down ? along : across });
            });
        });
        const depth = rows.length;
        const across = widest * ((down ? NODE_W : NODE_H) + GAP_ACROSS) - GAP_ACROSS;
        const along = depth * ((down ? NODE_H : NODE_W) + GAP_ALONG) - GAP_ALONG;
        return { placed, width: down ? across : along, height: down ? along : across };
    }, [view, down]);
    const pad = 4;
    const arrow = `polar-arrow-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
    return (
        <svg
            role="img"
            aria-label={label}
            viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`}
            className="mx-auto block h-auto w-full"
            style={{ maxWidth: width + pad * 2 }}
        >
            <defs>
                <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0 L8 4 L0 8 z" fill="hsl(var(--muted-foreground))" />
                </marker>
            </defs>
            {view.edges.map((edge, index) => {
                const from = placed.get(edge.from)!;
                const to = placed.get(edge.to)!;
                const start = down
                    ? { x: from.x + NODE_W / 2, y: from.y + NODE_H }
                    : { x: from.x + NODE_W, y: from.y + NODE_H / 2 };
                const end = down ? { x: to.x + NODE_W / 2, y: to.y } : { x: to.x, y: to.y + NODE_H / 2 };
                const forward = down ? end.y > start.y : end.x > start.x;
                // A step back, a loop or a step within one layer bends out of the way.
                const bend = down ? { x: Math.max(start.x, end.x) + NODE_W / 2 + 12, y: (start.y + end.y) / 2 } : { x: (start.x + end.x) / 2, y: Math.max(start.y, end.y) + NODE_H };
                const d = forward
                    ? down
                        ? `M${start.x} ${start.y} C${start.x} ${start.y + GAP_ALONG / 2} ${end.x} ${end.y - GAP_ALONG / 2} ${end.x} ${end.y}`
                        : `M${start.x} ${start.y} C${start.x + GAP_ALONG / 2} ${start.y} ${end.x - GAP_ALONG / 2} ${end.y} ${end.x} ${end.y}`
                    : `M${start.x} ${start.y} Q${bend.x} ${bend.y} ${end.x} ${end.y}`;
                const middle = forward ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } : bend;
                return (
                    <g key={index}>
                        <path d={d} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth={1.25} markerEnd={`url(#${arrow})`} />
                        {edge.label ? (
                            <text
                                x={middle.x}
                                y={middle.y}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fontSize={10}
                                fill="hsl(var(--muted-foreground))"
                                stroke="hsl(var(--card))"
                                strokeWidth={4}
                                paintOrder="stroke"
                            >
                                {shorten(edge.label)}
                            </text>
                        ) : null}
                    </g>
                );
            })}
            {[...placed.values()].map((node) => (
                <g key={node.id}>
                    <title>{node.label}</title>
                    <rect
                        x={node.x}
                        y={node.y}
                        width={NODE_W}
                        height={NODE_H}
                        rx={8}
                        fill="hsl(var(--muted))"
                        stroke="hsl(var(--border))"
                    />
                    <text
                        x={node.x + NODE_W / 2}
                        y={node.y + NODE_H / 2}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={12}
                        fill="hsl(var(--foreground))"
                    >
                        {shorten(node.label)}
                    </text>
                </g>
            ))}
        </svg>
    );
}
