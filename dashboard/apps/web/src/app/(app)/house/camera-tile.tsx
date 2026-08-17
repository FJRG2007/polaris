"use client";

/**
 * One camera on the wall.
 *
 * A tile is a still until somebody looks at it, and video while they do. That is
 * not a nicety - a wall of twelve live streams is twelve connections held open
 * for a page nobody is reading closely, and the whole point of Home is that a
 * camera costs nothing until it is watched. So the still refreshes slowly, and
 * pressing the tile is what asks for video.
 *
 * A camera that will not answer says which of the three things is wrong -
 * starting up, switched off, or not reachable - because "no signal" sends people
 * to the wrong place every time.
 */

import Link from "next/link";
import { Badge, cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import type { CameraView } from "@/lib/home/cameras";
import { Camera, Loader2, Play, VideoOff } from "lucide-react";

/** How often an idle tile asks for a new still. Slow on purpose: it is a wall,
 *  not a stream, and twelve tiles at this rate is one request every five
 *  seconds. */
const STILL_INTERVAL_MS = 15_000;

export function CameraTile({
    camera,
    live,
    playing,
    onPlay
}: {
    camera: CameraView;
    /** Whether the relay is serving this camera at all. */
    live: boolean;
    /** Whether this is the tile currently showing video. One at a time: two
     *  streams on one screen is two connections for one pair of eyes. */
    playing: boolean;
    onPlay: (id: string | null) => void;
}) {
    const [stamp, setStamp] = useState(() => 0);
    const [failed, setFailed] = useState(false);
    const video = useRef<HTMLVideoElement | null>(null);

    useEffect(() => {
        if (playing || !camera.enabled) return;
        const timer = setInterval(() => setStamp((value) => value + 1), STILL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [playing, camera.enabled]);

    // Leaving the tile has to end the request, not just hide it: a <video> that is
    // unmounted while streaming can keep its connection until the browser gets
    // round to it, and that connection is the camera's only one.
    useEffect(() => {
        const element = video.current;
        return () => {
            if (!element) return;
            element.pause();
            element.removeAttribute("src");
            element.load();
        };
    }, [playing]);

    const still = `/api/home/cameras/${camera.id}/snapshot?v=${stamp}`;

    return (
        <div className="group relative overflow-hidden rounded-lg border border-border bg-card">
            <button
                type="button"
                onClick={() => onPlay(playing ? null : camera.id)}
                className="block aspect-video w-full bg-background"
                aria-label={playing ? `Stop watching ${camera.name}` : `Watch ${camera.name}`}
            >
                {playing ? (
                    <video
                        ref={video}
                        src={`/api/home/cameras/${camera.id}/stream?q=main`}
                        className="size-full object-cover"
                        autoPlay
                        muted
                        playsInline
                        onError={() => setFailed(true)}
                    />
                ) : camera.enabled && live && !failed ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a live
                    // frame is never the same twice, so there is nothing for the
                    // image optimizer to cache and it would only add a hop.
                    <img
                        src={still}
                        alt={camera.name}
                        className="size-full object-cover"
                        onError={() => setFailed(true)}
                    />
                ) : (
                    <Unavailable camera={camera} live={live} />
                )}
            </button>

            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                <div className="min-w-0">
                    <Link
                        href={`/house/cameras?open=${camera.id}`}
                        className="block truncate text-[13px] font-medium text-foreground hover:underline"
                    >
                        {camera.name}
                    </Link>
                    {camera.zone ? (
                        <p className="truncate text-[11px] text-foreground-subtle" title={camera.zone}>{camera.zone}</p>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {camera.recording !== "off" ? (
                        <Badge variant="danger" title="Recording">
                            REC
                        </Badge>
                    ) : null}
                    <span
                        className={cn(
                            "flex size-6 items-center justify-center rounded-md text-foreground-subtle transition-colors",
                            "group-hover:bg-surface group-hover:text-foreground"
                        )}
                        aria-hidden
                    >
                        <Play className="size-3.5 shrink-0" />
                    </span>
                </div>
            </div>
        </div>
    );
}

/** Why there is no picture, said specifically enough to act on. */
function Unavailable({ camera, live }: { camera: CameraView; live: boolean }) {
    if (!camera.enabled) {
        return (
            <Placeholder icon={<VideoOff className="size-5 shrink-0" />} label="Switched off" />
        );
    }
    if (!live) {
        return <Placeholder icon={<Loader2 className="size-5 shrink-0 animate-spin" />} label="Starting" />;
    }
    return <Placeholder icon={<Camera className="size-5 shrink-0" />} label="Not answering" />;
}

function Placeholder({ icon, label }: { icon: React.ReactNode; label: string }) {
    return (
        <span className="flex size-full flex-col items-center justify-center gap-1.5 text-foreground-subtle">
            {icon}
            <span className="text-[11px]">{label}</span>
        </span>
    );
}
