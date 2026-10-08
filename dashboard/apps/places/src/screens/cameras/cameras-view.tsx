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
import { Cctv, Pencil, Plus, Radar, Search, Shapes, Share2, Trash2 } from "lucide-react";
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
    ContextMenu,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuContent,
    ContextMenuTrigger,
    ContextMenuSeparator,
    ConfirmDeleteDialog,
    shortcutPressed
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

export function CamerasView({ canManage, openId }: { canManage: boolean; openId: string | null }) {
    const t = usePlacesT();
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
    useEffect(() => {
        let cancelled = false;
        void actions.listCamerasAction().then(
            (list) => {
                if (cancelled) return;
                if (list.error) setError(list.error);
                setCameras(list.cameras ?? []);
                // A link from the wall names the camera to open, so pressing a name
                // there lands on its settings rather than on a list to find it in.
                if (openId) {
                    const wanted = list.cameras?.find((camera) => camera.id === openId);
                    if (wanted) setEditing(wanted);
                }
            },
            () => {
                if (!cancelled) setError(t("cameras.readFailed"));
            }
        );
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
    }, [openId]);

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
            {canManage ? (
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setAdding({ address: "", vendor: null })}>
                        <Plus className="size-4 shrink-0" />
                        {t("cameras.add")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setDiscovering(true)}>
                        <Radar className="size-4 shrink-0" />
                        {t("cameras.discover")}
                    </Button>
                </div>
            ) : null}

            {error ? <p className="text-[0.75rem] text-danger">{error}</p> : null}

            {/* A house of four cameras needs none of this and a house of thirty
                needs all of it, so it appears when there is something to narrow. */}
            {loaded.length > 0 && narrowing ? (
                <div className="flex flex-wrap items-center gap-2">
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
                            onValueChange={(value) => setZone(value === ALL_AREAS ? null : value)}
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
                </div>
            ) : null}

            {cameras === null ? (
                <ListSkeleton />
            ) : cameras.length === 0 ? (
                <EmptyState
                    icon={<Cctv />}
                    title={t("cameras.empty.title")}
                    description={canManage ? t("cameras.empty.manage") : t("cameras.empty.view")}
                />
            ) : shown.length === 0 ? (
                <EmptyState
                    icon={<Search />}
                    title={t("cameras.noMatch.title")}
                    description={t("cameras.noMatch.description")}
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
                                            {canManage ? (
                                                <td className="whitespace-nowrap px-3 py-2 text-right">
                                                    <div className="flex justify-end gap-1">
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={t("cameras.changeName", {
                                                                name: camera.name
                                                            })}
                                                            title={t("cameras.change")}
                                                            onClick={() => setEditing(camera)}
                                                        >
                                                            <Pencil className="size-4 shrink-0" />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={t("cameras.drawAreasOn", {
                                                                name: camera.name
                                                            })}
                                                            title={t("cameras.areas")}
                                                            onClick={() => setDrawing(camera)}
                                                        >
                                                            <Shapes className="size-4 shrink-0" />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={t("cameras.shareName", {
                                                                name: camera.name
                                                            })}
                                                            title={t("cameras.share")}
                                                            onClick={() => setSharing(camera)}
                                                        >
                                                            <Share2 className="size-4 shrink-0" />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={t("cameras.removeName", {
                                                                name: camera.name
                                                            })}
                                                            title={t("cameras.remove")}
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
                                                    {t("cameras.renameAndChange")}
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

function ListSkeleton() {
    return <Skeleton className="h-40 w-full" />;
}
