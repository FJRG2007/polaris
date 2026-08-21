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
import { Cctv, Plus } from "lucide-react";
import { CameraTile } from "./camera-tile";
import { CameraViewer } from "./camera-viewer";
import { useEffect, useMemo, useState } from "react";
import { useDetections } from "./use-detections";
import type { CameraView } from "@/lib/home/cameras";
import { Button, EmptyState, Skeleton } from "@polaris/ui";

export function Wall({ canManage, canControl }: { canManage: boolean; canControl: boolean }) {
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
    const watching = useMemo(() => (cameras ?? []).map((camera) => camera.id), [cameras]);
    const boxes = useDetections(watching, opened === null);

    if (cameras === null) return <WallSkeleton />;

    if (error && cameras.length === 0) {
        return <EmptyState icon={<Cctv />} title="The cameras could not be listed" description={error} />;
    }

    if (cameras.length === 0) {
        return (
            <EmptyState
                icon={<Cctv />}
                title="No cameras yet"
                description={
                    canManage
                        ? "Add one and Polaris will find its streams, or look for the ones already on your network."
                        : "Nobody has added a camera to this house yet."
                }
                action={
                    canManage ? (
                        <Button asChild size="sm">
                            <Link href="/places/cameras">
                                <Plus className="size-4 shrink-0" />
                                Add a camera
                            </Link>
                        </Button>
                    ) : undefined
                }
            />
        );
    }

    const zones = [...new Set(cameras.map((camera) => camera.zone))].sort((left, right) =>
        left === "" ? 1 : right === "" ? -1 : left.localeCompare(right)
    );

    return (
        <div className="flex flex-col gap-6">
            {zones.map((zone) => (
                <section key={zone || "unplaced"} className="flex flex-col gap-2">
                    {zones.length > 1 ? (
                        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
                            {zone || "Everywhere else"}
                        </h2>
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
                <div key={index} className="overflow-hidden rounded-lg border border-border bg-card">
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="border-t border-border px-3 py-2">
                        <Skeleton className="h-3.5 w-28" />
                    </div>
                </div>
            ))}
        </div>
    );
}
