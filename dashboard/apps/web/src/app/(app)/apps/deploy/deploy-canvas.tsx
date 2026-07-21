"use client";

/**
 * Railway-style project canvas: services rendered as draggable nodes on a dotted
 * board, connectable by dragging from a node's handle to another node. Node
 * positions and links persist per environment (Environment.layout JSON). Links are
 * organizational for now - a visual map of how services relate - not yet wired to
 * private networking. Full service controls live in the List view.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { ServiceIcon, dbTone, serviceKindOf, type ProjectApp, type ProjectSummary, type ServiceKind } from "./deploy-view";
import { saveLayoutAction } from "./actions";

const NODE_W = 280;
const NODE_H = 116;
const GRID = 16;

type Tone = "success" | "warning" | "danger" | "idle";

interface CanvasNode {
    id: string;
    name: string;
    kind: ServiceKind;
    subtitle: string;
    tone: Tone;
    statusLabel: string;
    /** Attached volume row (databases), rendered below the card like Railway. */
    volume?: string;
}

interface Point {
    x: number;
    y: number;
}

interface Link {
    source: string;
    target: string;
}

interface Layout {
    pos: Record<string, Point>;
    links: Link[];
}

function nodesFromEnvironment(environment: ProjectSummary["environments"][number]): CanvasNode[] {
    const apps = environment.applications.map((app): CanvasNode => ({
        id: app.id,
        name: app.name,
        kind: serviceKindOf(app.sourceType),
        subtitle: app.domains[0]?.hostname ?? (app.sourceType === "image" ? "Docker image" : "Git repository"),
        tone: app.currentDeploymentId ? dbTone(app.deployStatus ?? "") : "idle",
        statusLabel: app.currentDeploymentId ? (app.deployStatus ?? "deployed") : "Not deployed"
    }));
    const databases = environment.databases.map((database): CanvasNode => ({
        id: database.id,
        name: database.name,
        kind: "database",
        subtitle: database.engine,
        tone: dbTone(database.status),
        statusLabel: database.status,
        volume: `${database.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-volume`
    }));
    return [...apps, ...databases];
}

function parseLayout(raw: string): Layout {
    try {
        const parsed = JSON.parse(raw) as Partial<Layout>;
        return {
            pos: parsed.pos && typeof parsed.pos === "object" ? parsed.pos : {},
            links: Array.isArray(parsed.links) ? parsed.links : []
        };
    } catch {
        return { pos: {}, links: [] };
    }
}

/** Seed a position for any node missing one, laid out in a tidy grid. */
function withSeededPositions(nodes: CanvasNode[], pos: Record<string, Point>): Record<string, Point> {
    const next = { ...pos };
    let placed = 0;
    for (const node of nodes) {
        if (next[node.id]) continue;
        const col = placed % 3;
        const row = Math.floor(placed / 3);
        next[node.id] = { x: 40 + col * (NODE_W + 48), y: 40 + row * (NODE_H + 56) };
        placed += 1;
    }
    return next;
}

const DOT_BG: React.CSSProperties = {
    backgroundImage: "radial-gradient(circle, hsl(var(--muted-foreground) / 0.15) 1px, transparent 1px)",
    backgroundSize: `${GRID}px ${GRID}px`
};

const TONE_DOT: Record<Tone, string> = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    idle: "bg-muted-foreground"
};

const TONE_TEXT: Record<Tone, string> = {
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    idle: "text-muted-foreground"
};

export function DeployCanvas({
    environment,
    canManage,
    onOpenService
}: {
    environment: ProjectSummary["environments"][number];
    canManage: boolean;
    onOpenService?: (app: ProjectApp) => void;
}) {
    const nodes = useMemo(() => nodesFromEnvironment(environment), [environment]);
    const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);

    const initial = useMemo(() => {
        const parsed = parseLayout(environment.layout);
        return {
            pos: withSeededPositions(nodes, parsed.pos),
            links: parsed.links.filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target))
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [environment.id]);

    const [pos, setPos] = useState<Record<string, Point>>(initial.pos);
    const [links, setLinks] = useState<Link[]>(initial.links);
    const [saving, setSaving] = useState(false);

    const containerRef = useRef<HTMLDivElement>(null);
    const boardRef = useRef<HTMLDivElement>(null);
    const posRef = useRef(pos);
    posRef.current = pos;

    // Reset when switching environments.
    useEffect(() => {
        setPos(initial.pos);
        setLinks(initial.links);
    }, [initial]);

    const persist = useCallback(
        (nextPos: Record<string, Point>, nextLinks: Link[]) => {
            if (!canManage) return;
            setSaving(true);
            void saveLayoutAction({
                environmentId: environment.id,
                layout: JSON.stringify({ pos: nextPos, links: nextLinks })
            }).finally(() => setSaving(false));
        },
        [canManage, environment.id]
    );

    // Cursor position in board coordinates.
    const toBoard = useCallback((clientX: number, clientY: number): Point => {
        const rect = boardRef.current?.getBoundingClientRect();
        return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
    }, []);

    // --- node dragging ------------------------------------------------------
    const [dragId, setDragId] = useState<string | null>(null);

    function onNodePointerDown(event: React.PointerEvent, id: string) {
        event.preventDefault();
        const start = { x: event.clientX, y: event.clientY };
        const origin = posRef.current[id] ?? { x: 0, y: 0 };
        let moved = false;
        if (canManage) setDragId(id);

        function move(moveEvent: PointerEvent) {
            if (Math.abs(moveEvent.clientX - start.x) + Math.abs(moveEvent.clientY - start.y) > 4) moved = true;
            if (!canManage || !moved) return;
            const nx = Math.round((origin.x + moveEvent.clientX - start.x) / 8) * 8;
            const ny = Math.round((origin.y + moveEvent.clientY - start.y) / 8) * 8;
            setPos((prev) => ({ ...prev, [id]: { x: Math.max(0, nx), y: Math.max(0, ny) } }));
        }
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            setDragId(null);
            // A click (no meaningful drag) opens the service detail for app nodes.
            if (!moved) {
                const app = environment.applications.find((item) => item.id === id);
                if (app && onOpenService) onOpenService(app);
                return;
            }
            if (canManage) persist(posRef.current, links);
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // --- link creation ------------------------------------------------------
    const [pending, setPending] = useState<{ source: string; cursor: Point } | null>(null);

    function onHandlePointerDown(event: React.PointerEvent, source: string) {
        if (!canManage) return;
        event.preventDefault();
        event.stopPropagation();
        setPending({ source, cursor: toBoard(event.clientX, event.clientY) });

        function move(moveEvent: PointerEvent) {
            setPending((prev) => (prev ? { ...prev, cursor: toBoard(moveEvent.clientX, moveEvent.clientY) } : prev));
        }
        function up(upEvent: PointerEvent) {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            const cursor = toBoard(upEvent.clientX, upEvent.clientY);
            const target = nodes.find((node) => {
                const p = posRef.current[node.id];
                return p && cursor.x >= p.x && cursor.x <= p.x + NODE_W && cursor.y >= p.y && cursor.y <= p.y + NODE_H;
            });
            setPending(null);
            if (target && target.id !== source) {
                setLinks((prev) => {
                    if (prev.some((l) => (l.source === source && l.target === target.id) || (l.source === target.id && l.target === source))) {
                        return prev;
                    }
                    const next = [...prev, { source, target: target.id }];
                    persist(posRef.current, next);
                    return next;
                });
            }
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    function removeLink(index: number) {
        if (!canManage) return;
        setLinks((prev) => {
            const next = prev.filter((_, i) => i !== index);
            persist(posRef.current, next);
            return next;
        });
    }

    const center = (id: string): Point => {
        const p = pos[id] ?? { x: 0, y: 0 };
        return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 };
    };

    // Board extent so it scrolls to fit the furthest node.
    const extent = useMemo(() => {
        let w = 900;
        let h = 480;
        for (const point of Object.values(pos)) {
            w = Math.max(w, point.x + NODE_W + 80);
            h = Math.max(h, point.y + NODE_H + 80);
        }
        return { w, h };
    }, [pos]);

    if (nodes.length === 0) {
        return (
            <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed border-border/60" style={DOT_BG}>
                <p className="text-sm text-muted-foreground">No services to map yet.</p>
            </div>
        );
    }

    return (
        <div className="relative">
            {saving && (
                <span className="absolute right-2 top-2 z-20 inline-flex items-center gap-1 rounded-md bg-card/80 px-2 py-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> Saving
                </span>
            )}
            <div
                ref={containerRef}
                className="relative h-[calc(100vh-11rem)] min-h-[460px] overflow-auto rounded-lg border border-border/60"
                style={DOT_BG}
            >
                <div ref={boardRef} className="relative" style={{ width: extent.w, height: extent.h }}>
                    <svg className="pointer-events-none absolute inset-0" width={extent.w} height={extent.h}>
                        {links.map((link, index) => {
                            const a = center(link.source);
                            const b = center(link.target);
                            const midX = (a.x + b.x) / 2;
                            return (
                                <g key={`${link.source}-${link.target}-${index}`} className="pointer-events-auto">
                                    <path
                                        d={`M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`}
                                        fill="none"
                                        stroke="hsl(var(--muted-foreground) / 0.5)"
                                        strokeWidth={1.5}
                                        strokeDasharray="4 4"
                                    />
                                    {canManage && (
                                        <circle
                                            cx={midX}
                                            cy={(a.y + b.y) / 2}
                                            r={7}
                                            className="cursor-pointer fill-card stroke-border"
                                            onClick={() => removeLink(index)}
                                        >
                                            <title>Remove link</title>
                                        </circle>
                                    )}
                                </g>
                            );
                        })}
                        {pending && (
                            <path
                                d={`M ${center(pending.source).x} ${center(pending.source).y} L ${pending.cursor.x} ${pending.cursor.y}`}
                                fill="none"
                                stroke="hsl(var(--primary))"
                                strokeWidth={1.5}
                                strokeDasharray="4 4"
                            />
                        )}
                    </svg>

                    {nodes.map((node) => {
                        const p = pos[node.id] ?? { x: 0, y: 0 };
                        const label = node.tone === "success" ? "Online" : node.statusLabel;
                        return (
                            <Fragment key={node.id}>
                                <div
                                    className={`absolute flex select-none flex-col border bg-card shadow-sm transition-colors ${
                                        node.volume ? "rounded-t-2xl" : "rounded-2xl"
                                    } ${dragId === node.id ? "border-primary" : "border-border hover:border-muted-foreground/50"} ${
                                        canManage ? "cursor-grab active:cursor-grabbing" : ""
                                    }`}
                                    style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                                    onPointerDown={(event) => onNodePointerDown(event, node.id)}
                                >
                                    <div className="flex flex-1 flex-col p-4">
                                        <div className="flex items-center gap-3">
                                            <ServiceIcon kind={node.kind} className="size-7 shrink-0 text-foreground" />
                                            <span className="truncate text-base font-semibold">{node.name}</span>
                                        </div>
                                        <p className="mt-1 truncate text-sm text-muted-foreground">{node.subtitle}</p>
                                        <div className="mt-auto flex items-center gap-2 text-sm">
                                            <span className={`size-1.5 rounded-full ${TONE_DOT[node.tone]}`} />
                                            <span className={TONE_TEXT[node.tone]}>{label}</span>
                                        </div>
                                    </div>
                                    {canManage && (
                                        <button
                                            type="button"
                                            title="Drag to another service to link"
                                            onPointerDown={(event) => onHandlePointerDown(event, node.id)}
                                            className="absolute -right-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border border-border bg-surface hover:border-primary hover:bg-primary"
                                        />
                                    )}
                                </div>
                                {node.volume && (
                                    <div
                                        className="absolute flex items-center gap-2 rounded-b-2xl border border-t-0 border-border bg-card/60 px-4 py-2.5 text-xs text-muted-foreground"
                                        style={{ left: p.x, top: p.y + NODE_H, width: NODE_W }}
                                    >
                                        <HardDrive className="size-3.5 shrink-0" /> {node.volume}
                                    </div>
                                )}
                            </Fragment>
                        );
                    })}
                </div>
            </div>
            {canManage && (
                <p className="mt-2 text-xs text-muted-foreground/70">
                    Drag nodes to arrange them. Drag from a node's right handle onto another service to link them.
                </p>
            )}
        </div>
    );
}
