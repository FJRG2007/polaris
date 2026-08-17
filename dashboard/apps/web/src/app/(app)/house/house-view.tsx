"use client";

/**
 * The wall: every camera in the house, grouped by where it points.
 *
 * The shell is on screen before anything has been asked for, and the cameras
 * arrive after - so the page never waits on a relay or a camera that is asleep.
 * Which of them the relay is actually serving is a second, slower question, and
 * it lands on its own without holding the tiles back.
 */

import Link from "next/link";
import * as actions from "./actions";
import { Cctv, Plus } from "lucide-react";
import { CameraTile } from "./camera-tile";
import { useEffect, useState } from "react";
import type { CameraView } from "@/lib/home/cameras";
import { Button, EmptyState, Skeleton } from "@polaris/ui";

export function HouseView({ canManage, canControl }: { canManage: boolean; canControl: boolean }) {
    const [cameras, setCameras] = useState<CameraView[] | null>(null);
    const [live, setLive] = useState<Set<string>>(() => new Set());
    const [error, setError] = useState<string | null>(null);
    const [playing, setPlaying] = useState<string | null>(null);

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
                            <Link href="/house/cameras">
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
                                    playing={playing === camera.id}
                                    canControl={canControl}
                                    onPlay={setPlaying}
                                />
                            ))}
                    </div>
                </section>
            ))}
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
