"use client";

/**
 * The wall: every camera in this place, grouped by where it points.
 *
 * The shell is on screen before anything has been asked for, and the cameras
 * arrive after - so the page never waits on a relay or a camera that is asleep.
 * Which of them the relay is actually serving is a second, slower question, and
 * it lands on its own without holding the tiles back.
 *
 * What the detectors are following is asked for here rather than in each tile.
 * One ask covers the whole wall, so a house with twelve cameras costs what a
 * house with one does; the tiles are handed their own boxes and draw them.
 */

import Link from "next/link";
import * as actions from "./actions";
import { Cctv, Eye, EyeOff, Layers, Plus } from "lucide-react";
import { CameraSetsDialog } from "./cameras/camera-sets-dialog";
import { usePlaceRooms } from "./use-place-rooms";
import { CameraTile } from "./camera-tile";
import { CameraViewer } from "./camera-viewer";
import { useEffect, useMemo, useState } from "react";
import { useDetections } from "./use-detections";
import { usePlacesT } from "./use-places-t";
import type { CameraView } from "../lib/cameras";
import { Button, EmptyState, Skeleton } from "@polaris/ui";
import {
    applyPrivacy,
    groupState,
    nextPrivacy,
    rollbackPrivacy,
    settlePrivacy,
    targetKey,
    type CameraSetView,
    type PrivacyTarget
} from "../lib/privacy-kinds";

export function Wall({ canManage, canControl }: { canManage: boolean; canControl: boolean }) {
    const t = usePlacesT();
    const [cameras, setCameras] = useState<CameraView[] | null>(null);
    const [live, setLive] = useState<Set<string>>(() => new Set());
    const [error, setError] = useState<string | null>(null);
    const [opened, setOpened] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await actions.listCamerasAction();
            if (cancelled) return;
            if (result.error) setError(result.error);
            setCameras(result.cameras ?? []);
            // Only worth asking once there is something to ask about.
            if (!result.cameras?.length) return;
            const status = await actions.liveCamerasAction();
            if (!cancelled && status.live) setLive(new Set(status.live));
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Every camera on the wall, in one ask. Stopped while one is open: the wall
    // behind a dialog is standing still, and the viewer asks for its own.
    const [privacyError, setPrivacyError] = useState<string | null>(null);
    const placeId = cameras?.[0]?.placeId ?? "";
    const [rooms] = usePlaceRooms(placeId);
    const [sets, setSets] = useState<CameraSetView[]>([]);
    const [managingSets, setManagingSets] = useState(false);

    // The place's camera sets, once there is a place to ask about. The wall is
    // drawn without them; the switches appear when they land.
    useEffect(() => {
        if (!placeId) return;
        let current = true;
        void actions.listCameraSetsAction(placeId).then(
            (result) => {
                if (current && result.sets) setSets(result.sets);
            },
            () => undefined
        );
        return () => {
            current = false;
        };
    }, [placeId]);

    /**
     * Privacy for one camera or a group. Shown at once, then each camera's own
     * answer replaces it: one that refused goes back on its own, and a call that
     * failed outright puts every camera back.
     */
    async function switchPrivacy(target: PrivacyTarget, ids: readonly string[], wanted: boolean) {
        const list = cameras ?? [];
        const before = new Map(
            list.filter((camera) => ids.includes(camera.id)).map((camera) => [camera.id, camera.privacy])
        );
        setPrivacyError(null);
        setCameras((current) => applyPrivacy(current ?? [], ids, wanted));
        const result = await actions.cameraPrivacyAction(targetKey(target), wanted);
        if (result.error || !result.results) {
            setCameras((current) => rollbackPrivacy(current ?? [], before));
            setPrivacyError(result.error ?? t("privacy.failed"));
            return;
        }
        const results = result.results;
        setCameras((current) => settlePrivacy(current ?? [], results));
        // A camera made public again is back on the relay; ask which streams it serves now.
        if (results.some((row) => !row.private && before.get(row.cameraId))) {
            void actions.liveCamerasAction().then(
                (status) => {
                    if (status.live) setLive(new Set(status.live));
                },
                () => undefined
            );
        }
        const failed = results.filter((row) => row.failure);
        if (failed.length === 0) return;
        const first = failed[0];
        const reason =
            first?.failure === "locked"
                ? t("privacy.locked", { seconds: first.waitSeconds ?? 0 })
                : t(`privacy.${first?.failure ?? "failed"}`);
        setPrivacyError(
            `${t("privacy.failedSome", {
                count: failed.length,
                total: results.length,
                names: failed.map((row) => row.name).join(", ")
            })} ${reason}`
        );
    }

    /** The switch over a group of cameras: private unless all already are.
     *  Named groups (rooms, sets) carry their name; a zone's sits by its heading. */
    function groupSwitch(
        label: string,
        target: PrivacyTarget,
        group: readonly CameraView[],
        named = false
    ) {
        if (!canControl || group.length === 0) return null;
        const rows = group.map((camera) => ({ private: camera.privacy }));
        const wanted = nextPrivacy(rows);
        const words = wanted ? t("privacy.groupOn", { group: label }) : t("privacy.groupOff", { group: label });
        if (named)
            return (
                <Button
                    key={targetKey(target)}
                    variant="ghost"
                    size="sm"
                    className="min-w-0 max-w-48"
                    aria-pressed={groupState(rows).all}
                    aria-label={words}
                    title={words}
                    onClick={() =>
                        void switchPrivacy(
                            target,
                            group.map((camera) => camera.id),
                            wanted
                        )
                    }
                >
                    {wanted ? <EyeOff className="size-4 shrink-0" /> : <Eye className="size-4 shrink-0" />}
                    <span className="truncate">{label}</span>
                </Button>
            );
        return (
            <Button
                variant="ghost"
                size="icon"
                aria-pressed={groupState(rows).all}
                aria-label={words}
                title={words}
                onClick={() =>
                    void switchPrivacy(
                        target,
                        group.map((camera) => camera.id),
                        wanted
                    )
                }
            >
                {wanted ? <EyeOff className="size-4 shrink-0" /> : <Eye className="size-4 shrink-0" />}
            </Button>
        );
    }

    const watching = useMemo(() => (cameras ?? []).map((camera) => camera.id), [cameras]);
    const boxes = useDetections(watching, opened === null);

    if (cameras === null) return <WallSkeleton />;

    if (error && cameras.length === 0) {
        return (
            <EmptyState
                icon={<Cctv />}
                title={t("wall.listFailed")}
                description={error}
            />
        );
    }

    if (cameras.length === 0) {
        return (
            <EmptyState
                icon={<Cctv />}
                title={t("wall.empty.title")}
                description={
                    canManage
                        ? t("wall.empty.manage")
                        : t("wall.empty.view")
                }
                action={
                    canManage ? (
                        <Button asChild size="sm">
                            <Link href="/places/cameras">
                                <Plus className="size-4 shrink-0" />
                                {t("wall.empty.add")}
                            </Link>
                        </Button>
                    ) : undefined
                }
            />
        );
    }

    // Rooms with a camera on this wall, then the sets, each by what it holds.
    const namedGroups: { label: string; target: PrivacyTarget; cameras: CameraView[] }[] = [
        ...(rooms ?? []).map((room) => ({
            label: room.name,
            target: { kind: "room", id: room.id } as PrivacyTarget,
            cameras: cameras.filter((camera) => camera.roomId === room.id)
        })),
        ...sets.map((set) => ({
            label: set.name,
            target: { kind: "set", id: set.id } as PrivacyTarget,
            cameras: cameras.filter((camera) => set.cameraIds.includes(camera.id))
        }))
    ].filter((group) => group.cameras.length > 0);

    const zones = [...new Set(cameras.map((camera) => camera.zone))].sort((left, right) =>
        left === "" ? 1 : right === "" ? -1 : left.localeCompare(right)
    );

    return (
        <div className="flex flex-col gap-6">
            {cameras[0]?.placeId ? (
                <div className="-mb-4 flex items-center justify-end gap-2">
                    {privacyError ? (
                        <p role="alert" className="min-w-0 flex-1 text-[0.75rem] text-danger">
                            {privacyError}
                        </p>
                    ) : null}
                    {groupSwitch(
                        t("privacy.allCameras"),
                        { kind: "place", id: cameras[0].placeId },
                        cameras
                    )}
                </div>
            ) : null}
            {placeId && ((canControl && namedGroups.length > 0) || canManage) ? (
                <div className="-mb-4 flex min-w-0 flex-wrap items-center justify-end gap-1">
                    {namedGroups.map((group) =>
                        groupSwitch(group.label, group.target, group.cameras, true)
                    )}
                    {canManage ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("cameraSets.title")}
                            title={t("cameraSets.title")}
                            onClick={() => setManagingSets(true)}
                        >
                            <Layers className="size-4 shrink-0" />
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {managingSets ? (
                <CameraSetsDialog
                    open
                    placeId={placeId}
                    cameras={cameras}
                    sets={sets}
                    onClose={() => setManagingSets(false)}
                    onChange={setSets}
                />
            ) : null}
            {zones.map((zone) => (
                <section key={zone || "unplaced"} className="flex flex-col gap-2">
                    {zones.length > 1 ? (
                        <div className="flex min-w-0 items-center gap-1">
                            <h2 className="truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-foreground-subtle">
                                {zone || t("wall.unzoned")}
                            </h2>
                            {zone && cameras[0]?.placeId
                                ? groupSwitch(
                                      zone,
                                      { kind: "zone", placeId: cameras[0].placeId, zone },
                                      cameras.filter((camera) => camera.zone === zone)
                                  )
                                : null}
                        </div>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {cameras
                            .filter((camera) => camera.zone === zone)
                            .map((camera) => (
                                <CameraTile
                                    key={camera.id}
                                    camera={camera}
                                    live={live.has(camera.id)}
                                    boxes={boxes[camera.id]}
                                    canControl={canControl}
                                    // Everything on the wall stands still while
                                    // one camera is open, the one being watched
                                    // included - it is behind a dialog, and its
                                    // own stream is running in there.
                                    idle={opened !== null}
                                    onOpen={() => setOpened(camera.id)}
                                    onPrivacy={(wanted) =>
                                        void switchPrivacy(
                                            { kind: "camera", id: camera.id },
                                            [camera.id],
                                            wanted
                                        )
                                    }
                                />
                            ))}
                    </div>
                </section>
            ))}

            {opened ? (
                <CameraViewer
                    camera={cameras.find((camera) => camera.id === opened) as CameraView}
                    canControl={canControl}
                    onClose={() => setOpened(null)}
                    onPrivacyPreset={(preset) =>
                        setCameras((current) =>
                            (current ?? []).map((camera) =>
                                camera.id === opened ? { ...camera, privacyPreset: preset } : camera
                            )
                        )
                    }
                />
            ) : null}
        </div>
    );
}

/** The shape of the wall while it is being fetched, so the page does not jump
 *  once the cameras land. */
function WallSkeleton() {
    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((index) => (
                <div
                    key={index}
                    className="overflow-hidden rounded-lg border border-border bg-card"
                >
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="border-t border-border px-3 py-2">
                        <Skeleton className="h-3.5 w-28" />
                    </div>
                </div>
            ))}
        </div>
    );
}
