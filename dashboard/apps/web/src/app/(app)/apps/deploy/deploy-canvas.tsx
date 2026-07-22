"use client";

/**
 * Railway-style project canvas: services rendered as draggable nodes on a dotted
 * board, connectable by dragging from a node's handle to another node. Node
 * positions and links persist per environment (Environment.layout JSON). Links are
 * organizational for now - a visual map of how services relate - not yet wired to
 * private networking. Full service controls live in the List view.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, HardDrive, Loader2, Plus, ScrollText, Trash2 } from "lucide-react";
import {
    Button,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";
import {
    NewServiceDialog,
    SERVICE_TYPES,
    ServiceIcon,
    dbTone,
    primaryDomain,
    serviceKindOf,
    type ProjectApp,
    type ProjectSummary,
    type ServiceKind,
    type ServiceView
} from "./deploy-view";
import { deleteApplicationAction, duplicateApplicationAction, saveLayoutAction } from "./actions";
import { NewVolumeDialog } from "./volume-form";

const NODE_W = 280;
const NODE_H = 116;
/** Height of an attached volume strip, so multiple stack cleanly below a card. */
const VOL_STRIP_H = 44;
const GRID = 16;

type Tone = "success" | "warning" | "danger" | "idle";

type VolumeChip = ProjectSummary["environments"][number]["applications"][number]["volumes"][number];

interface CanvasNode {
    id: string;
    name: string;
    kind: ServiceKind;
    subtitle: string;
    tone: Tone;
    statusLabel: string;
    /** Synthetic volume label for databases, rendered below the card like Railway. */
    volume?: string;
    /** Real attached volumes (applications), each an interactive strip below the card. */
    volumes?: VolumeChip[];
}

/** Where a volume opens in Drive: a nas volume points at its NAS connection + folder;
 *  any other kind falls back to the container's filesystem at the mount path. */
function volumeDriveHref(appId: string, volume: VolumeChip): string {
    if (volume.kind === "nas" && volume.connectionId) {
        return `/drive?c=${volume.connectionId}&p=${encodeURIComponent(volume.source)}`;
    }
    return `/drive?c=container:${appId}&p=${encodeURIComponent(volume.mountPath.replace(/^\/+|\/+$/g, ""))}`;
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
        subtitle: primaryDomain(app.domains)?.hostname ?? (app.sourceType === "image" ? "Docker image" : "Git repository"),
        tone: app.currentDeploymentId ? dbTone(app.deployStatus ?? "") : "idle",
        statusLabel: app.currentDeploymentId ? (app.deployStatus ?? "deployed") : "Not deployed",
        volumes: app.volumes
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

/** Seed a position for any node missing one, placed near the centre of the
 *  existing cluster (or the board centre when empty) and spiralled out to the
 *  nearest free slot so a new service never lands on top of another. */
function withSeededPositions(nodes: CanvasNode[], pos: Record<string, Point>): Record<string, Point> {
    const next = { ...pos };
    const stepX = NODE_W + 48;
    const stepY = NODE_H + 64;
    const overlaps = (x: number, y: number): boolean =>
        Object.values(next).some((p) => Math.abs(p.x - x) < stepX && Math.abs(p.y - y) < stepY);

    for (const node of nodes) {
        if (next[node.id]) continue;
        const existing = Object.values(next);
        const anchor =
            existing.length > 0
                ? {
                      x: existing.reduce((sum, p) => sum + p.x, 0) / existing.length,
                      y: existing.reduce((sum, p) => sum + p.y, 0) / existing.length
                  }
                : { x: 320, y: 180 };
        let spot = { x: Math.max(0, Math.round(anchor.x)), y: Math.max(0, Math.round(anchor.y)) };
        search: for (let ring = 0; ring < 24; ring += 1) {
            for (let dy = -ring; dy <= ring; dy += 1) {
                for (let dx = -ring; dx <= ring; dx += 1) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                    const x = Math.max(0, Math.round(anchor.x + dx * stepX));
                    const y = Math.max(0, Math.round(anchor.y + dy * stepY));
                    if (!overlaps(x, y)) {
                        spot = { x, y };
                        break search;
                    }
                }
            }
        }
        next[node.id] = spot;
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

/** Status text color, like Railway's "Online" / "Crashed" node label. */
const TONE_TEXT: Record<Tone, string> = {
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    idle: "text-muted-foreground"
};

/** Resting border: neutral, tinted only on failure (Railway keys errors in red). */
const TONE_BORDER: Record<Tone, string> = {
    success: "border-border hover:border-muted-foreground/40",
    warning: "border-border hover:border-muted-foreground/40",
    danger: "border-danger/40 hover:border-danger/60",
    idle: "border-border hover:border-muted-foreground/40"
};

/** A soft edge vignette so the board reads as a lit surface, not a flat panel. */
const VIGNETTE: React.CSSProperties = {
    background: "radial-gradient(120% 90% at 50% 30%, transparent 55%, hsl(var(--background) / 0.55) 100%)"
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

    const router = useRouter();
    const [deleteTarget, setDeleteTarget] = useState<ProjectApp | null>(null);
    const [acting, setActing] = useState(false);
    const [newService, setNewService] = useState<{ open: boolean; view: ServiceView }>({ open: false, view: "list" });
    const [newVolumeOpen, setNewVolumeOpen] = useState(false);
    const volumeServices = environment.applications.map((app) => ({ id: app.id, name: app.name }));

    function duplicate(app: ProjectApp) {
        setActing(true);
        void duplicateApplicationAction(app.id).finally(() => {
            setActing(false);
            router.refresh();
        });
    }

    function confirmDelete() {
        if (!deleteTarget) return;
        setActing(true);
        void deleteApplicationAction(deleteTarget.id).finally(() => {
            setActing(false);
            setDeleteTarget(null);
            router.refresh();
        });
    }

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

    // Where the board was last right-clicked, and where a service created from that
    // menu should land (armed only when the user actually picks a type).
    const menuSpawnRef = useRef<Point | null>(null);
    const pendingSpawnRef = useRef<Point | null>(null);

    // Seed a position for any node that appears without one - at the right-click
    // point when a service was just created there, else near the existing cluster -
    // so a new service never renders stacked at the origin.
    useEffect(() => {
        const missing = nodes.filter((node) => !posRef.current[node.id]);
        if (missing.length === 0) return;
        let next = { ...posRef.current };
        for (const node of missing) {
            const spawn = pendingSpawnRef.current;
            if (spawn) {
                pendingSpawnRef.current = null;
                next[node.id] = { x: Math.max(0, Math.round(spawn.x / 8) * 8), y: Math.max(0, Math.round(spawn.y / 8) * 8) };
            } else {
                next = withSeededPositions([node], next);
            }
        }
        setPos(next);
        persist(next, links);
    }, [nodes, links, persist]);

    function openNewService(view: ServiceView) {
        pendingSpawnRef.current = menuSpawnRef.current;
        setNewService({ open: true, view });
    }

    // --- node dragging ------------------------------------------------------
    const [dragId, setDragId] = useState<string | null>(null);

    function onNodePointerDown(event: React.PointerEvent, id: string) {
        // Only the primary (left) button drags or opens; a right-click must fall
        // through to the context menu instead of starting a drag.
        if (event.button !== 0) return;
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

    // The link handle sits on the node's right edge, vertically centered - the
    // in-progress drag line starts there, not from the card centre.
    const handlePoint = (id: string): Point => {
        const p = pos[id] ?? { x: 0, y: 0 };
        return { x: p.x + NODE_W, y: p.y + NODE_H / 2 };
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

    // Right-click anywhere on empty board space to add a service, placed where the
    // menu was opened. Node cards stop propagation so their own menu wins instead.
    const boardMenu = (board: React.ReactNode): React.ReactNode => {
        if (!canManage) return board;
        return (
            <ContextMenu>
                <ContextMenuTrigger
                    asChild
                    onContextMenu={(event) => {
                        // Only meaningful once the board exists; the empty state has no
                        // coordinate space, so a new service falls back to auto-placement.
                        menuSpawnRef.current = boardRef.current ? toBoard(event.clientX, event.clientY) : null;
                    }}
                >
                    {board}
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <Plus className="size-4" /> New service
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                            {SERVICE_TYPES.map((type) => (
                                <ContextMenuItem key={type.id} onSelect={() => openNewService(type.id)}>
                                    <span className="flex size-4 items-center justify-center [&_svg]:size-4">{type.icon}</span>
                                    {type.label}
                                </ContextMenuItem>
                            ))}
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                disabled={environment.applications.length === 0}
                                onSelect={() => setNewVolumeOpen(true)}
                            >
                                <span className="flex size-4 items-center justify-center [&_svg]:size-4">
                                    <HardDrive className="size-5" />
                                </span>
                                Volume
                            </ContextMenuItem>
                        </ContextMenuSubContent>
                    </ContextMenuSub>
                </ContextMenuContent>
            </ContextMenu>
        );
    };

    const dialog = (
        <>
            <NewServiceDialog
                environmentId={environment.id}
                open={newService.open}
                view={newService.view}
                onOpenChange={(open) => setNewService((state) => ({ ...state, open }))}
                onViewChange={(view) => setNewService((state) => ({ ...state, view }))}
                onChanged={() => router.refresh()}
            />
            <NewVolumeDialog
                open={newVolumeOpen}
                services={volumeServices}
                onOpenChange={setNewVolumeOpen}
                onCreated={() => router.refresh()}
            />
        </>
    );

    if (nodes.length === 0) {
        return (
            <>
                {boardMenu(
                    <div
                        className="relative flex h-[calc(100vh-11rem)] min-h-[460px] flex-col items-center justify-center overflow-hidden rounded-lg border border-border/60"
                        style={DOT_BG}
                    >
                        <div className="pointer-events-none absolute inset-0" style={VIGNETTE} />
                        <div className="relative flex flex-col items-center gap-2 text-center">
                            <span className="grid size-12 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
                                <HardDrive className="size-5" />
                            </span>
                            <p className="text-sm font-medium">Nothing deployed yet</p>
                            <p className="max-w-xs text-xs text-muted-foreground">
                                {canManage
                                    ? "Right-click the board or use New service to add one - it appears here as a node you can arrange and connect."
                                    : "Add a service and it appears here as a node you can arrange and connect."}
                            </p>
                        </div>
                    </div>
                )}
                {dialog}
            </>
        );
    }

    return (
        <div className="relative">
            {saving && (
                <span className="absolute right-2 top-2 z-20 inline-flex items-center gap-1 rounded-md bg-card/80 px-2 py-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> Saving
                </span>
            )}
            {boardMenu(
                <div className="relative h-[calc(100vh-11rem)] min-h-[460px] overflow-hidden rounded-lg border border-border/60">
                <div ref={containerRef} className="absolute inset-0 overflow-auto" style={DOT_BG}>
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
                                        stroke="hsl(var(--muted-foreground) / 0.45)"
                                        strokeWidth={2}
                                        strokeLinecap="round"
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
                                d={`M ${handlePoint(pending.source).x} ${handlePoint(pending.source).y} L ${pending.cursor.x} ${pending.cursor.y}`}
                                fill="none"
                                stroke="hsl(var(--primary))"
                                strokeWidth={2}
                                strokeLinecap="round"
                                strokeDasharray="5 5"
                            />
                        )}
                    </svg>

                    {nodes.map((node) => {
                        const p = pos[node.id] ?? { x: 0, y: 0 };
                        const label = node.tone === "success" ? "Online" : node.statusLabel;
                        const pulsing = node.tone === "warning";
                        const app = environment.applications.find((item) => item.id === node.id);
                        const card = (
                            <div
                                className={`group absolute flex select-none flex-col border bg-card shadow-sm transition-[border-color,box-shadow] hover:shadow-lg hover:shadow-black/25 ${
                                    node.volume || node.volumes?.length ? "rounded-t-2xl" : "rounded-2xl"
                                } ${dragId === node.id ? "border-primary ring-1 ring-primary/40" : TONE_BORDER[node.tone]} ${
                                    canManage ? "cursor-grab active:cursor-grabbing" : ""
                                }`}
                                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                                onPointerDown={(event) => onNodePointerDown(event, node.id)}
                                onContextMenu={(event) => event.stopPropagation()}
                            >
                                <div className="flex flex-1 flex-col p-4">
                                    <div className="flex items-center gap-3">
                                        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
                                            <ServiceIcon kind={node.kind} className="size-5" />
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-base font-semibold">{node.name}</span>
                                    </div>
                                    <p className="mt-1 truncate text-sm text-muted-foreground">{node.subtitle}</p>
                                    <div className="mt-auto flex items-center gap-2 text-sm">
                                        <span className={`size-2 rounded-full ${TONE_DOT[node.tone]} ${pulsing ? "animate-pulse" : ""}`} />
                                        <span className={TONE_TEXT[node.tone]}>{label}</span>
                                    </div>
                                </div>
                                {canManage && (
                                    <button
                                        type="button"
                                        title="Drag to another service to link"
                                        onPointerDown={(event) => onHandlePointerDown(event, node.id)}
                                        className="absolute -right-1.5 top-1/2 size-3.5 -translate-y-1/2 rounded-full border-2 border-primary bg-card opacity-0 transition-opacity hover:bg-primary group-hover:opacity-100"
                                    />
                                )}
                            </div>
                        );
                        return (
                            <Fragment key={node.id}>
                                {app && canManage ? (
                                    <ContextMenu>
                                        <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
                                        <ContextMenuContent>
                                            <ContextMenuItem onSelect={() => onOpenService?.(app)}>
                                                <ScrollText className="size-4" /> View latest deploy
                                            </ContextMenuItem>
                                            <ContextMenuItem onSelect={() => duplicate(app)}>
                                                <Copy className="size-4" /> Duplicate
                                            </ContextMenuItem>
                                            <ContextMenuSeparator />
                                            <ContextMenuItem variant="danger" onSelect={() => setDeleteTarget(app)}>
                                                <Trash2 className="size-4" /> Delete
                                            </ContextMenuItem>
                                        </ContextMenuContent>
                                    </ContextMenu>
                                ) : (
                                    card
                                )}
                                {node.volume && (
                                    <div
                                        className="absolute flex items-center gap-2 rounded-b-2xl border border-t-0 border-border bg-card/60 px-4 py-2.5 text-xs text-muted-foreground"
                                        style={{ left: p.x, top: p.y + NODE_H, width: NODE_W }}
                                    >
                                        <HardDrive className="size-3.5 shrink-0" /> {node.volume}
                                    </div>
                                )}
                                {node.volumes?.map((vol, vi) => (
                                    <ContextMenu key={vol.id}>
                                        <ContextMenuTrigger asChild>
                                            <button
                                                type="button"
                                                onClick={() => app && onOpenService?.(app)}
                                                onContextMenu={(event) => event.stopPropagation()}
                                                className={`absolute flex items-center gap-2 border border-t-0 border-border bg-card/60 px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-card ${
                                                    vi === (node.volumes?.length ?? 0) - 1 ? "rounded-b-2xl" : ""
                                                }`}
                                                style={{ left: p.x, top: p.y + NODE_H + vi * VOL_STRIP_H, width: NODE_W }}
                                            >
                                                <HardDrive className={`size-3.5 shrink-0 ${vol.kind === "nas" ? "text-sky-400" : ""}`} />
                                                <span className="truncate">{vol.name}</span>
                                                <span className="ml-auto shrink-0 truncate text-[10px] text-muted-foreground/70">
                                                    {vol.kind === "nas" ? (vol.connectionName ?? "NAS") : vol.kind === "bind" ? "Server" : "Volume"}
                                                </span>
                                            </button>
                                        </ContextMenuTrigger>
                                        <ContextMenuContent>
                                            <ContextMenuItem onSelect={() => router.push(volumeDriveHref(node.id, vol))}>
                                                <HardDrive className="size-4" /> View in Drive
                                            </ContextMenuItem>
                                            {app && (
                                                <ContextMenuItem onSelect={() => onOpenService?.(app)}>
                                                    <ScrollText className="size-4" /> Manage volumes
                                                </ContextMenuItem>
                                            )}
                                        </ContextMenuContent>
                                    </ContextMenu>
                                ))}
                            </Fragment>
                        );
                    })}
                    </div>
                </div>
                <div className="pointer-events-none absolute inset-0 rounded-lg" style={VIGNETTE} />
                </div>
            )}
            {canManage && (
                <p className="mt-2 text-xs text-muted-foreground/70">
                    Drag nodes to arrange them. Drag from a node's right handle onto another service to link them.
                    Right-click the board to add a service, or a service for more.
                </p>
            )}

            <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        This removes the service, its container, domains, and variables. This cannot be undone.
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                            Cancel
                        </Button>
                        <Button variant="danger" disabled={acting} onClick={confirmDelete}>
                            {acting && <Loader2 className="size-4 animate-spin" />} Delete
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
            {dialog}
        </div>
    );
}
