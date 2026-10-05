"use client";

/**
 * A place at a glance: the landing page of Places.
 *
 * Laid out the way Home Assistant's Home dashboard settled on: the summaries
 * first (devices, lights, climate, security, cameras, what needs you), then the
 * place by room with each device's own control on its row, and beside it the
 * cameras as one card among others, the automations that can be run now and what
 * the cameras noticed last. A summary for something the place has none of is not
 * drawn.
 *
 * The frame is on screen before anything is read. The last copy this tab read
 * paints at once while the fresh one is fetched; until that lands the controls
 * wait, because a lock's state from a minute ago is not one to act on. After
 * that the page reads again on the half minute while it is in front, the same
 * rhythm as the devices screen.
 */

import Link from "next/link";
import * as actions from "./actions";
import type { ReactNode } from "react";
import { usePlacesT } from "../use-places-t";
import * as overview from "../../lib/overview";
import { kindLabel } from "../detection-label";
import type { LucideIcon } from "lucide-react";
import * as kinds from "../../lib/device-kinds";
import { CameraViewer } from "../camera-viewer";
import { hostUi } from "@polaris/app-host/client";
import type { CameraView } from "../../lib/cameras";
import * as words from "../../lib/automation-words";
import type { PlaceView } from "../../lib/place-kinds";
import { DeviceDialog } from "../devices/device-dialog";
import { useDeviceAct } from "../devices/use-device-act";
import type { DeviceView } from "../../lib/device-kinds";
import { drawsFromBattery } from "../../lib/camera-models";
import * as automationActions from "../automations/actions";
import { dropAutomationsCache } from "../automations/cache";
import { Badge, Button, Card, Skeleton, cn } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeviceControls, DeviceIcon, DevicePanel, stateClass, toneClass } from "../devices/device-panel";
import {
    AlertTriangle,
    ArrowRight,
    BatteryLow,
    Bell,
    Cctv,
    CheckCircle2,
    DoorOpen,
    Lightbulb,
    Loader2,
    Lock,
    Package,
    Play,
    Plug,
    Sofa,
    Thermometer,
    Unplug,
    Workflow
} from "lucide-react";

const { runAction } = hostUi.runAction;
const { RelativeTime } = hostUi.relativeTime;
const { readSnapshot, writeSnapshot } = hostUi.snapshotCache;

/** How often the page reads again while it is in front, and how long the copy
 *  it keeps is good for painting from. */
const REFRESH_MS = 30_000;

/** How many cameras the card draws before it points at the live view. */
const CAMERA_TILES = 4;

/** How many automations the quick-run card lists. */
const ROUTINES = 5;

const CACHE_PREFIX = "places.overview.";

export function OverviewView({
    placeId,
    places,
    resident,
    canControl,
    canManage
}: {
    placeId: string;
    places: readonly PlaceView[];
    /** Whether the reader lives here, rather than was lent one thing: only then
     *  are the automations and the events theirs to see. */
    resident: boolean;
    canControl: boolean;
    canManage: boolean;
}) {
    const t = usePlacesT();
    const [data, setData] = useState<actions.PlaceOverview | null>(null);
    /** Whether `data` came from the server on this visit, not from the tab's copy. */
    const [fresh, setFresh] = useState(false);
    const [error, setError] = useState("");
    const [opened, setOpened] = useState<DeviceView | null>(null);
    const [editing, setEditing] = useState<DeviceView | null>(null);
    const [watching, setWatching] = useState<CameraView | null>(null);
    /** Bumped on each refresh, so the camera pictures are asked for again. */
    const [tick, setTick] = useState(0);
    const router = useRouter();
    const showing = useRef(placeId);
    const cacheKey = `${CACHE_PREFIX}${placeId}`;

    const load = useCallback(
        async (sync: boolean) => {
            const result = await actions.placeOverviewAction({ sync });
            if (showing.current !== placeId) return;
            if (result.overview) {
                if (result.overview.placeId !== placeId) {
                    setFresh(false);
                    router.refresh();
                    return;
                }
                setData(result.overview);
                setFresh(true);
                writeSnapshot(cacheKey, result.overview);
                setError("");
            } else if (result.error) {
                setError(result.error);
            }
        },
        [cacheKey, placeId, router]
    );

    useEffect(() => {
        showing.current = placeId;
        const cached = readSnapshot<actions.PlaceOverview>(cacheKey, REFRESH_MS);
        setData(cached?.value ?? null);
        setFresh(false);
        setError("");
        setOpened(null);
        setEditing(null);
        setWatching(null);
        void load(false);
    }, [cacheKey, placeId, load]);

    useEffect(() => {
        const refresh = () => {
            if (document.visibilityState !== "visible") return;
            setTick((value) => value + 1);
            void load(true);
        };
        const timer = setInterval(refresh, REFRESH_MS);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [load]);

    const update = useCallback((change: (entry: DeviceView) => DeviceView) => {
        setData((current) => (current ? { ...current, devices: current.devices.map(change) } : current));
        setOpened((current) => (current ? change(current) : current));
    }, []);
    const { busy, act } = useDeviceAct({ update, setError, resync: () => void load(true) });

    const devices = data?.devices ?? null;
    const summary = useMemo(() => (devices ? overview.summarizeDevices(devices) : null), [devices]);
    const rooms = useMemo(() => (devices ? overview.groupByRoom(devices) : null), [devices]);
    // Nothing is pressed on a copy from earlier: it paints, and waits.
    const mayOperate = canControl && fresh;
    // A place that could not be read is not drawn as one with nothing in it.
    const unread = data === null && error !== "";

    const onAct = (device: DeviceView) => (action: kinds.DeviceAction, command?: kinds.DeviceCommand) => {
        // Thrown by `act` so the panel can show it; here the line above has it.
        void act(device, action, command).catch(() => undefined);
    };

    return (
        <div className="flex flex-col gap-6">
            {error ? (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            ) : null}

            {unread ? null : <SummaryTiles summary={summary} cameras={data?.cameras.length ?? null} />}

            {summary && summary.attention.length > 0 ? (
                <AttentionCard items={summary.attention} onOpen={setOpened} />
            ) : null}

            <div className={unread ? "hidden" : "flex flex-col gap-6 lg:grid lg:grid-cols-3 lg:items-start"}>
                <section aria-label={t("placeOverview.rooms.title")} className="order-2 flex min-w-0 flex-col gap-3 lg:order-none lg:col-span-2">
                    <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-foreground-subtle">
                        {t("placeOverview.rooms.title")}
                    </h2>
                    {rooms === null ? (
                        <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
                            <RoomSkeleton />
                            <RoomSkeleton />
                        </div>
                    ) : rooms.length === 0 ? (
                        <Card className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                            <Plug className="size-5 text-muted-foreground" aria-hidden="true" />
                            <p className="text-sm font-medium">{t("placeOverview.rooms.emptyTitle")}</p>
                            <p className="max-w-sm text-xs text-muted-foreground">
                                {canManage ? t("placeOverview.rooms.emptyManage") : t("placeOverview.rooms.emptyView")}
                            </p>
                            {canManage ? (
                                <Button asChild size="sm" className="mt-1">
                                    <Link href="/places/devices">{t("placeOverview.rooms.connect")}</Link>
                                </Button>
                            ) : null}
                        </Card>
                    ) : (
                        <div className="grid gap-3 sm:grid-cols-2">
                            {rooms.map((room) => (
                                <RoomCard
                                    key={room.name || "unplaced"}
                                    room={room}
                                    canControl={mayOperate}
                                    busy={busy}
                                    onOpen={setOpened}
                                    onAct={onAct}
                                />
                            ))}
                        </div>
                    )}
                </section>

                {/* One column beside the rooms on a wide screen; on a phone its cards
                    take their own places in the page, cameras first. */}
                <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
                    <div className="order-1 min-w-0 lg:order-none">
                        <CamerasCard
                            cameras={data?.cameras ?? null}
                            canManage={canManage}
                            tick={tick}
                            onWatch={setWatching}
                        />
                    </div>
                    {resident ? (
                        <div className="order-3 min-w-0 lg:order-none">
                            <RoutinesCard
                                automations={data?.automations ?? null}
                                canManage={canManage}
                                onRan={(id, status) =>
                                    setData((current) =>
                                        current?.automations
                                            ? {
                                                  ...current,
                                                  automations: current.automations.map((entry) =>
                                                      entry.id === id
                                                          ? { ...entry, lastStatus: status, lastRunAt: new Date().toISOString() }
                                                          : entry
                                                  )
                                              }
                                            : current
                                    )
                                }
                            />
                        </div>
                    ) : null}
                    {resident ? (
                        <div className="order-4 min-w-0 lg:order-none">
                            <EventsCard events={data?.events ?? null} />
                        </div>
                    ) : null}
                </div>
            </div>

            <DevicePanel
                device={opened}
                canControl={mayOperate}
                canManage={canManage}
                onClose={() => setOpened(null)}
                onAct={act}
                onEdit={(device) => {
                    setOpened(null);
                    setEditing(device);
                }}
            />
            <DeviceDialog
                device={editing}
                places={places}
                onClose={() => setEditing(null)}
                onSaved={(device) => {
                    update((entry) => (entry.id === device.id ? device : entry));
                    setEditing(null);
                }}
            />
            {watching ? (
                <CameraViewer camera={watching} canControl={canControl} onClose={() => setWatching(null)} />
            ) : null}
        </div>
    );
}

/** A card in the Overview's own frame: a heading, a way into the screen behind it,
 *  and a body. */
function OverviewCard({
    title,
    icon: Icon,
    href,
    hint,
    children
}: {
    title: string;
    icon: LucideIcon;
    href?: string;
    hint?: ReactNode;
    children: ReactNode;
}) {
    const t = usePlacesT();
    return (
        <Card className="flex min-w-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight" title={title}>
                    {title}
                </h2>
                {hint}
                {href ? (
                    <Link
                        href={href}
                        title={t("placeOverview.open", { name: title })}
                        aria-label={t("placeOverview.open", { name: title })}
                        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                ) : null}
            </div>
            {children}
        </Card>
    );
}

type Tone = "ok" | "warn" | "bad" | "muted";

const TILE_TONES: Record<Tone, string> = {
    ok: "text-success",
    warn: "text-warning",
    bad: "text-danger",
    muted: "text-muted-foreground"
};

interface Tile {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly detail?: string;
    readonly icon: LucideIcon;
    readonly tone: Tone;
    readonly href: string;
}

/** The summaries, one per sort of thing this place actually has. */
function SummaryTiles({
    summary,
    cameras
}: {
    summary: overview.DeviceSummary | null;
    cameras: number | null;
}) {
    const t = usePlacesT();
    if (!summary || cameras === null) {
        return (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-busy="true">
                {[0, 1, 2, 3].map((index) => (
                    <div key={index} className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
                        <Skeleton className="h-3 w-16" />
                        <Skeleton className="h-4 w-24" />
                    </div>
                ))}
            </div>
        );
    }
    const tiles = summaryTiles(summary, cameras, t);
    if (tiles.length === 0) return null;
    return (
        <section aria-label={t("placeOverview.summary.label")} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {tiles.map((tile) => (
                <Link
                    key={tile.key}
                    href={tile.href}
                    className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-muted"
                >
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <tile.icon className={cn("size-3.5 shrink-0", TILE_TONES[tile.tone])} aria-hidden="true" />
                        <span className="truncate" title={tile.label}>{tile.label}</span>
                    </span>
                    <span className="truncate text-sm font-semibold" title={tile.value}>
                        {tile.value}
                    </span>
                    {tile.detail ? (
                        <span className="truncate text-[0.6875rem] text-foreground-subtle" title={tile.detail}>
                            {tile.detail}
                        </span>
                    ) : null}
                </Link>
            ))}
        </section>
    );
}

/** The tiles for a summary, leaving out what the place has none of. Exported for
 *  the test that holds that rule. */
export function summaryTiles(
    summary: overview.DeviceSummary,
    cameras: number,
    t: ReturnType<typeof usePlacesT>
): Tile[] {
    const tiles: Tile[] = [];
    if (summary.total > 0) {
        tiles.push({
            key: "devices",
            label: t("placeOverview.summary.devices"),
            value: t("placeOverview.summary.online", { online: summary.online, total: summary.total }),
            detail:
                summary.offline > 0
                    ? t("placeOverview.summary.offline", { count: summary.offline })
                    : t("placeOverview.summary.allOnline"),
            icon: summary.offline > 0 ? Unplug : CheckCircle2,
            tone: summary.offline > 0 ? "bad" : "ok",
            href: "/places/devices"
        });
    }
    if (summary.lights > 0) {
        tiles.push({
            key: "lights",
            label: t("placeOverview.summary.lights"),
            value:
                summary.lightsOn > 0
                    ? t("placeOverview.summary.lightsOn", { count: summary.lightsOn })
                    : t("placeOverview.summary.allOff"),
            detail: t("placeOverview.summary.ofTotal", { total: summary.lights }),
            icon: Lightbulb,
            tone: summary.lightsOn > 0 ? "warn" : "muted",
            href: "/places/devices"
        });
    }
    if (summary.climate > 0 || summary.temperatures) {
        const spread = summary.temperatures;
        const temperature = spread
            ? kinds.degreesText(spread.min) === kinds.degreesText(spread.max)
                ? kinds.temperatureText(spread.min, spread.unit)
                : t("placeOverview.summary.temperatureRange", {
                      min: kinds.degreesText(spread.min),
                      max: kinds.temperatureText(spread.max, spread.unit)
                  })
            : null;
        const running =
            summary.climate > 0
                ? summary.climateOn > 0
                    ? t("placeOverview.summary.running", { count: summary.climateOn })
                    : t("placeOverview.summary.allOff")
                : undefined;
        tiles.push({
            key: "climate",
            label: t("placeOverview.summary.climate"),
            value: temperature ?? running ?? "",
            detail: temperature ? running : undefined,
            icon: Thermometer,
            tone: summary.climateOn > 0 ? "ok" : "muted",
            href: "/places/devices"
        });
    }
    if (summary.locks > 0) {
        tiles.push({
            key: "security",
            label: t("placeOverview.summary.security"),
            value:
                summary.unlocked > 0
                    ? t("placeOverview.summary.unlocked", { count: summary.unlocked })
                    : t("placeOverview.summary.allLocked"),
            detail: summary.doorsOpen > 0 ? t("placeOverview.summary.doorsOpen", { count: summary.doorsOpen }) : undefined,
            icon: summary.unlocked > 0 || summary.doorsOpen > 0 ? DoorOpen : Lock,
            tone: summary.unlocked > 0 || summary.doorsOpen > 0 ? "warn" : "ok",
            href: "/places/devices"
        });
    }
    if (cameras > 0) {
        tiles.push({
            key: "cameras",
            label: t("placeOverview.summary.cameras"),
            value: t("placeOverview.summary.cameraCount", { count: cameras }),
            icon: Cctv,
            tone: "muted",
            href: "/places/live"
        });
    }
    if (summary.total > 0) {
        const count = summary.attention.length;
        tiles.push({
            key: "attention",
            label: t("placeOverview.summary.attention"),
            value: count > 0 ? t("placeOverview.summary.needYou", { count }) : t("placeOverview.summary.allGood"),
            icon: count > 0 ? AlertTriangle : CheckCircle2,
            tone: count > 0 ? "warn" : "ok",
            href: "/places/devices"
        });
    }
    return tiles;
}

const ATTENTION_TONES: Record<overview.AttentionReason, kinds.DeviceTone> = {
    jammed: "danger",
    offline: "danger",
    battery: "warning",
    "door-open": "warning"
};

/** What needs somebody, each a press away from its panel. */
function AttentionCard({
    items,
    onOpen
}: {
    items: readonly overview.Attention[];
    onOpen: (device: DeviceView) => void;
}) {
    const t = usePlacesT();
    return (
        <OverviewCard title={t("placeOverview.attention.title")} icon={AlertTriangle} href="/places/devices">
            <ul className="flex flex-col divide-y divide-border">
                {items.map(({ device, reason }) => (
                    <li key={device.id}>
                        <button
                            type="button"
                            onClick={() => onOpen(device)}
                            className="flex w-full min-w-0 items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-muted"
                        >
                            {reason === "battery" ? (
                                <BatteryLow className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            ) : (
                                <DeviceIcon kind={device.kind} className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-sm" title={device.name}>
                                    {device.name}
                                </span>
                                {device.zone ? (
                                    <span className="truncate text-[0.6875rem] text-foreground-subtle">{device.zone}</span>
                                ) : null}
                            </span>
                            <Badge className={cn("shrink-0", toneClass(ATTENTION_TONES[reason]))}>
                                {t(`placeOverview.attention.reasons.${reason}`)}
                            </Badge>
                        </button>
                    </li>
                ))}
            </ul>
        </OverviewCard>
    );
}

/** One room: its devices, each with its own control on the row. */
function RoomCard({
    room,
    canControl,
    busy,
    onOpen,
    onAct
}: {
    room: overview.Room;
    canControl: boolean;
    busy: { id: string; action: kinds.DeviceAction } | null;
    onOpen: (device: DeviceView) => void;
    onAct: (device: DeviceView) => (action: kinds.DeviceAction, command?: kinds.DeviceCommand) => void;
}) {
    const t = usePlacesT();
    const title = room.name || t("placeOverview.rooms.unplaced");
    return (
        <OverviewCard
            title={title}
            icon={room.name ? Sofa : Package}
            hint={
                <span className="shrink-0 text-xs text-muted-foreground">
                    {room.on > 0
                        ? t("placeOverview.rooms.on", { count: room.on })
                        : t("placeOverview.rooms.count", { count: room.devices.length })}
                </span>
            }
        >
            <ul className="flex flex-col divide-y divide-border">
                {room.devices.map((device) => (
                    <li key={device.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
                        <button
                            type="button"
                            onClick={() => onOpen(device)}
                            className="flex min-w-[8rem] flex-1 items-center gap-2.5 text-left"
                        >
                            <DeviceIcon kind={device.kind} className="size-4 shrink-0 text-muted-foreground" />
                            <span className="flex min-w-0 flex-col items-start gap-0.5">
                                <span className="max-w-full truncate text-sm font-medium" title={device.name}>
                                    {device.name}
                                </span>
                                <Badge className={cn("max-w-full truncate", stateClass(device))}>
                                    {kinds.badgeText(device, t)}
                                </Badge>
                            </span>
                        </button>
                        <DeviceControls
                            device={device}
                            canControl={canControl}
                            busy={busy?.id === device.id ? busy.action : null}
                            onAct={onAct(device)}
                            className="min-w-0 max-w-full"
                        />
                    </li>
                ))}
            </ul>
        </OverviewCard>
    );
}

function RoomSkeleton() {
    return (
        <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
                <Skeleton className="h-4 w-28" />
            </div>
            {[0, 1, 2].map((index) => (
                <div key={index} className="flex items-center gap-3 px-4 py-3">
                    <Skeleton className="size-4 shrink-0" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Skeleton className="h-3.5 w-2/5" />
                        <Skeleton className="h-3 w-1/4" />
                    </div>
                    <Skeleton className="h-6 w-10" />
                </div>
            ))}
        </div>
    );
}

/** The cameras, as one card: a picture of each, opened big with a press. */
function CamerasCard({
    cameras,
    canManage,
    tick,
    onWatch
}: {
    cameras: readonly CameraView[] | null;
    canManage: boolean;
    tick: number;
    onWatch: (camera: CameraView) => void;
}) {
    const t = usePlacesT();
    const shown = cameras?.slice(0, CAMERA_TILES) ?? [];
    const more = (cameras?.length ?? 0) - shown.length;
    return (
        <OverviewCard
            title={t("placeOverview.cameras.title")}
            icon={Cctv}
            href={cameras && cameras.length > 0 ? "/places/live" : undefined}
        >
            {cameras === null ? (
                <div className="grid grid-cols-2 gap-2 p-3" aria-busy="true">
                    <Skeleton className="aspect-video w-full" />
                    <Skeleton className="aspect-video w-full" />
                </div>
            ) : cameras.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                    <p className="text-xs text-muted-foreground">{t("placeOverview.cameras.empty")}</p>
                    {canManage ? (
                        <Button asChild size="sm" variant="outline">
                            <Link href="/places/cameras">{t("placeOverview.cameras.add")}</Link>
                        </Button>
                    ) : null}
                </div>
            ) : (
                <div className="flex flex-col gap-2 p-3">
                    <div className="grid grid-cols-2 gap-2">
                        {shown.map((camera) => (
                            <CameraThumb key={camera.id} camera={camera} tick={tick} onWatch={onWatch} />
                        ))}
                    </div>
                    {more > 0 ? (
                        <Link href="/places/live" className="self-start text-xs text-muted-foreground hover:text-foreground">
                            {t("placeOverview.cameras.more", { count: more })}
                        </Link>
                    ) : null}
                </div>
            )}
        </OverviewCard>
    );
}

/**
 * One camera's picture.
 *
 * A camera on a wire is asked for one small frame, through the same cached still
 * the wall uses. A camera on a battery is never asked: a picture would wake it,
 * and an Overview opened ten times a day would drain it.
 */
function CameraThumb({
    camera,
    tick,
    onWatch
}: {
    camera: CameraView;
    tick: number;
    onWatch: (camera: CameraView) => void;
}) {
    const t = usePlacesT();
    const [failed, setFailed] = useState(false);
    const battery = drawsFromBattery(camera.power);
    const picture = camera.enabled && !battery && !failed;
    return (
        <button
            type="button"
            onClick={() => onWatch(camera)}
            className="group relative aspect-video w-full min-w-0 overflow-hidden rounded-md border border-border bg-muted text-left"
            aria-label={t("placeOverview.cameras.watch", { name: camera.name })}
            title={camera.name}
        >
            {picture ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={`/api/home/cameras/${encodeURIComponent(camera.id)}/snapshot?w=480&n=${tick}`}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover"
                    onError={() => setFailed(true)}
                />
            ) : (
                <span className="flex size-full items-center justify-center px-2 text-center text-[0.6875rem] text-muted-foreground">
                    {battery ? t("camera.batteryOpenToWatch") : t("placeOverview.cameras.noPicture")}
                </span>
            )}
            <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1 text-[0.6875rem] font-medium text-white">
                {camera.name}
            </span>
        </button>
    );
}

/** The automations of this place, the latest to have run first, each a press
 *  from running. */
function RoutinesCard({
    automations,
    canManage,
    onRan
}: {
    automations: readonly actions.OverviewAutomation[] | null;
    canManage: boolean;
    onRan: (id: string, status: actions.OverviewAutomation["lastStatus"]) => void;
}) {
    const t = usePlacesT();
    const [running, setRunning] = useState<string | null>(null);
    const [ran, setRan] = useState<string | null>(null);
    const [error, setError] = useState("");
    const shown = useMemo(
        () =>
            [...(automations ?? [])]
                .sort(
                    (left, right) =>
                        Number(right.enabled) - Number(left.enabled) ||
                        (right.lastRunAt ?? "").localeCompare(left.lastRunAt ?? "") ||
                        left.name.localeCompare(right.name)
                )
                .slice(0, ROUTINES),
        [automations]
    );

    const run = async (automation: actions.OverviewAutomation) => {
        setError("");
        setRan(null);
        setRunning(automation.id);
        const result = await runAction(() => automationActions.runAutomationAction(automation.id), setError);
        setRunning(null);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setRan(automation.id);
        onRan(automation.id, "queued");
        dropAutomationsCache();
    };

    return (
        <OverviewCard title={t("placeOverview.routines.title")} icon={Workflow} href="/places/devices/automations">
            {automations === null ? (
                <div className="flex flex-col gap-3 p-4" aria-busy="true">
                    <Skeleton className="h-4 w-3/5" />
                    <Skeleton className="h-4 w-2/5" />
                </div>
            ) : shown.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                    <p className="text-xs text-muted-foreground">{t("placeOverview.routines.empty")}</p>
                    {canManage ? (
                        <Button asChild size="sm" variant="outline">
                            <Link href="/places/devices/automations/new">{t("placeOverview.routines.create")}</Link>
                        </Button>
                    ) : null}
                </div>
            ) : (
                <>
                    {error ? (
                        <p role="alert" className="mx-4 mt-3 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger-ink">
                            {error}
                        </p>
                    ) : null}
                    <ul className="flex flex-col divide-y divide-border">
                        {shown.map((automation) => (
                            <li key={automation.id} className="flex min-w-0 items-center gap-2 px-4 py-2">
                                <Link
                                    href={`/places/devices/automations/${automation.id}`}
                                    className="flex min-w-0 flex-1 flex-col"
                                >
                                    <span
                                        className={cn("truncate text-sm", !automation.enabled && "text-muted-foreground")}
                                        title={automation.name}
                                    >
                                        {automation.name}
                                    </span>
                                    <span className="truncate text-[0.6875rem] text-foreground-subtle">
                                        {ran === automation.id ? (
                                            <span role="status">{t("placeOverview.routines.started")}</span>
                                        ) : !automation.enabled ? (
                                            t("placeOverview.routines.off")
                                        ) : automation.lastStatus && automation.lastRunAt ? (
                                            <>
                                                {words.runStatusText(automation.lastStatus, t)}
                                                {" - "}
                                                <RelativeTime iso={automation.lastRunAt} />
                                            </>
                                        ) : (
                                            t("automations.list.neverRan")
                                        )}
                                    </span>
                                </Link>
                                {automation.lastStatus ? (
                                    <span
                                        className={cn(
                                            "size-2 shrink-0 rounded-full border",
                                            toneClass(words.RUN_TONES[automation.lastStatus])
                                        )}
                                        aria-hidden="true"
                                    />
                                ) : null}
                                {canManage ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="size-8 shrink-0 p-0"
                                        disabled={running === automation.id || !automation.enabled}
                                        aria-label={t("automations.list.runName", { name: automation.name })}
                                        title={automation.enabled ? t("automations.list.run") : t("automations.list.runOff")}
                                        onClick={() => void run(automation)}
                                    >
                                        {running === automation.id ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : (
                                            <Play className="size-4" />
                                        )}
                                    </Button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </OverviewCard>
    );
}

/** What the cameras noticed last, each a link to that moment. */
function EventsCard({ events }: { events: readonly actions.OverviewEvent[] | null }) {
    const t = usePlacesT();
    return (
        <OverviewCard title={t("placeOverview.events.title")} icon={Bell} href="/places/events">
            {events === null ? (
                <div className="flex flex-col gap-3 p-4" aria-busy="true">
                    <Skeleton className="h-4 w-3/5" />
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-4 w-1/2" />
                </div>
            ) : events.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t("placeOverview.events.empty")}</p>
            ) : (
                <ul className="flex flex-col">
                    {events.map((event) => {
                        const what = event.person ?? kindLabel(event.kind, t);
                        return (
                            <li key={event.id}>
                                <Link
                                    href={`/places/events?event=${encodeURIComponent(event.id)}`}
                                    className="flex min-w-0 items-center gap-2.5 px-4 py-2 transition-colors hover:bg-muted"
                                >
                                    <span
                                        className={cn(
                                            "size-2 shrink-0 rounded-full",
                                            event.acked ? "bg-transparent" : "bg-accent"
                                        )}
                                        title={event.acked ? undefined : t("placeOverview.events.new")}
                                        aria-label={event.acked ? undefined : t("placeOverview.events.new")}
                                    />
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate text-sm" title={what}>
                                            {what}
                                        </span>
                                        <span className="truncate text-[0.6875rem] text-foreground-subtle">
                                            {event.cameraName}
                                        </span>
                                    </span>
                                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                                        <RelativeTime iso={event.at} />
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </OverviewCard>
    );
}
