"use client";

/**
 * One camera on the wall, live.
 *
 * Every tile plays, because that is what a wall of cameras is for. It costs the
 * cameras nothing: the relay holds one connection to each and re-serves it, so a
 * tile, a second person watching and a detector are all the same single
 * connection as far as the camera is concerned.
 *
 * Two things are still bounded. The tiles watch the SMALL stream - a wall is
 * glanced at, and twelve full-resolution streams is bandwidth spent on pictures
 * the size of a postcard - and a tile scrolled out of view stops playing and
 * falls back to its still. The second is not tidiness: a browser allows about
 * six connections to one host over HTTP/1.1, so a house with ten cameras on a
 * plain-HTTP LAN would otherwise have four tiles that never load and nothing on
 * screen explaining why.
 *
 * Nothing here nests a button inside a button. It used to - the whole tile was
 * one, with the movement arrows inside it - which is invalid HTML, and the
 * browser resolves it by dropping the inner button's events. The arrows silently
 * did nothing.
 */

import Link from "next/link";
import { Badge, Button } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import type { CameraView } from "@/lib/home/cameras";
import { Camera, Loader2, Maximize2, VideoOff } from "lucide-react";
import { otherTransport, preferredTransport, stillSrc, streamSrc, type Transport } from "@/lib/home/player";

/**
 * How often the fallback picture is replaced.
 *
 * Faster when it is what somebody is actually looking at, because a picture that
 * does not change reads as a broken camera - the clock in the corner stops, and
 * that is the first thing anybody notices. Slower when the tile is off screen or
 * the camera is off, where it is only there to be current when scrolled back to.
 */
const STILL_INTERVAL_MS = 4_000;
const IDLE_STILL_INTERVAL_MS = 30_000;

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
    /**
     * What to try next when the picture does not arrive.
     *
     * The small stream first, because a wall of them is the whole point. Some
     * cameras publish only one, and some publish a second that the relay cannot
     * open - so rather than showing "not answering" over a camera that is
     * perfectly fine, it falls back to the good stream, then to a still, and
     * only then admits defeat.
     */
    const [attempt, setAttempt] = useState<"sub" | "main" | "still" | "none">("sub");
    /** Which live format this browser gets. Guessed once, then corrected by
     *  whether it actually played - see lib/home/player. */
    const [transport, setTransport] = useState<Transport>("mp4");
    const [swapped, setSwapped] = useState(false);
    const [ready, setReady] = useState(false);
    const frame = useRef<HTMLDivElement | null>(null);
    const video = useRef<HTMLVideoElement | null>(null);

    // Asked after mounting rather than during render: the server has no browser
    // to ask, and a first paint that disagrees with the second is a hydration
    // mismatch over a camera.
    useEffect(() => setTransport(preferredTransport()), []);

    /**
     * What to try when the picture does not arrive.
     *
     * The good stream next, because some cameras publish only one and some
     * publish a second the relay cannot open. Then the other format: a browser
     * that will not take one usually takes the other, and finding out by trying
     * is more reliable than deciding from what the browser calls itself.
     */
    const failed = () => {
        setReady(false);
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
        setAttempt("still");
    };

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

    const playing = visible && live && camera.enabled && (attempt === "sub" || attempt === "main");
    const showStill = !playing && camera.enabled && live && attempt !== "none";

    useEffect(() => {
        if (playing || !camera.enabled) return;
        const watched = visible && attempt === "still";
        const timer = setInterval(
            () => setStamp((value) => value + 1),
            watched ? STILL_INTERVAL_MS : IDLE_STILL_INTERVAL_MS
        );
        return () => clearInterval(timer);
    }, [playing, camera.enabled, visible, attempt]);

    // Give up for a minute, not forever: a camera that was rebooting when the
    // page loaded is otherwise dead until somebody reloads.
    useEffect(() => {
        if (attempt !== "none") return;
        const timer = setTimeout(() => {
            // From the top, including which format to try: the last round may
            // have ended on the wrong one for a reason that has since gone away.
            setTransport(preferredTransport());
            setSwapped(false);
            setAttempt("sub");
        }, 60_000);
        return () => clearTimeout(timer);
    }, [attempt]);

    // Stopping has to end the request rather than hide it: a stream nobody is
    // watching still holds a slot on the relay.
    useEffect(() => {
        if (playing) return;
        const element = video.current;
        if (!element) return;
        element.pause();
        element.removeAttribute("src");
        element.load();
    }, [playing]);

    return (
        <div ref={frame} className="group relative overflow-hidden rounded-lg border border-border bg-card">
            <div className="relative aspect-video bg-background">
                {playing ? (
                    <video
                        ref={video}
                        // Keyed so switching quality or format really re-creates
                        // the element: a <video> handed a new src after an error
                        // keeps the error and never tries again.
                        key={`${transport}-${attempt}`}
                        src={streamSrc(camera.id, attempt, transport)}
                        // A live picture the moment the tile appears. HLS in
                        // particular waits for a keyframe and a first segment,
                        // and a camera with a long keyframe interval can leave a
                        // black rectangle up for several seconds.
                        poster={stillSrc(camera.id)}
                        className="size-full object-cover"
                        autoPlay
                        muted
                        playsInline
                        onCanPlay={() => setReady(true)}
                        onError={failed}
                    />
                ) : showStill ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a live
                    // frame is never the same twice, so there is nothing for the
                    // image optimizer to cache and it would only add a hop.
                    <img
                        src={stillSrc(camera.id, stamp)}
                        alt={camera.name}
                        className="size-full object-cover"
                        onError={() => setAttempt("none")}
                    />
                ) : (
                    <Unavailable camera={camera} live={live} />
                )}

                {playing && !ready ? (
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/70">
                        <Loader2 className="size-5 shrink-0 animate-spin" />
                    </span>
                ) : null}

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
    if (!live) return <Placeholder icon={<Loader2 className="size-5 shrink-0 animate-spin" />} label="Starting" />;
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
