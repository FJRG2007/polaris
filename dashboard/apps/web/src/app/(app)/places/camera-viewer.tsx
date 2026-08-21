"use client";

/**
 * One camera, big.
 *
 * The wall is for taking in the whole house at a glance; this is for looking at
 * something. So it swaps to the good stream rather than the small one the tiles
 * watch, gives the picture the whole dialog, and puts the controls where they
 * belong on a video: over it, and out of the way until the pointer is there.
 *
 * Same rule as the wall, for the same reason: a frame is drawn immediately and
 * replaced as fast as it comes back, and the stream takes over the moment it
 * plays. Opening a camera and watching a black rectangle for six seconds while a
 * keyframe is waited on is indistinguishable from a camera that is broken, and
 * the stream that connects and then sends nothing raises no error at all - so
 * silence is timed rather than waited on.
 *
 * Fullscreen is the browser's own, on the frame rather than the video element,
 * so the controls stay on screen with it - a fullscreen `<video>` hides
 * everything drawn over it.
 */

import { PtzPad } from "./ptz-pad";
import { useEffect, useRef, useState } from "react";
import type { CameraView } from "@/lib/home/cameras";
import { Camera, Maximize2, Minimize2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogTitle, cn } from "@polaris/ui";
import { otherTransport, preferredTransport, stillSrc, streamSrc, type Transport } from "@/lib/home/player";

/**
 * Paced by arrival rather than by a clock, so a slow link stretches the gap
 * instead of queueing requests that overtake each other.
 *
 * Short, because this is one camera on its own and the pictures are what carries
 * it until the stream starts - and, when the stream will not start at all, what
 * carries it for good. At seven hundred milliseconds against a relay holding
 * each frame for a second, better than half of these asks returned the picture
 * already on screen: the reader was watching one frame a second and calling it,
 * correctly, a slideshow.
 */
const FRAME_GAP_MS = 260;

/** The same, once the stream has been given up on. The relay drops its
 *  connection to a camera when nothing is watching, so with no stream open every
 *  frame is a fresh conversation with the camera - which is the moment to ask
 *  less often rather than more. */
const COLD_GAP_MS = 2_000;
const FRAME_RETRY_MS = 5_000;

/**
 * How long the stream may say nothing at all before it is written off.
 *
 * Silence is the failure this catches: a request that connects and never sends
 * a playable frame raises no error, and the element waits forever.
 *
 * It is silence that is timed, not the wait for a picture. A camera here takes
 * about fourteen seconds between the request and the first frame the browser
 * will show, because the browser fills a buffer before it starts - which is not
 * a fault. Timed as "how long until it plays", such a camera is written off a
 * few seconds before it would have played, every time, and the viewer keeps the
 * still pictures for good.
 */
const VIDEO_SILENCE_MS = 9_000;

/** Opened deliberately, so the good size. */
const FRAME_WIDTH = 1280;

/**
 * The size to ask for while the pictures are standing in for the video.
 *
 * Smaller on purpose, and it is a trade made the right way round: several
 * smaller frames a second read as a moving picture, and one sharp frame a second
 * reads as a fault. Sharpness comes back the moment the stream plays, and the
 * stream is what this is waiting for.
 */
const MOVING_WIDTH = 640;

export function CameraViewer({
    camera,
    canControl,
    onClose
}: {
    camera: CameraView;
    canControl: boolean;
    onClose: () => void;
}) {
    const frame = useRef<HTMLDivElement | null>(null);
    const video = useRef<HTMLVideoElement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [full, setFull] = useState(false);
    const [stamp, setStamp] = useState(0);
    const [drawn, setDrawn] = useState<boolean | null>(null);
    const [playing, setPlaying] = useState(false);
    const [trying, setTrying] = useState(true);
    const [transport, setTransport] = useState<Transport>("mp4");
    const [swapped, setSwapped] = useState(false);

    useEffect(() => setTransport(preferredTransport()), []);

    // The browser is the authority on whether it is fullscreen: it leaves on
    // Escape without telling anybody who asked for it.
    useEffect(() => {
        const sync = () => setFull(document.fullscreenElement === frame.current);
        document.addEventListener("fullscreenchange", sync);
        return () => document.removeEventListener("fullscreenchange", sync);
    }, []);

    const after = (delay: number) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setStamp((value) => value + 1), delay);
    };

    useEffect(() => {
        if (playing) {
            if (timer.current) clearTimeout(timer.current);
            return;
        }
        after(0);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [playing]);

    /** The other format, then nothing. Giving up on the stream is not giving up
     *  on the camera: the frames are on screen and keep coming. */
    const failed = () => {
        setPlaying(false);
        if (swapped) {
            setTrying(false);
            return;
        }
        setSwapped(true);
        setTransport(otherTransport(transport));
    };

    /** Anything the element does that proves the stream is alive, so the clock
     *  below runs against silence rather than against the picture. */
    const [alive, setAlive] = useState(0);
    const stirred = () => setAlive((value) => value + 1);

    useEffect(() => {
        if (!trying || playing) return;
        const watchdog = setTimeout(failed, VIDEO_SILENCE_MS);
        return () => clearTimeout(watchdog);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- restarting the
        // clock is the point whenever what is being tried changes, and whenever
        // the stream shows a sign of life.
    }, [transport, trying, playing, alive]);

    // Closing has to end the request rather than hide it: a stream left running
    // holds a slot on the relay for a camera nobody is watching. Read at teardown
    // rather than at mount, since swapping format replaces the element.
    useEffect(() => {
        return () => {
            const element = video.current;
            if (!element) return;
            element.pause();
            element.removeAttribute("src");
            element.load();
        };
    }, []);

    const toggleFullscreen = () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void frame.current?.requestFullscreen().catch(() => setFull(false));
    };

    const surface = full ? "h-screen object-contain" : "aspect-video object-contain";

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-5xl p-0" showClose={!full}>
                <DialogTitle className="sr-only">{camera.name}</DialogTitle>
                <div ref={frame} className="group/frame relative bg-black">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a live
                        frame is never the same twice, so there is nothing for the
                        image optimizer to cache and it would only add a hop. */}
                    <img
                        src={stillSrc(
                            camera.id,
                            stamp,
                            trying ? MOVING_WIDTH : FRAME_WIDTH,
                            // Only while the pictures are the view. Once the
                            // stream is playing nothing asks for one at all.
                            trying
                        )}
                        alt={camera.name}
                        className={cn("w-full bg-black", surface, playing && "invisible")}
                        onLoad={() => {
                            setDrawn(true);
                            if (!playing) after(trying ? FRAME_GAP_MS : COLD_GAP_MS);
                        }}
                        onError={() => {
                            setDrawn(false);
                            if (!playing) after(FRAME_RETRY_MS);
                        }}
                    />
                    {trying ? (
                        <video
                            ref={video}
                            // Keyed on the format so swapping really re-creates the
                            // element: a <video> handed a new src after an error
                            // keeps the error and never tries again.
                            key={transport}
                            src={streamSrc(camera.id, "main", transport)}
                            className={cn("absolute inset-0 w-full bg-black", surface, !playing && "invisible")}
                            autoPlay
                            muted
                            playsInline
                            controls={false}
                            // Each of these is the stream saying it is still
                            // coming, which is what the clock above is against.
                            onLoadStart={stirred}
                            onLoadedMetadata={stirred}
                            onProgress={stirred}
                            onCanPlay={stirred}
                            onPlaying={() => setPlaying(true)}
                            onError={failed}
                        />
                    ) : null}

                    {drawn === false && !playing ? (
                        <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/70">
                            <Camera className="size-6 shrink-0" />
                            <span className="text-[12px]">This camera is not answering</span>
                        </span>
                    ) : null}

                    {/* Said out loud, because otherwise it is not sayable. The
                        stream failing looks exactly like a camera that is slow:
                        pictures keep arriving, nothing goes red, and the reader
                        is left deciding between "this is what live means here"
                        and "something is broken". It took three reports to
                        establish which. */}
                    {!trying && drawn ? (
                        <span className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white/80">
                            <Camera className="size-3.5 shrink-0" />
                            Pictures only - the live stream would not start
                            <button
                                type="button"
                                className="pointer-events-auto underline underline-offset-2"
                                onClick={() => {
                                    setTransport(preferredTransport());
                                    setSwapped(false);
                                    setTrying(true);
                                }}
                            >
                                Try again
                            </button>
                        </span>
                    ) : null}

                    {/* Over the picture, and faded until somebody is actually
                        looking for them - a live view with a bar of chrome across
                        it is a smaller live view. */}
                    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent p-3 pr-12 opacity-0 transition-opacity group-hover/frame:opacity-100">
                        <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-white" title={camera.name}>{camera.name}</p>
                            {camera.zone ? <p className="truncate text-[11px] text-white/70" title={camera.zone}>{camera.zone}</p> : null}
                        </div>
                    </div>

                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={full ? "Leave fullscreen" : "Fullscreen"}
                        title={full ? "Leave fullscreen" : "Fullscreen"}
                        className="absolute bottom-3 left-3 text-white/80 opacity-0 transition-opacity hover:bg-white/15 hover:text-white group-hover/frame:opacity-100"
                        onClick={toggleFullscreen}
                    >
                        {full ? <Minimize2 className="size-4 shrink-0" /> : <Maximize2 className="size-4 shrink-0" />}
                    </Button>

                    {camera.ptz && canControl ? <PtzPad cameraId={camera.id} /> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}
