"use client";

/**
 * Railway-style project canvas: services rendered as draggable nodes on a dotted
 * board, connectable by dragging from a node's handle to another node. Node
 * positions and links persist per environment (Environment.layout JSON). Links are
 * organizational for now - a visual map of how services relate - not yet wired to
 * private networking. Full service controls live in the List view.
 *
 * The board zooms (the corner controls, the wheel towards the pointer, or a
 * pinch), moves when the board itself is dragged (`useBoardGestures`, the same
 * hand the automation diagrams answer), and pointing at a service lights up
 * the lines that join it, so the shape of a
 * project with many services can still be read. The arithmetic for both lives
 * in canvas-geometry.ts.
 */

import { useRouter } from "next/navigation";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { primaryDomain } from "./domain-rank";
import { IntegrationLogo } from "@/components/logos";
import { dbEngineLabel } from "@polaris/core";
import { NewVolumeDialog } from "./volume-form";
import { useStagedChanges } from "./staged-changes";
import { DatabaseManageDialog } from "./database-panel";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { VolumeDetailDialog, type VolumeTab } from "./volume-detail";
import { duplicateApplicationAction, saveLayoutAction } from "./actions";
import { stageDatabaseDeleteAction, stageServiceDeleteAction } from "./project-actions";
import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState
} from "react";
import {
    Copy,
    Files,
    HardDrive,
    Loader2,
    Maximize2,
    Plus,
    ScrollText,
    Settings2,
    Trash2,
    ZoomIn,
    ZoomOut
} from "lucide-react";
import * as geometry from "./canvas-geometry";
import { dbTone, StatusPill } from "./status-pill";
import {
    NewServiceDialog,
    SERVICE_TYPES,
    ServiceIcon,
    runStateLabel,
    serviceKindOf,
    type ProjectApp,
    type ProjectSummary,
    type ServiceKind,
    type ServiceView
} from "./deploy-view";
import {
    Button,
    ConfirmDeleteDialog,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    useBoardGestures
} from "@polaris/ui";

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
    /** Set on a database, so the card carries the engine's own mark rather than
     *  the generic database glyph every engine would otherwise share. */
    engine?: string;
    /** Databases hosted inside this one, which removing it would take with it. */
    hostedCount?: number;
    subtitle: string;
    tone: Tone;
    statusLabel: string;
    /** Synthetic volume label for databases, rendered below the card like Railway. */
    volume?: string;
    /** Real attached volumes (applications), each an interactive strip below the card. */
    volumes?: VolumeChip[];
    /** The same service on another provider, whose production domain is the
     *  subtitle: which provider, and whether its release is live. */
    elsewhere?: { provider: string; status: string };
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

function nodesFromEnvironment(
    environment: ProjectSummary["environments"][number],
    t: NamespaceTranslator<"deploy">
): CanvasNode[] {
    const apps = environment.applications.map(
        (app): CanvasNode => ({
            id: app.id,
            name: app.name,
            kind: serviceKindOf(app.sourceType),
            // The production copy's domain first when the service also runs on another
            // provider - that is where it answers people - then its own best address.
            subtitle:
                app.elsewhere.find((entry) => entry.domains.length > 0)?.domains[0] ??
                primaryDomain(app.domains)?.hostname ??
                (app.sourceType === "image" ? t("canvas.dockerImage") : t("canvas.gitRepository")),
            elsewhere: app.elsewhere[0]
                ? { provider: app.elsewhere[0].provider, status: app.elsewhere[0].status }
                : undefined,
            tone: runStateLabel(app, t).tone,
            statusLabel: runStateLabel(app, t).label,
            volumes: app.volumes
        })
    );
    const databases = environment.databases.map(
        (database): CanvasNode => ({
            id: database.id,
            name: database.name,
            kind: "database",
            engine: database.engine,
            subtitle: dbEngineLabel(database.engine),
            tone: dbTone(database.status),
            statusLabel: database.status,
            hostedCount: database.hostedCount ?? 0,
            // A database living inside another instance has no volume of its own; the
            // strip under the card would name one that does not exist.
            volume: database.hostedOnInstance
                ? undefined
                : `${database.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-volume`
        })
    );
    return [...apps, ...databases];
}

/** The room a node takes on the board: its card plus the volume strips stacked
 *  under it, so a line leaving through the bottom clears the strips. */
function footprintOf(node: CanvasNode, at: Point): geometry.Rect {
    const strips = node.volumes?.length ?? (node.volume ? 1 : 0);
    return { x: at.x, y: at.y, w: NODE_W, h: NODE_H + strips * VOL_STRIP_H };
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
function withSeededPositions(
    nodes: CanvasNode[],
    pos: Record<string, Point>
): Record<string, Point> {
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
    backgroundImage:
        "radial-gradient(circle, hsl(var(--muted-foreground) / 0.15) 1px, transparent 1px)",
    backgroundSize: `${GRID}px ${GRID}px`
};

/** Resting border: neutral, tinted on failure (Railway keys errors in red), and
 *  ringed in amber while a deploy is under way so the one card that is moving is
 *  the one the eye lands on. */
const TONE_BORDER: Record<Tone, string> = {
    success: "border-border hover:border-muted-foreground/40",
    warning: "border-warning-edge shadow-[0_0_0_3px_var(--warning-soft)]",
    danger: "border-danger-edge hover:border-danger-edge",
    idle: "border-border hover:border-muted-foreground/40"
};

/** A soft edge vignette so the board reads as a lit surface, not a flat panel. */
const VIGNETTE: React.CSSProperties = {
    background:
        "radial-gradient(120% 90% at 50% 30%, transparent 55%, hsl(var(--background) / 0.55) 100%)"
};

export function DeployCanvas({
    environment,
    canManage,
    stagedIds,
    onOpenService
}: {
    environment: ProjectSummary["environments"][number];
    canManage: boolean;
    /** Services and databases queued for removal in the changeset. They stay on
     *  the board - they are still running - but read as pending, so nobody
     *  believes a delete already happened or that one still needs doing. */
    stagedIds?: ReadonlySet<string>;
    onOpenService?: (app: ProjectApp) => void;
}) {
    const t = useTranslations("deploy");
    const nodes = useMemo(() => nodesFromEnvironment(environment, t), [environment, t]);
    const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);

    const initial = useMemo(() => {
        const parsed = parseLayout(environment.layout);
        return {
            pos: withSeededPositions(nodes, parsed.pos),
            links: parsed.links.filter(
                (link) => nodeIds.has(link.source) && nodeIds.has(link.target)
            )
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [environment.id]);

    const [pos, setPos] = useState<Record<string, Point>>(initial.pos);
    const [links, setLinks] = useState<Link[]>(initial.links);
    const [saving, setSaving] = useState(false);

    const router = useRouter();
    const { refresh: refreshStaged } = useStagedChanges();
    const staged = stagedIds ?? new Set<string>();
    const [deleteTarget, setDeleteTarget] = useState<{
        id: string;
        name: string;
        kind: "service" | "database";
        hostedCount?: number;
    } | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [managing, setManaging] = useState<{ id: string; name: string; engine: string } | null>(
        null
    );
    const [acting, setActing] = useState(false);
    const [newService, setNewService] = useState<{ open: boolean; view: ServiceView }>({
        open: false,
        view: "list"
    });
    const [newVolumeOpen, setNewVolumeOpen] = useState(false);
    // The volume panel and the tab it opens on: "Volume settings" lands on its
    // figures, "Edit mount" on the fields that change it.
    const [openVolume, setOpenVolume] = useState<{ id: string; tab: VolumeTab } | null>(null);
    const volumeServices = environment.applications.map((app) => ({ id: app.id, name: app.name }));

    function duplicate(app: ProjectApp) {
        setActing(true);
        void duplicateApplicationAction(app.id).finally(() => {
            setActing(false);
            router.refresh();
        });
    }

    /** Queue the removal (or carry it out, when the project has staging off). The
     *  banner is what completes it, so the dialog closes either way. */
    function confirmDelete() {
        if (!deleteTarget) return;
        const target = deleteTarget;
        setActing(true);
        setDeleteError(null);
        void (async () => {
            const result =
                target.kind === "database"
                    ? await stageDatabaseDeleteAction({ databaseId: target.id })
                    : await stageServiceDeleteAction({ applicationId: target.id });
            setActing(false);
            if (result.error) {
                setDeleteError(result.error);
                return;
            }
            setDeleteTarget(null);
            refreshStaged();
            router.refresh();
        })();
    }

    const containerRef = useRef<HTMLDivElement>(null);
    const boardRef = useRef<HTMLDivElement>(null);
    const posRef = useRef(pos);
    posRef.current = pos;

    // --- zoom ---------------------------------------------------------------
    // The board is drawn at its own coordinates and scaled as one piece, so the
    // stored layout never depends on how far the reader happened to be zoomed.
    const [zoom, setZoom] = useState(1);
    const zoomRef = useRef(1);
    // The scroll a zoom change has to land on, applied once the board has been
    // redrawn at its new size - scrolling before that is clamped to the old one.
    const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);

    /** Zoom to `next`, holding `anchor` (a point of the frame, the middle when
     *  omitted) over the same part of the board. */
    const zoomTo = useCallback((next: number, anchor?: Point) => {
        const container = containerRef.current;
        if (!container) return;
        const target = geometry.clampZoom(next);
        if (target === zoomRef.current) return;
        const scroll = pendingScrollRef.current ?? {
            left: container.scrollLeft,
            top: container.scrollTop
        };
        pendingScrollRef.current = geometry.scrollForZoom(
            scroll,
            anchor ?? { x: container.clientWidth / 2, y: container.clientHeight / 2 },
            zoomRef.current,
            target
        );
        zoomRef.current = target;
        setZoom(target);
    }, []);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const scroll = pendingScrollRef.current;
        if (!container || !scroll) return;
        pendingScrollRef.current = null;
        container.scrollLeft = scroll.left;
        container.scrollTop = scroll.top;
    }, [zoom]);

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

    // Cursor position in board coordinates. The board's box on screen is already
    // scaled, so the offset into it is divided back out of the zoom.
    const toBoard = useCallback((clientX: number, clientY: number): Point => {
        const rect = boardRef.current?.getBoundingClientRect();
        const scale = zoomRef.current;
        return {
            x: (clientX - (rect?.left ?? 0)) / scale,
            y: (clientY - (rect?.top ?? 0)) / scale
        };
    }, []);

    /** Scroll the board as little as it takes to put a card inside the frame, and
     *  nothing at all when it is already there. */
    const revealCard = useCallback((at: Point) => {
        const container = containerRef.current;
        if (!container) return;
        const pad = 24;
        const scale = zoomRef.current;
        const point = { x: at.x * scale, y: at.y * scale };
        const width = NODE_W * scale;
        const height = NODE_H * scale;
        const { scrollLeft, scrollTop, clientWidth, clientHeight } = container;
        if (point.x - pad < scrollLeft) container.scrollLeft = Math.max(0, point.x - pad);
        else if (point.x + width + pad > scrollLeft + clientWidth) {
            container.scrollLeft = point.x + width + pad - clientWidth;
        }
        if (point.y - pad < scrollTop) container.scrollTop = Math.max(0, point.y - pad);
        else if (point.y + height + pad > scrollTop + clientHeight) {
            container.scrollTop = point.y + height + pad - clientHeight;
        }
    }, []);

    /** Zoom and scroll so every service is in the frame at once. */
    function fitAll() {
        const container = containerRef.current;
        const bounds = geometry.boundsOf(
            nodes.map((node) => footprintOf(node, posRef.current[node.id] ?? { x: 0, y: 0 }))
        );
        if (!container || !bounds) return;
        const view = geometry.fitView(bounds, {
            width: container.clientWidth,
            height: container.clientHeight
        });
        const scroll = { left: view.scrollLeft, top: view.scrollTop };
        if (view.zoom === zoomRef.current) {
            container.scrollLeft = scroll.left;
            container.scrollTop = scroll.top;
            return;
        }
        pendingScrollRef.current = scroll;
        zoomRef.current = view.zoom;
        setZoom(view.zoom);
    }

    // The wheel zooms towards the pointer and dragging the board moves it, as on
    // the automation diagrams. The board is a scrolling box, so a move is a
    // scroll; a press on a card, a handle or a control is theirs, not the board's.
    const hasNodes = nodes.length > 0;
    useBoardGestures(
        containerRef,
        {
            onZoom: (factor, anchor) => zoomTo(zoomRef.current * factor, anchor),
            onPan: (dx, dy) => {
                const container = containerRef.current;
                if (!container) return;
                container.scrollLeft -= dx;
                container.scrollTop -= dy;
            },
            grabs: (target) =>
                !target.closest(
                    "[role='button'], button, a, input, textarea, select, [role='menuitem']"
                )
        },
        hasNodes
    );

    /**
     * Open the board on the services rather than on the corner it starts in.
     *
     * The board is a fixed coordinate space that opens at its top-left corner, and a
     * seeded node sits some 300px into it - past the right edge of a phone, and past
     * a narrow window on a desktop. Nothing said the board scrolled, so a project
     * with services in it opened on an empty stretch of dots and had to be dragged
     * around until they turned up. Framed once per environment, so panning the board
     * by hand is never undone underneath whoever is doing it.
     */
    const framedFor = useRef<string | null>(null);
    useEffect(() => {
        const container = containerRef.current;
        if (!container || framedFor.current === environment.id) return;
        const points = nodes
            .map((node) => pos[node.id])
            .filter((point): point is Point => Boolean(point));
        if (points.length === 0) return;
        framedFor.current = environment.id;
        // Centred on the services, unless they spread wider than the frame - then the
        // first one is put against the edge, so a phone opens on a whole card instead
        // of on the gap between two halves.
        const offset = (low: number, high: number, frame: number, extentOf: number): number =>
            Math.max(
                0,
                Math.min(
                    high - low > frame ? low - 24 : (low + high) / 2 - frame / 2,
                    extentOf - frame
                )
            );
        const scale = zoomRef.current;
        container.scrollLeft = offset(
            Math.min(...points.map((point) => point.x)) * scale,
            Math.max(...points.map((point) => point.x + NODE_W)) * scale,
            container.clientWidth,
            container.scrollWidth
        );
        container.scrollTop = offset(
            Math.min(...points.map((point) => point.y)) * scale,
            Math.max(...points.map((point) => point.y + NODE_H)) * scale,
            container.clientHeight,
            container.scrollHeight
        );
    }, [environment.id, nodes, pos]);

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
                next[node.id] = {
                    x: Math.max(0, Math.round(spawn.x / 8) * 8),
                    y: Math.max(0, Math.round(spawn.y / 8) * 8)
                };
            } else {
                next = withSeededPositions([node], next);
            }
        }
        setPos(next);
        persist(next, links);
        // A service made from the toolbar lands wherever there is room, which can be
        // outside the frame - and a card nobody can see reads as a service that was
        // never created. Waits a frame for the board to grow to its new extent.
        const landed = missing[0] ? next[missing[0].id] : undefined;
        if (landed) requestAnimationFrame(() => revealCard(landed));
    }, [nodes, links, persist, revealCard]);

    function openNewService(view: ServiceView) {
        pendingSpawnRef.current = menuSpawnRef.current;
        setNewService({ open: true, view });
    }

    // --- node dragging ------------------------------------------------------
    const [dragId, setDragId] = useState<string | null>(null);
    // The service the pointer or the keyboard is on, whose lines are lit.
    const [focusId, setFocusId] = useState<string | null>(null);

    /** Open a node: the service panel for an application, the Manage panel for a
     *  database. What a click does, and what Enter does on a focused card. */
    function openNode(id: string) {
        const app = environment.applications.find((item) => item.id === id);
        if (app && onOpenService) onOpenService(app);
        const database = environment.databases.find((item) => item.id === id);
        if (database) setManaging(database);
    }

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
            if (Math.abs(moveEvent.clientX - start.x) + Math.abs(moveEvent.clientY - start.y) > 4)
                moved = true;
            if (!canManage || !moved) return;
            // The pointer moves in screen pixels; the card moves in board ones.
            const scale = zoomRef.current;
            const nx = Math.round((origin.x + (moveEvent.clientX - start.x) / scale) / 8) * 8;
            const ny = Math.round((origin.y + (moveEvent.clientY - start.y) / scale) / 8) * 8;
            setPos((prev) => ({ ...prev, [id]: { x: Math.max(0, nx), y: Math.max(0, ny) } }));
        }
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            setDragId(null);
            // A click (no meaningful drag) opens the service detail for app nodes,
            // and a database's Manage panel for database nodes.
            if (!moved) {
                openNode(id);
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
            setPending((prev) =>
                prev ? { ...prev, cursor: toBoard(moveEvent.clientX, moveEvent.clientY) } : prev
            );
        }
        function up(upEvent: PointerEvent) {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            const cursor = toBoard(upEvent.clientX, upEvent.clientY);
            const target = nodes.find((node) => {
                const p = posRef.current[node.id];
                return (
                    p &&
                    cursor.x >= p.x &&
                    cursor.x <= p.x + NODE_W &&
                    cursor.y >= p.y &&
                    cursor.y <= p.y + NODE_H
                );
            });
            setPending(null);
            if (target && target.id !== source) {
                setLinks((prev) => {
                    if (
                        prev.some(
                            (l) =>
                                (l.source === source && l.target === target.id) ||
                                (l.source === target.id && l.target === source)
                        )
                    ) {
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

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const footprint = (id: string): geometry.Rect => {
        const node = nodeById.get(id);
        const at = pos[id] ?? { x: 0, y: 0 };
        return node ? footprintOf(node, at) : { x: at.x, y: at.y, w: NODE_W, h: NODE_H };
    };

    // The variable references between services, drawn under the links made by
    // hand; one already drawn by hand is not drawn twice.
    const referenceLines = (environment.referenceEdges ?? []).filter(
        (edge) =>
            nodeIds.has(edge.source) &&
            nodeIds.has(edge.target) &&
            !links.some(
                (link) =>
                    (link.source === edge.source && link.target === edge.target) ||
                    (link.source === edge.target && link.target === edge.source)
            )
    );
    const nameOf = (id: string): string => nodeById.get(id)?.name ?? "";

    // The service whose lines are lit: the one being dragged or linked from, else
    // the one under the pointer or the keyboard. Every other line steps back, so
    // what one service is joined to can be read even on a crowded board.
    const activeId = dragId ?? pending?.source ?? focusId;
    const neighbours = activeId
        ? geometry.neighboursOf(activeId, [...links, ...referenceLines])
        : new Set<string>();
    const touchesActive = (edge: Link): boolean =>
        activeId !== null && (edge.source === activeId || edge.target === activeId);

    // The card a link being dragged would land on, ringed so the drop is aimed.
    const linkTarget = pending
        ? nodes.find((node) => {
              const p = pos[node.id];
              return (
                  node.id !== pending.source &&
                  p &&
                  pending.cursor.x >= p.x &&
                  pending.cursor.x <= p.x + NODE_W &&
                  pending.cursor.y >= p.y &&
                  pending.cursor.y <= p.y + NODE_H
              );
          })?.id
        : undefined;

    // A service that is deploying keeps the lines into it moving.
    const inFlight = new Set(
        nodes.filter((node) => node.tone === "warning").map((node) => node.id)
    );

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
                        menuSpawnRef.current = boardRef.current
                            ? toBoard(event.clientX, event.clientY)
                            : null;
                    }}
                >
                    {board}
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <Plus className="size-4" /> {t("view.newService")}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                            {SERVICE_TYPES.map((type) => (
                                <ContextMenuItem
                                    key={type.id}
                                    onSelect={() => openNewService(type.id)}
                                >
                                    <span className="flex size-4 items-center justify-center [&_svg]:size-4">
                                        {type.icon}
                                    </span>
                                    {t(type.label)}
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
                                {t("canvas.volume")}
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
                        className="relative flex h-[calc(100dvh-11rem)] min-h-[460px] flex-col items-center justify-center overflow-hidden rounded-lg border border-border/60"
                        style={DOT_BG}
                    >
                        <div className="pointer-events-none absolute inset-0" style={VIGNETTE} />
                        <div className="relative flex flex-col items-center gap-2 text-center">
                            <span className="grid size-12 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
                                <HardDrive className="size-5" />
                            </span>
                            <p className="text-sm font-medium">{t("canvas.empty")}</p>
                            <p className="max-w-xs text-xs text-muted-foreground">
                                {canManage ? t("canvas.emptyManage") : t("canvas.emptyView")}
                            </p>
                            {canManage && (
                                <Button
                                    size="sm"
                                    className="mt-2"
                                    onClick={() => {
                                        // Not from a right-click, so no spot to land on.
                                        menuSpawnRef.current = null;
                                        openNewService("list");
                                    }}
                                >
                                    <Plus /> {t("view.newService")}
                                </Button>
                            )}
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
                    <Loader2 className="size-3 animate-spin" /> {t("canvas.saving")}
                </span>
            )}
            {boardMenu(
                <div className="relative h-[calc(100dvh-11rem)] min-h-[460px] overflow-hidden rounded-lg border border-border/60">
                    <div
                        ref={containerRef}
                        data-board-frame
                        className={`absolute inset-0 cursor-grab overflow-auto overscroll-contain data-[panning]:cursor-grabbing${hasNodes ? " touch-none" : ""}`}
                        style={DOT_BG}
                    >
                        {/* Sized to the board at the current zoom, so the frame
                            scrolls exactly as far as the scaled board reaches. */}
                        <div
                            className="relative"
                            style={{ width: extent.w * zoom, height: extent.h * zoom }}
                        >
                            <div
                                ref={boardRef}
                                className="absolute left-0 top-0 origin-top-left"
                                style={{
                                    width: extent.w,
                                    height: extent.h,
                                    transform: zoom === 1 ? undefined : `scale(${zoom})`
                                }}
                            >
                                <svg
                                    className="pointer-events-none absolute inset-0 overflow-visible"
                                    width={extent.w}
                                    height={extent.h}
                                >
                                    {referenceLines.map((line) => {
                                        const path = geometry.edgePath(
                                            footprint(line.source),
                                            footprint(line.target)
                                        );
                                        const lit = touchesActive(line);
                                        const moving =
                                            inFlight.has(line.source) || inFlight.has(line.target);
                                        return (
                                            <path
                                                key={`ref-${line.source}-${line.target}`}
                                                d={path.d}
                                                fill="none"
                                                stroke={
                                                    lit
                                                        ? "hsl(var(--primary))"
                                                        : "hsl(var(--primary) / 0.55)"
                                                }
                                                strokeWidth={lit ? 2 : 1.5}
                                                strokeDasharray="6 5"
                                                strokeLinecap="round"
                                                className={`pointer-events-auto transition-opacity ${
                                                    activeId && !lit ? "opacity-25" : ""
                                                } ${moving ? "deploy-edge-flow" : ""}`}
                                            >
                                                <title>
                                                    {t("canvas.referenceLine", {
                                                        source: nameOf(line.source),
                                                        target: nameOf(line.target)
                                                    })}
                                                </title>
                                            </path>
                                        );
                                    })}
                                    {links.map((link, index) => {
                                        const path = geometry.edgePath(
                                            footprint(link.source),
                                            footprint(link.target)
                                        );
                                        const lit = touchesActive(link);
                                        const moving =
                                            inFlight.has(link.source) || inFlight.has(link.target);
                                        const removeLabel = t("canvas.removeLinkBetween", {
                                            source: nameOf(link.source),
                                            target: nameOf(link.target)
                                        });
                                        return (
                                            <g
                                                key={`${link.source}-${link.target}-${index}`}
                                                className={`group/edge pointer-events-auto transition-opacity ${
                                                    activeId && !lit ? "opacity-30" : ""
                                                }`}
                                            >
                                                {/* A wide invisible stroke, so the line can be
                                                pointed at without pixel hunting. */}
                                                <path
                                                    d={path.d}
                                                    fill="none"
                                                    stroke="transparent"
                                                    strokeWidth={16}
                                                />
                                                <path
                                                    d={path.d}
                                                    fill="none"
                                                    stroke={
                                                        lit
                                                            ? "hsl(var(--primary))"
                                                            : "hsl(var(--muted-foreground) / 0.45)"
                                                    }
                                                    strokeWidth={2}
                                                    strokeLinecap="round"
                                                    className="transition-[stroke] group-hover/edge:[stroke:hsl(var(--muted-foreground)/0.8)]"
                                                />
                                                {moving && (
                                                    <path
                                                        d={path.d}
                                                        fill="none"
                                                        stroke="hsl(var(--warning-solid))"
                                                        strokeWidth={2}
                                                        strokeLinecap="round"
                                                        strokeDasharray="4 7"
                                                        className="deploy-edge-flow"
                                                    />
                                                )}
                                                {canManage && (
                                                    <g
                                                        role="button"
                                                        tabIndex={0}
                                                        aria-label={removeLabel}
                                                        transform={`translate(${path.mid.x} ${path.mid.y})`}
                                                        onClick={() => removeLink(index)}
                                                        onKeyDown={(event) => {
                                                            if (
                                                                event.key !== "Enter" &&
                                                                event.key !== " "
                                                            )
                                                                return;
                                                            event.preventDefault();
                                                            removeLink(index);
                                                        }}
                                                        className={`cursor-pointer outline-none transition-opacity focus-visible:opacity-100 group-hover/edge:opacity-100 [@media(hover:none)]:opacity-100 [&:focus-visible>circle]:stroke-primary ${
                                                            lit ? "opacity-100" : "opacity-0"
                                                        }`}
                                                    >
                                                        <title>{removeLabel}</title>
                                                        <circle
                                                            r={10}
                                                            className="fill-card stroke-border"
                                                            strokeWidth={1.5}
                                                        />
                                                        <path
                                                            d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5"
                                                            className="stroke-muted-foreground"
                                                            strokeWidth={1.5}
                                                            strokeLinecap="round"
                                                        />
                                                    </g>
                                                )}
                                            </g>
                                        );
                                    })}
                                    {pending && (
                                        <path
                                            d={
                                                geometry.edgePath(
                                                    footprint(pending.source),
                                                    linkTarget
                                                        ? footprint(linkTarget)
                                                        : { ...pending.cursor, w: 0, h: 0 }
                                                ).d
                                            }
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
                                    const label =
                                        node.tone === "success"
                                            ? t("canvas.online")
                                            : node.statusLabel;
                                    const app = environment.applications.find(
                                        (item) => item.id === node.id
                                    );
                                    const removing = staged.has(node.id);
                                    const chrome = removing
                                        ? "border-primary/60 ring-1 ring-primary/30"
                                        : dragId === node.id || linkTarget === node.id
                                          ? "border-primary ring-2 ring-primary/40"
                                          : neighbours.has(node.id)
                                            ? "border-primary/50"
                                            : TONE_BORDER[node.tone];
                                    const card = (
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            aria-label={t("canvas.openNode", {
                                                name: node.name,
                                                status: removing ? t("view.removalPending") : label
                                            })}
                                            className={`group absolute flex select-none flex-col border bg-elevated outline-none transition-[border-color,box-shadow] hover:shadow-popover hover:shadow-black/25 focus-visible:ring-2 focus-visible:ring-ring ${
                                                node.volume || node.volumes?.length
                                                    ? "rounded-t-2xl"
                                                    : "rounded-2xl"
                                            } ${chrome} ${canManage ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
                                            style={{
                                                left: p.x,
                                                top: p.y,
                                                width: NODE_W,
                                                height: NODE_H
                                            }}
                                            onPointerDown={(event) =>
                                                onNodePointerDown(event, node.id)
                                            }
                                            onPointerEnter={() => setFocusId(node.id)}
                                            onPointerLeave={() =>
                                                setFocusId((current) =>
                                                    current === node.id ? null : current
                                                )
                                            }
                                            onFocus={() => setFocusId(node.id)}
                                            onBlur={() =>
                                                setFocusId((current) =>
                                                    current === node.id ? null : current
                                                )
                                            }
                                            onKeyDown={(event) => {
                                                if (event.target !== event.currentTarget) return;
                                                if (event.key !== "Enter" && event.key !== " ")
                                                    return;
                                                event.preventDefault();
                                                openNode(node.id);
                                            }}
                                            onContextMenu={(event) => event.stopPropagation()}
                                        >
                                            <div
                                                className={`flex flex-1 flex-col p-4 ${removing ? "opacity-60" : ""}`}
                                            >
                                                <div className="flex items-center gap-3">
                                                    {node.engine ? (
                                                        <DbEngineIcon
                                                            engine={node.engine}
                                                            className="size-10 rounded-xl"
                                                        />
                                                    ) : (
                                                        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
                                                            <ServiceIcon
                                                                kind={node.kind}
                                                                className="size-5"
                                                            />
                                                        </span>
                                                    )}
                                                    <span
                                                        className="min-w-0 flex-1 truncate text-base font-semibold"
                                                        title={node.name}
                                                    >
                                                        {node.name}
                                                    </span>
                                                </div>
                                                <p className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                                                    {node.elsewhere && (
                                                        <>
                                                            <IntegrationLogo
                                                                slug={node.elsewhere.provider}
                                                                className="size-3.5 w-4 shrink-0 object-contain"
                                                            />
                                                            <span
                                                                className={`size-1.5 shrink-0 rounded-full ${
                                                                    node.elsewhere.status === "live"
                                                                        ? "bg-success-solid"
                                                                        : node.elsewhere.status ===
                                                                            "failed"
                                                                          ? "bg-danger-solid"
                                                                          : "bg-foreground-subtle"
                                                                }`}
                                                            />
                                                        </>
                                                    )}
                                                    <span
                                                        className="truncate"
                                                        title={node.subtitle}
                                                    >
                                                        {node.subtitle}
                                                    </span>
                                                </p>
                                                <div className="mt-auto flex min-w-0 items-center">
                                                    {removing ? (
                                                        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                                                            <span className="size-1.5 rounded-full bg-primary" />
                                                            {t("view.removalPending")}
                                                        </span>
                                                    ) : (
                                                        <StatusPill
                                                            tone={node.tone}
                                                            label={label}
                                                            // An application's state is already
                                                            // words; a database's is its raw status.
                                                            capitalize={!app}
                                                        />
                                                    )}
                                                </div>
                                            </div>
                                            {canManage && (
                                                <button
                                                    type="button"
                                                    title={t("canvas.dragToLink")}
                                                    // Linking is a drag, which a keyboard
                                                    // cannot do; the card itself is the
                                                    // keyboard's way in.
                                                    tabIndex={-1}
                                                    aria-hidden
                                                    onPointerDown={(event) =>
                                                        onHandlePointerDown(event, node.id)
                                                    }
                                                    className="absolute -right-1.5 top-1/2 size-3.5 -translate-y-1/2 rounded-full border-2 border-primary bg-card opacity-0 transition-opacity hover:bg-primary group-hover:opacity-100"
                                                />
                                            )}
                                        </div>
                                    );
                                    return (
                                        <Fragment key={node.id}>
                                            {canManage ? (
                                                <ContextMenu>
                                                    <ContextMenuTrigger asChild>
                                                        {card}
                                                    </ContextMenuTrigger>
                                                    <ContextMenuContent>
                                                        {app && (
                                                            <>
                                                                <ContextMenuItem
                                                                    onSelect={() =>
                                                                        onOpenService?.(app)
                                                                    }
                                                                >
                                                                    <ScrollText className="size-4" />{" "}
                                                                    {t("canvas.openService")}
                                                                </ContextMenuItem>
                                                                <ContextMenuItem
                                                                    onSelect={() => duplicate(app)}
                                                                >
                                                                    <Copy className="size-4" />{" "}
                                                                    {t("canvas.duplicate")}
                                                                </ContextMenuItem>
                                                            </>
                                                        )}
                                                        {!app && (
                                                            <ContextMenuItem
                                                                onSelect={() =>
                                                                    setManaging({
                                                                        id: node.id,
                                                                        name: node.name,
                                                                        engine: node.engine ?? ""
                                                                    })
                                                                }
                                                            >
                                                                <Settings2 className="size-4" />{" "}
                                                                {t("view.manage")}
                                                            </ContextMenuItem>
                                                        )}
                                                        <ContextMenuSeparator />
                                                        <ContextMenuItem
                                                            variant="danger"
                                                            disabled={removing}
                                                            onSelect={() =>
                                                                setDeleteTarget({
                                                                    id: node.id,
                                                                    name: node.name,
                                                                    kind: app
                                                                        ? "service"
                                                                        : "database",
                                                                    hostedCount:
                                                                        node.hostedCount ?? 0
                                                                })
                                                            }
                                                        >
                                                            <Trash2 className="size-4" />
                                                            {removing
                                                                ? t("view.removalPending")
                                                                : t("canvas.delete")}
                                                        </ContextMenuItem>
                                                    </ContextMenuContent>
                                                </ContextMenu>
                                            ) : (
                                                card
                                            )}
                                            {node.volume && (
                                                <div
                                                    className="absolute flex items-center gap-2 rounded-b-2xl border border-t-0 border-border bg-card/60 px-4 py-2.5 text-xs text-muted-foreground"
                                                    style={{
                                                        left: p.x,
                                                        top: p.y + NODE_H,
                                                        width: NODE_W
                                                    }}
                                                >
                                                    <HardDrive className="size-3.5 shrink-0" />{" "}
                                                    {node.volume}
                                                </div>
                                            )}
                                            {node.volumes?.map((vol, vi) => (
                                                <ContextMenu key={vol.id}>
                                                    <ContextMenuTrigger asChild>
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                setOpenVolume({
                                                                    id: vol.id,
                                                                    tab: "Metrics"
                                                                })
                                                            }
                                                            onContextMenu={(event) =>
                                                                event.stopPropagation()
                                                            }
                                                            className={`absolute flex items-center gap-2 border border-t-0 border-border bg-card/60 px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-card ${
                                                                vi ===
                                                                (node.volumes?.length ?? 0) - 1
                                                                    ? "rounded-b-2xl"
                                                                    : ""
                                                            }`}
                                                            style={{
                                                                left: p.x,
                                                                top:
                                                                    p.y + NODE_H + vi * VOL_STRIP_H,
                                                                width: NODE_W
                                                            }}
                                                        >
                                                            <HardDrive
                                                                className={`size-3.5 shrink-0 ${vol.kind === "nas" ? "text-sky-400" : ""}`}
                                                            />
                                                            <span
                                                                className="truncate"
                                                                title={vol.name}
                                                            >
                                                                {vol.name}
                                                            </span>
                                                            <span className="ml-auto shrink-0 truncate text-[0.625rem] text-muted-foreground/70">
                                                                {vol.kind === "nas"
                                                                    ? (vol.connectionName ??
                                                                      t("canvas.nas"))
                                                                    : vol.kind === "bind"
                                                                      ? t("canvas.server")
                                                                      : t("canvas.volume")}
                                                            </span>
                                                        </button>
                                                    </ContextMenuTrigger>
                                                    <ContextMenuContent>
                                                        <ContextMenuItem
                                                            onSelect={() =>
                                                                setOpenVolume({
                                                                    id: vol.id,
                                                                    tab: "Metrics"
                                                                })
                                                            }
                                                        >
                                                            <Settings2 className="size-4" />{" "}
                                                            {t("canvas.volumeSettings")}
                                                        </ContextMenuItem>
                                                        <ContextMenuItem
                                                            onSelect={() =>
                                                                setOpenVolume({
                                                                    id: vol.id,
                                                                    tab: "Files"
                                                                })
                                                            }
                                                        >
                                                            <Files className="size-4" />{" "}
                                                            {t("canvas.browseFiles")}
                                                        </ContextMenuItem>
                                                        <ContextMenuItem
                                                            onSelect={() =>
                                                                router.push(
                                                                    volumeDriveHref(node.id, vol)
                                                                )
                                                            }
                                                        >
                                                            <HardDrive className="size-4" />{" "}
                                                            {t("canvas.viewInDrive")}
                                                        </ContextMenuItem>
                                                        {canManage && (
                                                            <ContextMenuItem
                                                                onSelect={() =>
                                                                    setOpenVolume({
                                                                        id: vol.id,
                                                                        tab: "Settings"
                                                                    })
                                                                }
                                                            >
                                                                <ScrollText className="size-4" />{" "}
                                                                {t("canvas.editMount")}
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
                    </div>
                    <div
                        className="pointer-events-none absolute inset-0 rounded-lg"
                        style={VIGNETTE}
                    />
                    <div
                        role="toolbar"
                        aria-label={t("canvas.zoomControls")}
                        aria-orientation="vertical"
                        className="absolute bottom-3 right-3 z-10 flex flex-col items-center gap-0.5 rounded-lg border border-border bg-elevated/95 p-0.5 shadow-popover backdrop-blur"
                        // The board's own right-click menu is for adding a service;
                        // it has nothing to offer over the zoom controls.
                        onContextMenu={(event) => event.stopPropagation()}
                    >
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("canvas.zoomIn")}
                            title={t("canvas.zoomIn")}
                            disabled={zoom >= geometry.ZOOM_MAX}
                            onClick={() => zoomTo(zoomRef.current * geometry.ZOOM_STEP)}
                        >
                            <ZoomIn aria-hidden />
                        </Button>
                        <button
                            type="button"
                            aria-label={t("canvas.resetZoom")}
                            title={t("canvas.resetZoom")}
                            onClick={() => zoomTo(1)}
                            className="h-6 w-9 rounded text-[0.6875rem] tabular-nums text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
                        >
                            {Math.round(zoom * 100)}%
                        </button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("canvas.zoomOut")}
                            title={t("canvas.zoomOut")}
                            disabled={zoom <= geometry.ZOOM_MIN}
                            onClick={() => zoomTo(zoomRef.current / geometry.ZOOM_STEP)}
                        >
                            <ZoomOut aria-hidden />
                        </Button>
                        <span className="my-0.5 h-px w-5 bg-border" aria-hidden />
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("canvas.fitView")}
                            title={t("canvas.fitView")}
                            onClick={fitAll}
                        >
                            <Maximize2 aria-hidden />
                        </Button>
                    </div>
                </div>
            )}
            {canManage && (
                <p className="mt-2 text-xs text-muted-foreground/70">
                    {t("canvas.hint")}
                    {/* Only where there is a wheel to scroll: a touch screen pinches. */}
                    <span className="hidden [@media(pointer:fine)]:inline">
                        {" "}
                        {t("canvas.hintZoom")}
                    </span>
                </p>
            )}

            <ConfirmDeleteDialog
                open={deleteTarget !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleteTarget(null);
                        setDeleteError(null);
                    }
                }}
                name={deleteTarget?.name ?? ""}
                kind={deleteTarget?.kind ?? "service"}
                title={
                    deleteTarget?.kind === "database"
                        ? t("view.deleteDatabase")
                        : t("canvas.deleteServiceTitle")
                }
                description={
                    deleteTarget?.kind === "database"
                        ? deleteTarget.hostedCount
                            ? t("view.removeHost", { count: deleteTarget.hostedCount })
                            : t("view.removeContainer")
                        : t("canvas.removeService")
                }
                confirmLabel={t("view.stageRemoval")}
                error={deleteError}
                pending={acting}
                onConfirm={confirmDelete}
            />

            <VolumeDetailDialog
                volumeId={openVolume?.id ?? null}
                tab={openVolume?.tab}
                onOpenChange={(open) => !open && setOpenVolume(null)}
                onChanged={() => router.refresh()}
            />
            {managing ? (
                <DatabaseManageDialog
                    database={managing}
                    open
                    deployManage={canManage}
                    onOpenChange={(open) => {
                        if (!open) {
                            setManaging(null);
                            router.refresh();
                        }
                    }}
                />
            ) : null}
            {dialog}
        </div>
    );
}
