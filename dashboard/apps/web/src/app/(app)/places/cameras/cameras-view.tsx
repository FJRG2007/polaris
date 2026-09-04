"use client";

/**
 * Every camera the house has, as a table you can act on.
 *
 * Each row says the four things somebody comes here to check: where it is, what
 * it notices, what it keeps, and whether it is on. The row actions are icons
 * rather than a menu of words, because there are three of them and they repeat
 * down the table.
 */

import * as actions from "../actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { BrandMark } from "./model-picker";
import { CameraDialog } from "./camera-dialog";
import { ZonesDialog } from "./zones-dialog";
import { cameraVendor, usesAccountPassword } from "@/lib/home/vendors";
import { brandOfCamera } from "@/lib/home/camera-models";
import { filterCameras, zonesOf } from "@/lib/home/camera-filter";
import { DiscoverDialog } from "./discover-dialog";
import type { CameraView } from "@/lib/home/cameras";
import type { DiscoveredCamera } from "@/lib/home/discovery";
import { Cctv, Pencil, Plus, Radar, Search, Shapes, Trash2 } from "lucide-react";
import { DETECTOR_META, type Detector } from "@/lib/home/detection";
import { focusAfterMove } from "@/lib/list-selection";
import { quietSince } from "@/lib/home/availability";
import { useDisplayFormat } from "@/components/display-format";
import {
    cn,
    Badge,
    Input,
    Button,
    Select,
    Skeleton,
    EmptyState,
    ContextMenu,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuContent,
    ContextMenuTrigger,
    ContextMenuSeparator,
    ConfirmDeleteDialog
} from "@polaris/ui";

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
    const quiet = quietFor(camera);
    return (
        <p className="truncate text-[0.6875rem] text-foreground-subtle">
            {quiet
                ? `Not answering since ${format.dateTime(quiet.toISOString())}`
                : [camera.zone, cameraVendor(camera.vendor).label, camera.address]
                      .filter(Boolean)
                      .join(" - ")}
        </p>
    );
}

const RECORDING_LABEL: Record<string, string> = {
    off: "Nothing kept",
    motion: "Kept on movement",
    continuous: "Kept always"
};

/**
 * What the area picker calls "all of them".
 *
 * Not an empty string: that is what a camera with no area of its own carries, so
 * the two would be the same option and choosing "every area" would silently mean
 * "only the ones nobody filed".
 */
const ALL_AREAS = "*";

export function CamerasView({ canManage, openId }: { canManage: boolean; openId: string | null }) {
    const [cameras, setCameras] = useState<CameraView[] | null>(null);
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
    /** The camera whose areas are being drawn. */
    const [drawing, setDrawing] = useState<CameraView | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The row the keyboard is on. One at a time: there is no action here that
    // takes several cameras, so a multi-selection would only be decoration.
    const [focused, setFocused] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [list, machines, disks, tuning] = await Promise.all([
                actions.listCamerasAction(),
                actions.listServersAction(),
                actions.listStorageOptionsAction(),
                actions.detectionDefaultsAction()
            ]);
            if (cancelled) return;
            if (list.error) setError(list.error);
            setCameras(list.cameras ?? []);
            setServers(machines.servers ?? []);
            setStorage(disks.options ?? []);
            setDefaults(tuning.defaults ?? null);
            // A link from the wall names the camera to open, so pressing a name
            // there lands on its settings rather than on a list to find it in.
            if (openId) {
                const wanted = list.cameras?.find((camera) => camera.id === openId);
                if (wanted) setEditing(wanted);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [openId]);

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
        if ((event.key === "F2" || event.key === "Enter") && current && canManage) {
            event.preventDefault();
            setEditing(current);
        } else if (event.key === "Delete" && current && canManage) {
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

    if (cameras === null) return <ListSkeleton />;

    /** The areas in use, for the picker. Built from the whole list rather than
     *  from what is shown, or choosing one area would empty the picker of every
     *  other and there would be no way back. */
    const areas = zonesOf(cameras);
    const shown = filterCameras(cameras, { query, zone });
    /** Worth offering at all only once there is more than one answer to give. */
    const narrowing = cameras.length > 4 || areas.length > 1;

    return (
        <div className="flex flex-col gap-4">
            {canManage ? (
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setAdding({ address: "", vendor: null })}>
                        <Plus className="size-4 shrink-0" />
                        Add a camera
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setDiscovering(true)}>
                        <Radar className="size-4 shrink-0" />
                        Look for cameras
                    </Button>
                </div>
            ) : null}

            {error ? <p className="text-[0.75rem] text-danger">{error}</p> : null}

            {/* A house of four cameras needs none of this and a house of thirty
                needs all of it, so it appears when there is something to narrow. */}
            {cameras.length > 0 && narrowing ? (
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-0 flex-1 sm:max-w-xs">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 shrink-0 text-foreground-subtle" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search cameras"
                            aria-label="Search cameras"
                            className="pl-8"
                        />
                    </div>
                    {areas.length > 1 ? (
                        <Select
                            value={zone ?? ALL_AREAS}
                            onValueChange={(value) => setZone(value === ALL_AREAS ? null : value)}
                            aria-label="Area"
                            className="w-48"
                            options={[
                                { value: ALL_AREAS, label: `Every area - ${cameras.length}` },
                                ...areas.map((area) => ({
                                    value: area.zone,
                                    label: `${area.zone || "No area"} - ${area.count}`
                                }))
                            ]}
                        />
                    ) : null}
                </div>
            ) : null}

            {cameras.length === 0 ? (
                <EmptyState
                    icon={<Cctv />}
                    title="No cameras yet"
                    description={
                        canManage
                            ? "Add one by address, or let Polaris look for the ones already on your network."
                            : "Nobody has added a camera to this house yet."
                    }
                />
            ) : shown.length === 0 ? (
                <EmptyState
                    icon={<Search />}
                    title="No camera matches that"
                    description="Nothing here is called that, or is at that address, in the area you are looking at."
                />
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-[0.8125rem]">
                        <thead>
                            <tr>
                                <th className="w-full max-w-0 px-3 py-2 text-left">Camera</th>
                                <th className="whitespace-nowrap px-3 py-2 text-left">Notices</th>
                                <th className="whitespace-nowrap px-3 py-2 text-left">Keeps</th>
                                {canManage ? <th className="px-3 py-2" /> : null}
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
                                                    {!camera.enabled ? (
                                                        <Badge variant="neutral">Off</Badge>
                                                    ) : quietFor(camera) ? (
                                                        <Badge variant="danger">Quiet</Badge>
                                                    ) : null}
                                                </div>
                                                <Subtitle camera={camera} />
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                                {DETECTOR_META[camera.detector as Detector]
                                                    ?.label ?? camera.detector}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                                {RECORDING_LABEL[camera.recording] ??
                                                    camera.recording}
                                                {camera.recording !== "off" ? (
                                                    <span className="text-foreground-subtle">
                                                        {" "}
                                                        - {camera.retentionDays}d
                                                    </span>
                                                ) : null}
                                            </td>
                                            {canManage ? (
                                                <td className="whitespace-nowrap px-3 py-2 text-right">
                                                    <div className="flex justify-end gap-1">
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={`Change ${camera.name}`}
                                                            title="Change"
                                                            onClick={() => setEditing(camera)}
                                                        >
                                                            <Pencil className="size-4 shrink-0" />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={`Draw areas on ${camera.name}`}
                                                            title="Areas"
                                                            onClick={() => setDrawing(camera)}
                                                        >
                                                            <Shapes className="size-4 shrink-0" />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={`Remove ${camera.name}`}
                                                            title="Remove"
                                                            onClick={() => setRemoving(camera)}
                                                        >
                                                            <Trash2 className="size-4 shrink-0" />
                                                        </Button>
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
                                                    Rename and change
                                                </ContextMenuItem>
                                                <ContextMenuItem
                                                    onSelect={() => setDrawing(camera)}
                                                >
                                                    <Shapes className="size-4 shrink-0" />
                                                    Draw areas
                                                </ContextMenuItem>
                                                <ContextMenuSeparator />
                                                <ContextMenuItem
                                                    variant="danger"
                                                    onSelect={() => setRemoving(camera)}
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                    Remove
                                                </ContextMenuItem>
                                            </>
                                        ) : (
                                            <ContextMenuItem disabled>
                                                Nothing to change here
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

            {editing || adding ? (
                <CameraDialog
                    camera={editing}
                    prefill={adding}
                    // Whether this house already holds a TP-Link account
                    // password, so the second camera onwards can be added
                    // without typing it again.
                    sharedPassword={(cameras ?? []).some(
                        (row) => row.hasPassword && usesAccountPassword(row.vendor)
                    )}
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

            {discovering ? (
                <DiscoverDialog
                    known={new Set(cameras.map((camera) => camera.address))}
                    servers={servers.filter((server) => server.id !== "local")}
                    onClose={() => setDiscovering(false)}
                    onPick={(found: DiscoveredCamera) => {
                        setDiscovering(false);
                        setAdding({ address: found.address, vendor: found.vendor });
                    }}
                />
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind="camera"
                    title={`Remove ${removing.name}?`}
                    description="Polaris stops connecting to it, and everything it recorded is dropped. The camera itself keeps working."
                    confirmLabel="Remove"
                    onConfirm={() => remove(removing)}
                />
            ) : null}
        </div>
    );
}

function ListSkeleton() {
    return (
        <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-40 w-full" />
        </div>
    );
}
