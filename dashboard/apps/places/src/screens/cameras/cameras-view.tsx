"use client";

/**
 * Every camera the house has: live on the wall, or as a compact table, and
 * managed from either.
 *
 * The wall is what somebody opens twenty times a day, so it is what the page
 * shows first; each tile carries what managing that camera offers, so there is
 * no second screen to go to when something is wrong. The table is there for a
 * house with thirty cameras, and each row says the four things somebody comes to
 * check: where it is, what it notices, what it keeps, and whether it is on.
 *
 * Which of the two is shown is the reader's own choice and remembered in this
 * browser - a convenience, so it is never more than that.
 */

import * as actions from "../actions";
import { useEffect, useState, type ReactNode } from "react";
import { CameraGroups, Wall, WallSkeleton } from "../wall";
import { CameraMenu, type CameraManagement } from "./camera-menu";
import { useCameraPrivacy } from "../use-camera-privacy";
import { BrandMark } from "./model-picker";
import { CameraDialog } from "./camera-dialog";
import { ZonesDialog } from "./zones-dialog";
import { usePlacesT } from "../use-places-t";
import type { PlacesKey } from "../../../messages";
import { usesAccountPassword, vendorLabel } from "../../lib/vendors";
import { brandOfCamera } from "../../lib/camera-models";
import { filterCameras, zonesOf } from "../../lib/camera-filter";
import { DiscoverDialog } from "./discover-dialog";
import type { CameraView } from "../../lib/cameras";
import type { DiscoveredCamera } from "../../lib/discovery";
import {
    Cctv,
    Eye,
    EyeOff,
    LayoutGrid,
    List,
    Pencil,
    Plus,
    Radar,
    Search,
    Shapes,
    Share2,
    Trash2
} from "lucide-react";
import { focusAfterMove } from "../../lib/list-selection";
import { quietSince } from "../../lib/availability";
import {
    cn,
    Badge,
    Input,
    Button,
    Select,
    Skeleton,
    EmptyState,
    SegmentedControl,
    ContextMenu,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuContent,
    ContextMenuTrigger,
    ContextMenuSeparator,
    ConfirmDeleteDialog,
    shortcutPressed,
    ShortcutHint
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";

const { runAction } = hostUi.runAction;
const { ShareDialog } = hostUi.accessShareDialog;
const { useDisplayFormat } = hostUi.displayFormat;

/** How long a camera has been quiet, for a row that has to say so. A camera that
 *  is switched off is not quiet, it is off, and the row says that instead. */
function quietFor(camera: CameraView): Date | null {
    return camera.enabled ? quietSince(camera.offlineSince) : null;
}

/** The line under a camera's name. A camera that has stopped answering says so
 *  where it is managed, not only on the wall: this is the screen somebody opens
 *  to do something about it, and where it is plugged in matters less than the
 *  fact that it is not there. */
function Subtitle({ camera }: { camera: CameraView }) {
    const format = useDisplayFormat();
    const t = usePlacesT();
    const quiet = quietFor(camera);
    return (
        <p className="truncate text-[0.6875rem] text-foreground-subtle">
            {quiet
                ? t("cameras.subtitleQuiet", { since: format.dateTime(quiet.toISOString()) })
                : [camera.zone, vendorLabel(camera.vendor, t), camera.address]
                      .filter(Boolean)
                      .join(" - ")}
        </p>
    );
}

/**
 * What the area picker calls "all of them".
 *
 * Not an empty string: that is what a camera with no area of its own carries, so
 * the two would be the same option and choosing "every area" would silently mean
 * "only the ones nobody filed".
 */
const ALL_AREAS = "*";

/**
 * How long to wait before asking the relay again about a camera it is not
 * serving yet, by how many times it has been asked since.
 *
 * Quick at first: a camera that just came back from privacy, or was switched
 * back on, is published again within a second or two, and a single ask the
 * moment the switch answered lands before the relay has picked it up - the tile
 * then said "Starting" until the page was reloaded. Slower after that, so a
 * camera that is really down costs the relay one question every half a minute.
 */
const LIVE_RECHECK_MS = [2_000, 2_000, 3_000, 5_000, 10_000, 30_000];

/** Where this browser remembers whether the wall or the list was last chosen. */
export const CAMERAS_VIEW_KEY = "polaris.places.cameras.view";

type CamerasLayout = "wall" | "list";

function rememberedLayout(): CamerasLayout {
    try {
        return window.localStorage.getItem(CAMERAS_VIEW_KEY) === "list" ? "list" : "wall";
    } catch {
        return "wall";
    }
}

export function CamerasView({
    canManage,
    canControl,
    openId,
    header,
    switcher
}: {
    canManage: boolean;
    canControl: boolean;
    openId: string | null;
    /** The page's title, drawn by the page. */
    header: ReactNode;
    /** The place picker, drawn by the page. */
    switcher?: ReactNode;
}) {
    const t = usePlacesT();
    const [cameras, setCameras] = useState<CameraView[] | null>(null);
    /** Which cameras the relay is serving, which only the wall reads. */
    const [live, setLive] = useState<ReadonlySet<string>>(() => new Set());
    const [layout, setLayout] = useState<CamerasLayout>("wall");
    /** How many times the relay has been asked again since the last change. */
    const [recheck, setRecheck] = useState(0);
    /** Whether a camera is open in the viewer, which asks for its own stream. */
    const [watchingOne, setWatchingOne] = useState(false);
    const [servers, setServers] = useState<{ id: string; label: string }[]>([]);
    const [storage, setStorage] = useState<{ id: string; label: string }[]>([]);
    const [defaults, setDefaults] = useState<{
        sensitivity: number;
        settleSeconds: number;
        minGapSeconds: number;
    } | null>(null);
    /** What is being looked for. Held here rather than in a URL: it is a way of
     *  reading this list rather than a place anybody links to. */
    const [query, setQuery] = useState("");
    /** Which area is being shown, or null for all of them. */
    const [zone, setZone] = useState<string | null>(null);
    const [editing, setEditing] = useState<CameraView | null>(null);
    const [adding, setAdding] = useState<{ address: string; vendor: string | null } | null>(null);
    const [discovering, setDiscovering] = useState(false);
    const [removing, setRemoving] = useState<CameraView | null>(null);
    /** Which camera is being lent to somebody. */
    const [sharing, setSharing] = useState<CameraView | null>(null);
    /** The camera whose areas are being drawn. */
    const [drawing, setDrawing] = useState<CameraView | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The row the keyboard is on. One at a time: there is no action here that
    // takes several cameras, so a multi-selection would only be decoration.
    const [focused, setFocused] = useState<string | null>(null);

    /** Whether what only the dialogs read - the machines, the disks, the
     *  detection defaults - has arrived. */
    const [extras, setExtras] = useState(false);

    // The list and what the dialogs need, read side by side rather than as one
    // batch: the list used to wait for the slowest of four reads, three of which
    // nothing on the page shows until a dialog opens.
    // Read once mounted rather than while rendering: the server has no browser
    // to ask, and the two must draw the same first frame.
    useEffect(() => setLayout(rememberedLayout()), []);

    const chooseLayout = (next: CamerasLayout) => {
        setLayout(next);
        try {
            window.localStorage.setItem(CAMERAS_VIEW_KEY, next);
        } catch {
            // A browser that keeps nothing still switches; it just forgets.
        }
    };

    /** A camera on its way back to the relay: ask again from the quick end
     *  until it is served. */
    const refreshLive = () => setRecheck(0);

    // A camera that should be on the relay and is not is asked about again
    // until it is, rather than left on "Starting" until a reload. Only for the
    // wall, which is what draws it, and stopped while one camera is open.
    const waiting = (cameras ?? []).some(
        (camera) => camera.enabled && !camera.privacy && !live.has(camera.id)
    );
    useEffect(() => {
        if (!waiting || watchingOne || layout !== "wall") return;
        let current = true;
        const next = () => {
            if (current) setRecheck((value) => value + 1);
        };
        // A route rather than an action: an update renames every action under a
        // tab left open, and this one is asked for as long as the tab is.
        const controller = new AbortController();
        const timer = setTimeout(
            () =>
                void fetch("/api/home/cameras/live", {
                    signal: controller.signal,
                    cache: "no-store"
                })
                    .then((response): Promise<{ live?: string[] }> =>
                        response.ok ? response.json() : Promise.resolve({})
                    )
                    .then((status) => {
                        if (current && status.live) setLive(new Set(status.live));
                        next();
                    }, next),
            LIVE_RECHECK_MS[Math.min(recheck, LIVE_RECHECK_MS.length - 1)]
        );
        return () => {
            current = false;
            controller.abort();
            clearTimeout(timer);
        };
    }, [waiting, watchingOne, layout, recheck]);

    useEffect(() => {
        let cancelled = false;
        void actions.listCamerasAction().then(
            (list) => {
                if (cancelled) return;
                if (list.error) setError(list.error);
                setCameras(list.cameras ?? []);
                // A link that names a camera lands on its settings rather than on
                // a list to find it in.
                if (openId && canManage) {
                    const wanted = list.cameras?.find((camera) => camera.id === openId);
                    if (wanted) setEditing(wanted);
                }
                // Only worth asking once there is something to ask about.
                if (list.cameras?.length) {
                    void actions.liveCamerasAction().then(
                        (status) => {
                            if (!cancelled && status.live) setLive(new Set(status.live));
                        },
                        () => undefined
                    );
                }
            },
            () => {
                if (!cancelled) setError(t("cameras.readFailed"));
            }
        );
        // The machines, disks and defaults only the dialogs read, asked only of
        // somebody who may open them.
        if (!canManage) {
            return () => {
                cancelled = true;
            };
        }
        void Promise.all([
            actions.listServersAction(),
            actions.listStorageOptionsAction(),
            actions.detectionDefaultsAction()
        ]).then(
            ([machines, disks, tuning]) => {
                if (cancelled) return;
                setServers(machines.servers ?? []);
                setStorage(disks.options ?? []);
                setDefaults(tuning.defaults ?? null);
                setExtras(true);
            },
            () => {
                if (cancelled) return;
                setError(t("cameras.extrasFailed"));
            }
        );
        return () => {
            cancelled = true;
        };
    }, [openId, canManage]);

    const privacy = useCameraPrivacy({
        cameras,
        setCameras,
        canManage,
        onPublicAgain: refreshLive
    });

    /** A dialog opens once what it is built from has arrived. Pressed before
     *  that, it appears the moment it has, rather than opening on an empty
     *  list of machines it would not correct once the list came in. */
    const ready = cameras !== null && extras;

    const saved = (camera: CameraView) => {
        setCameras((current) => {
            const rest = (current ?? []).filter((item) => item.id !== camera.id);
            return [...rest, camera].sort((left, right) => left.name.localeCompare(right.name));
        });
        setEditing(null);
        setAdding(null);
    };

    const remove = async (camera: CameraView) => {
        const result = await runAction(() => actions.deleteCameraAction(camera.id), setError);
        setRemoving(null);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setCameras((current) => (current ?? []).filter((item) => item.id !== camera.id));
    };

    /** On or off, or what it keeps: shown at once, put back if it did not take. */
    const switchCamera: CameraManagement["switchCamera"] = async (camera, change) => {
        setError(null);
        setCameras((current) =>
            (current ?? []).map((item) => (item.id === camera.id ? { ...item, ...change } : item))
        );
        const result = await runAction(
            () => actions.switchCameraAction(camera.id, change),
            setError
        );
        const settled = result?.camera;
        if (!settled) {
            setCameras((current) =>
                (current ?? []).map((item) =>
                    item.id === camera.id
                        ? { ...item, enabled: camera.enabled, recording: camera.recording }
                        : item
                )
            );
            setError(result?.error ?? t("cameras.switchFailed"));
            return;
        }
        setCameras((current) =>
            (current ?? []).map((item) => (item.id === camera.id ? settled : item))
        );
        // Back on: the relay is picking it up, and the wall should know when.
        if (change.enabled) refreshLive();
    };

    const manage: CameraManagement = {
        edit: setEditing,
        drawAreas: setDrawing,
        share: setSharing,
        remove: setRemoving,
        switchCamera
    };

    /**
     * The keys a list of things has on every desktop: F2 renames, Delete
     * removes, Enter opens, the arrows walk. Renaming a camera is the same
     * dialog as changing one - its name is the first field in it - so F2 and
     * Enter land in the same place rather than inventing a second way to type a
     * name that only exists here.
     */
    const onKeyDown = (event: React.KeyboardEvent) => {
        const list = shown;
        const index = list.findIndex((camera) => camera.id === focused);
        const current = list[index];
        if (
            (shortcutPressed(event, "general.rename") || event.key === "Enter") &&
            current &&
            canManage
        ) {
            event.preventDefault();
            setEditing(current);
        } else if (shortcutPressed(event, "general.delete") && current && canManage) {
            event.preventDefault();
            setRemoving(current);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const landed = focusAfterMove(
                list.map((item) => item.id),
                focused,
                event.key === "ArrowDown" ? 1 : -1
            );
            if (landed) setFocused(landed);
        }
    };

    // The buttons and the error are drawn at once; only the list waits.
    const loaded = cameras ?? [];
    /** The areas in use, for the picker. Built from the whole list rather than
     *  from what is shown, or choosing one area would empty the picker of every
     *  other and there would be no way back. */
    const areas = zonesOf(loaded);
    const shown = filterCameras(loaded, { query, zone });
    /** Worth offering at all only once there is more than one answer to give. */
    const narrowing = loaded.length > 4 || areas.length > 1;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">{header}</div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {switcher}
                    {canManage ? (
                        <>
                            <Button
                                size="sm"
                                className="min-w-0"
                                onClick={() => setAdding({ address: "", vendor: null })}
                            >
                                <Plus className="size-4 shrink-0" />
                                <span className="truncate">{t("cameras.add")}</span>
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                className="min-w-0"
                                onClick={() => setDiscovering(true)}
                            >
                                <Radar className="size-4 shrink-0" />
                                <span className="truncate">{t("cameras.discover")}</span>
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>

            {error ? (
                <p role="alert" className="text-[0.75rem] text-danger">
                    {error}
                </p>
            ) : null}

            {/* A house of four cameras needs none of the narrowing and a house
                of thirty needs all of it, so it appears when there is something
                to narrow. The wall or the list is always a choice. */}
            <div className="flex flex-wrap items-center gap-2">
                {loaded.length > 0 && narrowing ? (
                    <>
                        <div className="relative min-w-0 flex-1 sm:max-w-xs">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 shrink-0 text-foreground-subtle" />
                            <Input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t("cameras.search")}
                                aria-label={t("cameras.search")}
                                className="pl-8"
                            />
                        </div>
                        {areas.length > 1 ? (
                            <Select
                                value={zone ?? ALL_AREAS}
                                onValueChange={(value) =>
                                    setZone(value === ALL_AREAS ? null : value)
                                }
                                aria-label={t("cameras.area")}
                                className="w-48"
                                options={[
                                    {
                                        value: ALL_AREAS,
                                        label: t("cameras.everyArea", { count: loaded.length })
                                    },
                                    ...areas.map((area) => ({
                                        value: area.zone,
                                        label: t("cameras.areaCount", {
                                            area: area.zone || t("cameras.noArea"),
                                            count: area.count
                                        })
                                    }))
                                ]}
                            />
                        ) : null}
                    </>
                ) : null}
                <SegmentedControl
                    size="sm"
                    className="ml-auto"
                    aria-label={t("cameras.layout.label")}
                    value={layout}
                    onValueChange={chooseLayout}
                    options={[
                        {
                            value: "wall",
                            title: t("cameras.layout.wall"),
                            label: (
                                <span className="flex min-w-0 items-center gap-1.5">
                                    <LayoutGrid className="size-4 shrink-0" />
                                    <span className="truncate">{t("cameras.layout.wall")}</span>
                                </span>
                            )
                        },
                        {
                            value: "list",
                            title: t("cameras.layout.list"),
                            label: (
                                <span className="flex min-w-0 items-center gap-1.5">
                                    <List className="size-4 shrink-0" />
                                    <span className="truncate">{t("cameras.layout.list")}</span>
                                </span>
                            )
                        }
                    ]}
                />
            </div>

            {cameras && cameras.length > 0 ? (
                <CameraGroups
                    cameras={cameras}
                    canManage={canManage}
                    canControl={canControl}
                    privacy={privacy}
                />
            ) : null}

            {cameras === null ? (
                layout === "wall" ? (
                    <WallSkeleton />
                ) : (
                    <ListSkeleton />
                )
            ) : cameras.length === 0 ? (
                <EmptyState
                    icon={<Cctv />}
                    title={t("cameras.empty.title")}
                    description={canManage ? t("cameras.empty.manage") : t("cameras.empty.view")}
                    action={
                        canManage ? (
                            <Button
                                size="sm"
                                onClick={() => setAdding({ address: "", vendor: null })}
                            >
                                <Plus className="size-4 shrink-0" />
                                {t("cameras.add")}
                            </Button>
                        ) : undefined
                    }
                />
            ) : shown.length === 0 ? (
                <EmptyState
                    icon={<Search />}
                    title={t("cameras.noMatch.title")}
                    description={t("cameras.noMatch.description")}
                />
            ) : layout === "wall" ? (
                <Wall
                    cameras={cameras}
                    shown={shown}
                    live={live}
                    canControl={canControl}
                    privacy={privacy}
                    onWatching={setWatchingOne}
                    menuFor={
                        canManage
                            ? (camera) => <CameraMenu camera={camera} manage={manage} full />
                            : undefined
                    }
                    onPrivacyPreset={(cameraId, preset) =>
                        setCameras((current) =>
                            (current ?? []).map((camera) =>
                                camera.id === cameraId
                                    ? { ...camera, privacyPreset: preset }
                                    : camera
                            )
                        )
                    }
                />
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-[0.8125rem]">
                        <thead>
                            <tr>
                                <th className="w-full max-w-0 px-3 py-2 text-left">
                                    {t("cameras.columns.camera")}
                                </th>
                                <th className="whitespace-nowrap px-3 py-2 text-left">
                                    {t("cameras.columns.notices")}
                                </th>
                                <th className="whitespace-nowrap px-3 py-2 text-left">
                                    {t("cameras.columns.keeps")}
                                </th>
                                {canManage || canControl ? <th className="px-3 py-2" /> : null}
                            </tr>
                        </thead>
                        <tbody
                            className="divide-y divide-border"
                            tabIndex={0}
                            onKeyDown={onKeyDown}
                        >
                            {shown.map((camera) => (
                                <ContextMenu key={camera.id}>
                                    <ContextMenuTrigger asChild>
                                        <tr
                                            onClick={() => setFocused(camera.id)}
                                            onContextMenu={() => setFocused(camera.id)}
                                            onDoubleClick={() => canManage && setEditing(camera)}
                                            className={cn(focused === camera.id && "bg-primary/10")}
                                        >
                                            <td className="w-full max-w-0 px-3 py-2">
                                                <div className="flex items-center gap-2">
                                                    {brandOfCamera(camera) ? (
                                                        <BrandMark
                                                            brand={brandOfCamera(camera) as string}
                                                            className="text-muted-foreground"
                                                        />
                                                    ) : null}
                                                    <span
                                                        className="truncate text-foreground"
                                                        title={camera.name}
                                                    >
                                                        {camera.name}
                                                    </span>
                                                    {camera.privacy ? (
                                                        <Badge variant="neutral">
                                                            {t("privacy.on")}
                                                        </Badge>
                                                    ) : null}
                                                    {!camera.enabled ? (
                                                        <Badge variant="neutral">
                                                            {t("cameras.off")}
                                                        </Badge>
                                                    ) : quietFor(camera) ? (
                                                        <Badge variant="danger">
                                                            {t("camera.quiet")}
                                                        </Badge>
                                                    ) : null}
                                                </div>
                                                <Subtitle camera={camera} />
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                                {t.has(`detectors.${camera.detector}.label`)
                                                    ? t(
                                                          `detectors.${camera.detector}.label` as PlacesKey
                                                      )
                                                    : camera.detector}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                                {t.has(`cameras.keeps.${camera.recording}`)
                                                    ? t(
                                                          `cameras.keeps.${camera.recording}` as PlacesKey
                                                      )
                                                    : camera.recording}
                                                {camera.recording !== "off" ? (
                                                    <span className="text-foreground-subtle">
                                                        {t("cameras.retention", {
                                                            days: camera.retentionDays
                                                        })}
                                                    </span>
                                                ) : null}
                                            </td>
                                            {canManage || canControl ? (
                                                <td className="whitespace-nowrap px-3 py-2 text-right">
                                                    <div className="flex justify-end gap-1">
                                                        {canControl ? (
                                                            <PrivacyButton
                                                                camera={camera}
                                                                onSwitch={(wanted) =>
                                                                    void privacy.switchPrivacy(
                                                                        {
                                                                            kind: "camera",
                                                                            id: camera.id
                                                                        },
                                                                        [camera.id],
                                                                        wanted
                                                                    )
                                                                }
                                                            />
                                                        ) : null}
                                                        {canManage ? (
                                                            <>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    aria-label={t(
                                                                        "cameras.changeName",
                                                                        {
                                                                            name: camera.name
                                                                        }
                                                                    )}
                                                                    title={t("cameras.change")}
                                                                    onClick={() =>
                                                                        setEditing(camera)
                                                                    }
                                                                >
                                                                    <Pencil className="size-4 shrink-0" />
                                                                </Button>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    aria-label={t(
                                                                        "cameras.drawAreasOn",
                                                                        {
                                                                            name: camera.name
                                                                        }
                                                                    )}
                                                                    title={t("cameras.areas")}
                                                                    onClick={() =>
                                                                        setDrawing(camera)
                                                                    }
                                                                >
                                                                    <Shapes className="size-4 shrink-0" />
                                                                </Button>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    aria-label={t(
                                                                        "cameras.shareName",
                                                                        {
                                                                            name: camera.name
                                                                        }
                                                                    )}
                                                                    title={t("cameras.share")}
                                                                    onClick={() =>
                                                                        setSharing(camera)
                                                                    }
                                                                >
                                                                    <Share2 className="size-4 shrink-0" />
                                                                </Button>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    aria-label={t(
                                                                        "cameras.removeName",
                                                                        {
                                                                            name: camera.name
                                                                        }
                                                                    )}
                                                                    title={t("cameras.remove")}
                                                                    onClick={() =>
                                                                        setRemoving(camera)
                                                                    }
                                                                >
                                                                    <Trash2 className="size-4 shrink-0" />
                                                                </Button>
                                                                <CameraMenu
                                                                    camera={camera}
                                                                    manage={manage}
                                                                    full={false}
                                                                />
                                                            </>
                                                        ) : null}
                                                    </div>
                                                </td>
                                            ) : null}
                                        </tr>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent>
                                        <ContextMenuLabel>{camera.name}</ContextMenuLabel>
                                        {canManage ? (
                                            <>
                                                <ContextMenuItem
                                                    onSelect={() => setEditing(camera)}
                                                >
                                                    <Pencil className="size-4 shrink-0" />
                                                    {t("cameras.renameAndChange")}
                                                    <ShortcutHint id="general.rename" />
                                                </ContextMenuItem>
                                                <ContextMenuItem
                                                    onSelect={() => setDrawing(camera)}
                                                >
                                                    <Shapes className="size-4 shrink-0" />
                                                    {t("cameras.drawAreas")}
                                                </ContextMenuItem>
                                                <ContextMenuItem
                                                    onSelect={() => setSharing(camera)}
                                                >
                                                    <Share2 className="size-4 shrink-0" />
                                                    {t("cameras.share")}
                                                </ContextMenuItem>
                                                <ContextMenuSeparator />
                                                <ContextMenuItem
                                                    variant="danger"
                                                    onSelect={() => setRemoving(camera)}
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                    {t("cameras.remove")}
                                                    <ShortcutHint id="general.delete" />
                                                </ContextMenuItem>
                                            </>
                                        ) : (
                                            <ContextMenuItem disabled>
                                                {t("cameras.nothingToChange")}
                                            </ContextMenuItem>
                                        )}
                                    </ContextMenuContent>
                                </ContextMenu>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {drawing ? <ZonesDialog camera={drawing} onClose={() => setDrawing(null)} /> : null}

            {ready && (editing || adding) ? (
                <CameraDialog
                    camera={editing}
                    prefill={adding}
                    // Whether this house already holds a TP-Link account
                    // password, so the second camera onwards can be added
                    // without typing it again.
                    sharedPassword={(cameras ?? []).some(
                        (row) => row.hasPassword && usesAccountPassword(row.vendor)
                    )}
                    placeId={editing?.placeId || cameras?.[0]?.placeId || ""}
                    servers={servers}
                    storage={storage}
                    defaults={defaults}
                    onClose={() => {
                        setEditing(null);
                        setAdding(null);
                    }}
                    onSaved={saved}
                />
            ) : null}

            {ready && discovering ? (
                <DiscoverDialog
                    known={new Set(loaded.map((camera) => camera.address))}
                    servers={servers.filter((server) => server.id !== "local")}
                    onClose={() => setDiscovering(false)}
                    onPick={(found: DiscoveredCamera) => {
                        setDiscovering(false);
                        setAdding({ address: found.address, vendor: found.vendor });
                    }}
                />
            ) : null}

            {sharing ? (
                <ShareDialog
                    open
                    onOpenChange={(open) => !open && setSharing(null)}
                    subject="place.camera"
                    subjectId={sharing.id}
                    name={sharing.name}
                    // A camera lent to a neighbour for a fortnight, or to the
                    // security team for the hours they are on.
                    bounded
                />
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind="camera"
                    title={t("cameras.removeConfirm.title", { name: removing.name })}
                    description={t("cameras.removeConfirm.description")}
                    confirmLabel={t("cameras.remove")}
                    onConfirm={() => remove(removing)}
                />
            ) : null}
        </div>
    );
}

/** Privacy on or off for one row, the same switch a tile carries. */
function PrivacyButton({
    camera,
    onSwitch
}: {
    camera: CameraView;
    onSwitch: (wanted: boolean) => void;
}) {
    const t = usePlacesT();
    const words = camera.privacy ? t("privacy.turnOff") : t("privacy.turnOn");
    return (
        <Button
            variant="ghost"
            size="icon"
            aria-pressed={camera.privacy}
            aria-label={words}
            title={words}
            onClick={() => onSwitch(!camera.privacy)}
        >
            {camera.privacy ? (
                <Eye className="size-4 shrink-0" />
            ) : (
                <EyeOff className="size-4 shrink-0" />
            )}
        </Button>
    );
}

function ListSkeleton() {
    return <Skeleton className="h-40 w-full" />;
}
