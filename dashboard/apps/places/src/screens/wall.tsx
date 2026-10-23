"use client";

/**
 * The wall: the cameras being shown, grouped by where they point.
 *
 * The cameras screen fetches the list and hands it over, so the wall and the
 * compact list read the same cameras and the same filters. Which of them the
 * relay is actually serving is a second, slower question the screen asks on its
 * own, without holding the tiles back.
 *
 * What the detectors are following is asked for here rather than in each tile.
 * One ask covers the whole wall, so a house with twelve cameras costs what a
 * house with one does; the tiles are handed their own boxes and draw them.
 */

import * as actions from "./actions";
import { Eye, EyeOff, Layers } from "lucide-react";
import { CameraSetsDialog } from "./cameras/camera-sets-dialog";
import { usePlaceRooms } from "./use-place-rooms";
import { CameraTile } from "./camera-tile";
import { CameraViewer } from "./camera-viewer";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useDetections } from "./use-detections";
import { usePlacesT } from "./use-places-t";
import type { CameraView } from "../lib/cameras";
import type { CameraPrivacy } from "./use-camera-privacy";
import { Button, Skeleton } from "@polaris/ui";
import {
    groupState,
    nextPrivacy,
    targetKey,
    type CameraSetView,
    type PrivacyTarget
} from "../lib/privacy-kinds";

/** The switch over a group of cameras: private unless all already are. Named
 *  groups (rooms, sets) carry their name; a zone's sits by its heading. */
function GroupSwitch({
    label,
    target,
    group,
    named = false,
    privacy
}: {
    label: string;
    target: PrivacyTarget;
    group: readonly CameraView[];
    named?: boolean;
    privacy: CameraPrivacy;
}) {
    const t = usePlacesT();
    if (group.length === 0) return null;
    const rows = group.map((camera) => ({ private: camera.privacy }));
    const wanted = nextPrivacy(rows);
    const words = wanted
        ? t("privacy.groupOn", { group: label })
        : t("privacy.groupOff", { group: label });
    const flip = () =>
        void privacy.switchPrivacy(
            target,
            group.map((camera) => camera.id),
            wanted
        );
    const icon = wanted ? (
        <EyeOff className="size-4 shrink-0" />
    ) : (
        <Eye className="size-4 shrink-0" />
    );
    if (named)
        return (
            <Button
                variant="ghost"
                size="sm"
                className="min-w-0 max-w-48"
                aria-pressed={groupState(rows).all}
                aria-label={words}
                title={words}
                onClick={flip}
            >
                {icon}
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
            onClick={flip}
        >
            {icon}
        </Button>
    );
}

/**
 * Privacy over groups of cameras - the whole place, its rooms, its sets - and
 * what went wrong the last time a switch was pressed. Above the wall and the
 * list alike, over every camera in the place rather than the ones a search left.
 */
export function CameraGroups({
    cameras,
    canManage,
    canControl,
    privacy
}: {
    cameras: readonly CameraView[];
    canManage: boolean;
    canControl: boolean;
    privacy: CameraPrivacy;
}) {
    const t = usePlacesT();
    const placeId = cameras[0]?.placeId ?? "";
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

    if (!placeId) return null;

    // Rooms with a camera here, then the sets, each by what it holds.
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

    const untrusted = privacy.untrusted;
    const showGroups = (canControl && namedGroups.length > 0) || canManage;
    if (!privacy.error && !canControl && !showGroups) return null;

    return (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            {privacy.error ? (
                <p role="alert" className="min-w-0 flex-1 basis-60 text-[0.75rem] text-danger">
                    {privacy.error}
                </p>
            ) : null}
            {privacy.error && untrusted ? (
                <Button
                    variant="outline"
                    size="sm"
                    className="min-w-0 max-w-48"
                    title={t("privacy.trustAgain")}
                    onClick={() =>
                        void privacy.switchPrivacy(
                            untrusted.target,
                            untrusted.ids,
                            untrusted.wanted,
                            untrusted.cameraIds
                        )
                    }
                >
                    <span className="truncate">{t("privacy.trustAgain")}</span>
                </Button>
            ) : null}
            {canControl
                ? namedGroups.map((group) => (
                      <GroupSwitch
                          key={targetKey(group.target)}
                          label={group.label}
                          target={group.target}
                          group={group.cameras}
                          named
                          privacy={privacy}
                      />
                  ))
                : null}
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
            {canControl ? (
                <GroupSwitch
                    label={t("privacy.allCameras")}
                    target={{ kind: "place", id: placeId }}
                    group={cameras}
                    privacy={privacy}
                />
            ) : null}
            {managingSets ? (
                <CameraSetsDialog
                    open
                    placeId={placeId}
                    cameras={[...cameras]}
                    sets={sets}
                    onClose={() => setManagingSets(false)}
                    onChange={setSets}
                />
            ) : null}
        </div>
    );
}

export function Wall({
    cameras,
    shown,
    live,
    canControl,
    privacy,
    menuFor,
    onWatching,
    onPrivacyPreset
}: {
    /** Every camera in the place, for the zone switches. */
    cameras: readonly CameraView[];
    /** The ones the filters left, which are the ones drawn. */
    shown: readonly CameraView[];
    live: ReadonlySet<string>;
    canControl: boolean;
    privacy: CameraPrivacy;
    /** What a camera's tile offers to manage it, or nothing for a reader who
     *  may not. */
    menuFor?: (camera: CameraView) => ReactNode;
    /** Told whether a camera is open in the viewer, while the wall stands still. */
    onWatching?: (watching: boolean) => void;
    /** Told a camera's stored privacy position once the viewer changed it. */
    onPrivacyPreset: (cameraId: string, preset: string) => void;
}) {
    const t = usePlacesT();
    const [opened, setOpened] = useState<string | null>(null);
    useEffect(() => onWatching?.(opened !== null), [opened, onWatching]);

    // Every camera on the wall, in one ask. Stopped while one is open: the wall
    // behind a dialog is standing still, and the viewer asks for its own.
    const watching = useMemo(() => shown.map((camera) => camera.id), [shown]);
    const boxes = useDetections(watching, opened === null);

    const zones = [...new Set(shown.map((camera) => camera.zone))].sort((left, right) =>
        left === "" ? 1 : right === "" ? -1 : left.localeCompare(right)
    );
    const placeId = cameras[0]?.placeId ?? "";
    const viewing = opened ? cameras.find((camera) => camera.id === opened) : undefined;

    return (
        <div className="flex flex-col gap-6">
            {zones.map((zone) => (
                <section key={zone || "unplaced"} className="flex flex-col gap-2">
                    {zones.length > 1 ? (
                        <div className="flex min-w-0 items-center gap-1">
                            <h2
                                className="truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-foreground-subtle"
                                title={zone || t("wall.unzoned")}
                            >
                                {zone || t("wall.unzoned")}
                            </h2>
                            {zone && placeId && canControl ? (
                                <GroupSwitch
                                    label={zone}
                                    target={{ kind: "zone", placeId, zone }}
                                    group={cameras.filter((camera) => camera.zone === zone)}
                                    privacy={privacy}
                                />
                            ) : null}
                        </div>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                        {shown
                            .filter((camera) => camera.zone === zone)
                            .map((camera) => (
                                <CameraTile
                                    // A camera coming back from privacy starts
                                    // over as a new tile: what the old one had
                                    // given up on while the camera was masked is
                                    // not its state any more.
                                    key={`${camera.id}-${camera.privacy ? "private" : "public"}`}
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
                                        void privacy.switchPrivacy(
                                            { kind: "camera", id: camera.id },
                                            [camera.id],
                                            wanted
                                        )
                                    }
                                    menu={menuFor?.(camera)}
                                />
                            ))}
                    </div>
                </section>
            ))}

            {viewing ? (
                <CameraViewer
                    camera={viewing}
                    canControl={canControl}
                    onClose={() => setOpened(null)}
                    onPrivacyPreset={(preset) => onPrivacyPreset(viewing.id, preset)}
                />
            ) : null}
        </div>
    );
}

/** The shape of the wall while it is being fetched, so the page does not jump
 *  once the cameras land. */
export function WallSkeleton() {
    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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
