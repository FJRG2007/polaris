"use client";

/**
 * One camera on the wall.
 *
 * There is a picture within a moment of the tile appearing, always, on every
 * device. That is the whole design of this file and it is not what it used to be.
 *
 * It used to be a `<video>` and nothing else. Video cannot start until a keyframe
 * arrives from the camera, and cameras send those seconds apart - so a tile was
 * blank for as long as the camera felt like, with no way to tell that from a dead
 * camera. Worse, a stream that connects and then sends nothing fires no error at
 * all: the element sits there forever, and the tile shows a spinner or a frame
 * from four minutes ago while the clock in the corner stays still. That is the
 * "it does not even look like it is loading" everybody reports.
 *
 * So a frame is fetched and drawn straight away, and replaced as fast as it comes
 * back. Every frame is whole, so there is nothing to wait for and nothing to
 * stall - and the relay is asked with a one-second cache, so ten tiles of the
 * same camera cost one decode rather than ten. Underneath, the real stream is
 * still started, and the moment it plays it takes over the tile and the frames
 * stop. If it never plays, nobody notices: the picture was already there.
 *
 * Two other things are still bounded. The tiles watch the SMALL stream, and a
 * tile scrolled out of view stops asking for anything at all.
 *
 * Nothing here nests a button inside a button. It used to - the whole tile was
 * one, with the movement arrows inside it - which is invalid HTML, and the
 * browser resolves it by dropping the inner button's events. The arrows silently
 * did nothing.
 */

import Link from "next/link";
import { Badge, Button, cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import type { CameraView } from "@/lib/home/cameras";
import { Camera, Maximize2, VideoOff } from "lucide-react";
import { otherTransport, preferredTransport, stillSrc, streamSrc, type Transport } from "@/lib/home/player";

/**
 * How soon after one frame arrives the next is asked for.
 *
 * Paced by arrival rather than by a clock: a slow link or a busy relay stretches
 * the gap by itself instead of queueing requests that overtake each other. The
 * relay's own one-second cache is what stops several tiles multiplying the cost.
 */
const FRAME_GAP_MS = 900;

/**
 * The same, once the stream has been given up on.
 *
 * Slower on purpose. The relay drops its connection to a camera when the last
 * thing watching it goes away, and a frame is a consumer that leaves as soon as
 * it has one - so while a stream is open the camera stays connected and a frame
 * is nearly free, and once nothing is open each frame is a fresh conversation
 * with the camera. That is the moment to ask less often rather than more.
 */
const COLD_GAP_MS = 2_500;

/** After a frame that did not arrive. Long enough not to hammer a camera that is
 *  rebooting, short enough that it comes back on its own. */
const FRAME_RETRY_MS = 5_000;

/**
 * How long the stream gets to produce a picture before it is written off.
 *
 * There has to be a number, because the failure this catches is silence: a
 * request that connects and never sends a playable frame raises no error and the
 * element waits forever. Generous, because the wait is usually the camera's
 * keyframe interval and not a fault.
 */
const VIDEO_START_MS = 9_000;

/** The frame is drawn a few hundred pixels wide, so that is what is asked for.
 *  A camera's own frame is several thousand pixels across - sending that to fill
 *  a postcard is most of a megabyte, over and over, on somebody's phone. */
const FRAME_WIDTH = 640;

export function CameraTile({
    camera,
    live,
    canControl,
    onOpen
}: {
    camera: CameraView;
    /** Whether the relay is serving this camera at all. */
    live: boolean;
    canControl: boolean;
    /** Open it big. */
    onOpen: () => void;
}) {
    const [visible, setVisible] = useState(false);
    const [stamp, setStamp] = useState(0);
    /** Whether a frame has ever arrived. Null until the first one settles, which
     *  is the difference between "starting" and "not answering". */
    const [drawn, setDrawn] = useState<boolean | null>(null);
    /** Which stream is being tried, or null once video has been given up on for
     *  now - the frames carry the tile either way. */
    const [attempt, setAttempt] = useState<"sub" | "main" | null>("sub");
    const [transport, setTransport] = useState<Transport>("mp4");
    const [swapped, setSwapped] = useState(false);
    /** Whether the stream is actually playing. Until it is, the frames are what
     *  is on screen. */
    const [playing, setPlaying] = useState(false);

    const frame = useRef<HTMLDivElement | null>(null);
    const video = useRef<HTMLVideoElement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showing = camera.enabled && live;
    const wantFrames = showing && visible && !playing;

    // Only what somebody can actually see is worth a connection.
    useEffect(() => {
        const element = frame.current;
        if (!element) return;
        const observer = new IntersectionObserver(
            (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
            { rootMargin: "200px" }
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // Asked after mounting rather than during render: the server has no browser
    // to ask, and a first paint that disagrees with the second is a hydration
    // mismatch over a camera.
    useEffect(() => setTransport(preferredTransport()), []);

    const after = (delay: number) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setStamp((value) => value + 1), delay);
    };

    // Start, stop and restart the frames as the tile comes and goes. The next one
    // is scheduled when the last arrives, so this only ever kicks the cycle off.
    useEffect(() => {
        if (!wantFrames) {
            if (timer.current) clearTimeout(timer.current);
            return;
        }
        after(0);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [wantFrames]);

    /**
     * What to try when the stream does not start.
     *
     * The good stream next, because some cameras publish only one and some
     * publish a second the relay cannot open. Then the other format: a browser
     * that will not take one usually takes the other, and finding out by trying
     * is more reliable than deciding from what the browser calls itself. Then
     * nothing - which costs the viewer nothing, because the frames are already
     * on screen and keep coming.
     */
    const failed = () => {
        setPlaying(false);
        if (attempt === "sub") {
            setAttempt("main");
            return;
        }
        if (!swapped) {
            setSwapped(true);
            setTransport(otherTransport(transport));
            setAttempt("sub");
            return;
        }
        setAttempt(null);
    };

    // A stream that connects and then says nothing raises no error, so silence is
    // timed rather than waited on.
    useEffect(() => {
        if (!attempt || playing || !wantFrames) return;
        const watchdog = setTimeout(failed, VIDEO_START_MS);
        return () => clearTimeout(watchdog);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- restarting the
        // clock is the point whenever what is being tried changes.
    }, [attempt, transport, playing, wantFrames]);

    // Give up for a minute, not forever: a camera that was rebooting when the
    // page loaded should not need a reload.
    useEffect(() => {
        if (attempt !== null) return;
        const retry = setTimeout(() => {
            setTransport(preferredTransport());
            setSwapped(false);
            setAttempt("sub");
        }, 60_000);
        return () => clearTimeout(retry);
    }, [attempt]);

    // Stopping has to end the request rather than hide it: a stream nobody is
    // watching still holds a slot on the relay.
    useEffect(() => {
        if (visible && showing) return;
        const element = video.current;
        if (!element) return;
        element.pause();
        element.removeAttribute("src");
        element.load();
        setPlaying(false);
    }, [visible, showing]);

    return (
        <div ref={frame} className="group relative overflow-hidden rounded-lg border border-border bg-card">
            <div className="relative aspect-video bg-background">
                {showing ? (
                    <>
                        {/* eslint-disable-next-line @next/next/no-img-element -- a
                            live frame is never the same twice, so there is nothing
                            for the image optimizer to cache and it would only add
                            a hop. */}
                        <img
                            src={stillSrc(camera.id, stamp, FRAME_WIDTH)}
                            alt={camera.name}
                            className={cn("absolute inset-0 size-full object-cover", playing && "opacity-0")}
                            onLoad={() => {
                                setDrawn(true);
                                if (wantFrames) after(attempt ? FRAME_GAP_MS : COLD_GAP_MS);
                            }}
                            onError={() => {
                                setDrawn(false);
                                if (wantFrames) after(FRAME_RETRY_MS);
                            }}
                        />
                        {attempt && visible ? (
                            <video
                                ref={video}
                                // Keyed so switching quality or format really
                                // re-creates the element: a <video> handed a new
                                // src after an error keeps the error and never
                                // tries again.
                                key={`${transport}-${attempt}`}
                                src={streamSrc(camera.id, attempt, transport)}
                                className={cn(
                                    "absolute inset-0 size-full object-cover",
                                    playing ? "opacity-100" : "opacity-0"
                                )}
                                autoPlay
                                muted
                                playsInline
                                onPlaying={() => setPlaying(true)}
                                onError={failed}
                            />
                        ) : null}
                        {drawn === false && !playing ? (
                            <Placeholder icon={<Camera className="size-5 shrink-0" />} label="Not answering" />
                        ) : null}
                    </>
                ) : (
                    <Unavailable camera={camera} live={live} />
                )}

                {/* The whole picture opens it: a transparent button OVER the
                    frame rather than one wrapping it, so anything drawn on top
                    stays a sibling and keeps its own clicks. */}
                <button
                    type="button"
                    onClick={onOpen}
                    aria-label={`Open ${camera.name}`}
                    className="absolute inset-0 cursor-zoom-in"
                />
                <span
                    className="pointer-events-none absolute right-2 top-2 flex size-7 items-center justify-center rounded-md bg-black/45 text-white/80 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden
                >
                    <Maximize2 className="size-3.5 shrink-0" />
                </span>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                <div className="min-w-0">
                    <button
                        type="button"
                        onClick={onOpen}
                        className="block max-w-full truncate text-left text-[13px] font-medium text-foreground hover:underline"
                    >
                        {camera.name}
                    </button>
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
                    {canControl ? (
                        <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            aria-label={`Settings for ${camera.name}`}
                            title="Settings"
                        >
                            <Link href={`/places/cameras?open=${camera.id}`}>
                                <Camera className="size-4 shrink-0" />
                            </Link>
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

/** Why there is no picture, said specifically enough to act on. */
function Unavailable({ camera, live }: { camera: CameraView; live: boolean }) {
    if (!camera.enabled) return <Placeholder icon={<VideoOff className="size-5 shrink-0" />} label="Switched off" />;
    if (!live) return <Placeholder icon={<Camera className="size-5 shrink-0" />} label="Starting" />;
    return <Placeholder icon={<Camera className="size-5 shrink-0" />} label="Not answering" />;
}

function Placeholder({ icon, label }: { icon: React.ReactNode; label: string }) {
    return (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-background text-foreground-subtle">
            {icon}
            <span className="text-[11px]">{label}</span>
        </span>
    );
}
