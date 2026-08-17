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
import { CameraDialog } from "./camera-dialog";
import { cameraVendor } from "@/lib/home/vendors";
import { DiscoverDialog } from "./discover-dialog";
import type { CameraView } from "@/lib/home/cameras";
import type { DiscoveredCamera } from "@/lib/home/discovery";
import { Cctv, Pencil, Plus, Radar, Trash2 } from "lucide-react";
import { DETECTOR_META, type Detector } from "@/lib/home/detection";
import { focusAfterMove } from "@/lib/list-selection";
import {
    cn,
    Badge,
    Button,
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

const RECORDING_LABEL: Record<string, string> = {
    off: "Nothing kept",
    motion: "Kept on movement",
    continuous: "Kept always"
};

export function CamerasView({ canManage, openId }: { canManage: boolean; openId: string | null }) {
    const [cameras, setCameras] = useState<CameraView[] | null>(null);
    const [servers, setServers] = useState<{ id: string; label: string }[]>([]);
    const [storage, setStorage] = useState<{ id: string; label: string }[]>([]);
    const [defaults, setDefaults] = useState<{
        sensitivity: number;
        settleSeconds: number;
        minGapSeconds: number;
    } | null>(null);
    const [editing, setEditing] = useState<CameraView | null>(null);
    const [adding, setAdding] = useState<{ address: string; vendor: string | null } | null>(null);
    const [discovering, setDiscovering] = useState(false);
    const [removing, setRemoving] = useState<CameraView | null>(null);
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
        const list = cameras ?? [];
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

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}

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
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-[13px]">
                        <thead>
                            <tr>
                                <th className="w-full max-w-0 px-3 py-2 text-left">Camera</th>
                                <th className="whitespace-nowrap px-3 py-2 text-left">Notices</th>
                                <th className="whitespace-nowrap px-3 py-2 text-left">Keeps</th>
                                {canManage ? <th className="px-3 py-2" /> : null}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border" tabIndex={0} onKeyDown={onKeyDown}>
                            {cameras.map((camera) => (
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
                                                    <span className="truncate text-foreground" title={camera.name}>{camera.name}</span>
                                                    {!camera.enabled ? <Badge variant="neutral">Off</Badge> : null}
                                                </div>
                                                <p className="truncate text-[11px] text-foreground-subtle">
                                                    {[camera.zone, cameraVendor(camera.vendor).label, camera.address]
                                                        .filter(Boolean)
                                                        .join(" - ")}
                                                </p>
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                                {DETECTOR_META[camera.detector as Detector]?.label ?? camera.detector}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                                {RECORDING_LABEL[camera.recording] ?? camera.recording}
                                                {camera.recording !== "off" ? (
                                                    <span className="text-foreground-subtle"> - {camera.retentionDays}d</span>
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
                                                <ContextMenuItem onSelect={() => setEditing(camera)}>
                                                    <Pencil className="size-4 shrink-0" />
                                                    Rename and change
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
                                            <ContextMenuItem disabled>Nothing to change here</ContextMenuItem>
                                        )}
                                    </ContextMenuContent>
                                </ContextMenu>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {editing || adding ? (
                <CameraDialog
                    camera={editing}
                    prefill={adding}
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
