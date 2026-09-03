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
 * Over all of it, whatever the detector is following right now. A tile fills its
 * frame rather than letterboxing it, so the boxes are told that - placed against
 * the whole tile they would sit off to one side of a camera whose shape is not
 * the tile's.
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
import type { LiveBox } from "@polaris/core";
import { DetectionBox } from "./detection-box";
import { boxLabel } from "./detection-label";
import { onBattery } from "@/lib/home/vendors";
import { quietSince } from "@/lib/home/availability";
import { useDisplayFormat } from "@/components/display-format";
import {
    otherTransport,
    preferredTransport,
    stillSrc,
    streamSrc,
    type Transport
} from "@/lib/home/player";

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
 * How long the stream may say nothing at all before it is written off.
 *
 * Silence is the failure this catches: a request that connects and never sends
 * a playable frame raises no error, and the element waits forever.
 *
 * It is silence that is timed, not the wait for a picture, and the difference is
 * the whole bug it replaces. A camera here takes about fourteen seconds between
 * the request and the first frame the browser will show - the browser fills a
 * buffer before it starts, and that is not a fault, it is what a progressive
 * stream costs. Timed as "how long until it plays", every such camera was
 * declared dead a few seconds before it would have played, every time, and the
 * viewer sat on still pictures for good. Timed as "how long since anything
 * happened", a stream that is loading is left alone and a stream that is not
 * still fails quickly.
 */
const VIDEO_SILENCE_MS = 9_000;

/** The frame is drawn a few hundred pixels wide, so that is what is asked for.
 *  A camera's own frame is several thousand pixels across - sending that to fill
 *  a postcard is most of a megabyte, over and over, on somebody's phone. */
const FRAME_WIDTH = 640;

/** The shape every tile is drawn at, from the `aspect-video` below. The picture
 *  inside it is rarely the same shape, and the boxes need both to be placed. */
const TILE_SHAPE = 16 / 9;

export function CameraTile({
    camera,
    live,
    boxes,
    canControl,
    idle,
    onOpen
}: {
    camera: CameraView;
    /** Whether the relay is serving this camera at all. */
    live: boolean;
    /** What the detector is following on this camera, if anything. Handed down
     *  rather than asked for here: the wall asks once for all of them. */
    boxes?: readonly LiveBox[];
    canControl: boolean;
    /**
     * Whether to stop and hold the last picture.
     *
     * Set while somebody has another camera open. A wall of six tiles is six
     * connections to the relay and six cameras kept awake, and every one of them
     * is competing with the one being watched - on the same link, through the
     * same relay, for the same upstream. Somebody who opened one camera is
     * looking at one camera.
     *
     * Stopped rather than hidden: the request really ends, so the relay lets go
     * of the camera. What stays is the frame that was already on screen, held
     * and blurred, which is enough to see that a tile is there and not enough to
     * pretend it is live.
     */
    idle: boolean;
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
    /** The camera's own shape, width over height, learned from whichever of the
     *  two is on screen. Null until one has arrived. */
    const [shape, setShape] = useState<number | null>(null);
    const format = useDisplayFormat();
    /** When this camera stopped answering, in the reader's own format, or null
     *  while it is answering. Read off the row rather than from what this tab
     *  managed to draw, so it survives a reload and says the same thing on every
     *  screen looking at the house - and only once the silence has outlasted the
     *  grace window, so a camera rebooting for a firmware check does not turn a
     *  tile red for the one pass it takes to come back. */
    const quiet = quietSince(camera.offlineSince);
    const since = quiet ? format.dateTime(quiet.toISOString()) : null;

    const frame = useRef<HTMLDivElement | null>(null);
    const video = useRef<HTMLVideoElement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Whether this camera pays for the wall out of its own charge.
     *
     * Everything below assumes a camera on a wire, where a tile costs the relay
     * a connection and the camera nothing. A battery camera is the opposite: the
     * connection IS the cost, and a wall left open on one is a camera that is
     * flat by morning. So it gets one frame and then stops, and the live stream
     * is not started at all until somebody opens it.
     */
    const battery = onBattery(camera.vendor);

    const showing = camera.enabled && live;
    // `drawn` is null only until the first frame settles, so a battery camera
    // asks once - whether that frame arrived or not - and then leaves the camera
    // alone rather than retrying on a timer nobody asked for.
    const wantFrames = showing && visible && !playing && !idle && !(battery && drawn !== null);

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

    /**
     * Anything the element does that proves the stream is alive.
     *
     * Bumped by the events a loading stream fires, and read by the watchdog
     * below - so the clock is against silence rather than against the picture.
     */
    const [alive, setAlive] = useState(0);
    const stirred = () => setAlive((value) => value + 1);

    useEffect(() => {
        if (!attempt || playing || !wantFrames) return;
        const watchdog = setTimeout(failed, VIDEO_SILENCE_MS);
        return () => clearTimeout(watchdog);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- restarting the
        // clock is the point whenever what is being tried changes, and whenever
        // the stream shows a sign of life.
    }, [attempt, transport, playing, wantFrames, alive]);

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
        if (visible && showing && !idle) return;
        const element = video.current;
        if (!element) return;
        element.pause();
        element.removeAttribute("src");
        element.load();
        setPlaying(false);
    }, [visible, showing, idle]);

    /**
     * One last frame on the way to standing still.
     *
     * The picture that is held is whichever frame happened to be loaded last,
     * and while the stream was playing that was minutes ago - the tile would
     * freeze on a stale image and look like a camera that had stopped. Asking
     * for one more costs a single request and makes the held frame the moment
     * everything stopped.
     */
    useEffect(() => {
        if (!idle || !showing) return;
        setStamp((value) => value + 1);
    }, [idle, showing]);

    return (
        <div
            ref={frame}
            className="group relative overflow-hidden rounded-lg border border-border bg-card"
        >
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
                            className={cn(
                                "absolute inset-0 size-full object-cover transition-[filter,opacity]",
                                playing && "opacity-0",
                                // Held rather than live, and it has to look it:
                                // a still frame at full sharpness is a camera
                                // that appears to be working and is not moving.
                                idle && "opacity-60 blur-[3px] saturate-50"
                            )}
                            onLoad={(loaded) => {
                                setDrawn(true);
                                const { naturalWidth, naturalHeight } = loaded.currentTarget;
                                if (naturalWidth > 0 && naturalHeight > 0) {
                                    setShape(naturalWidth / naturalHeight);
                                }
                                if (wantFrames) after(attempt ? FRAME_GAP_MS : COLD_GAP_MS);
                            }}
                            onError={() => {
                                setDrawn(false);
                                if (wantFrames) after(FRAME_RETRY_MS);
                            }}
                        />
                        {attempt && visible && !idle && !battery ? (
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
                                // Every one of these is the stream saying it is
                                // still coming. Without them the clock below runs
                                // against a camera that is merely loading.
                                onLoadStart={stirred}
                                onLoadedMetadata={(loaded) => {
                                    stirred();
                                    const { videoWidth, videoHeight } = loaded.currentTarget;
                                    if (videoWidth > 0 && videoHeight > 0) {
                                        setShape(videoWidth / videoHeight);
                                    }
                                }}
                                onProgress={stirred}
                                onCanPlay={stirred}
                                onPlaying={() => setPlaying(true)}
                                onError={failed}
                            />
                        ) : null}
                        {showing && visible && !idle
                            ? (boxes ?? []).map((found) => (
                                  <DetectionBox
                                      key={found.id}
                                      box={found.box}
                                      label={boxLabel(found.label, found.score)}
                                      picture={shape}
                                      tile={TILE_SHAPE}
                                      fit="cover"
                                  />
                              ))
                            : null}
                        {drawn === false && !playing ? (
                            <Placeholder
                                icon={<Camera className="size-5 shrink-0" />}
                                label={
                                    // A battery camera is asleep far more often
                                    // than it is broken, and it is never probed
                                    // on a timer - so there is no outage clock
                                    // behind it and "not answering" would be
                                    // saying something Polaris does not know.
                                    battery
                                        ? "Asleep. Open it to wake it."
                                        : since
                                          ? `Not answering since ${since}`
                                          : "Not answering"
                                }
                            />
                        ) : null}
                        {/* Said, not just drawn. A blurred still is ambiguous -
                            it reads as a camera that has gone wrong as easily as
                            one that was deliberately stopped - and the reader is
                            the person who stopped it. */}
                        {idle && drawn !== false ? (
                            <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-elevated/90 px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
                                Paused
                            </span>
                        ) : null}
                        {/* The same reasoning as Paused: the picture is a moment
                            old and looks live, and the reader deserves to know
                            which. It also answers the question the tile
                            provokes - why this one is not moving when the rest
                            of the wall is. */}
                        {battery && !idle && drawn !== false ? (
                            <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-elevated/90 px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
                                On battery - open it to watch
                            </span>
                        ) : null}
                    </>
                ) : (
                    <Unavailable camera={camera} live={live} since={since} />
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
                        className="block max-w-full truncate text-left text-[0.8125rem] font-medium text-foreground hover:underline"
                    >
                        {camera.name}
                    </button>
                    {camera.zone ? (
                        <p
                            className="truncate text-[0.6875rem] text-foreground-subtle"
                            title={camera.zone}
                        >
                            {camera.zone}
                        </p>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {/* Only over a tile that is not drawing. A frame arriving is
                        the camera answering, whatever the row still says - the
                        pass has not run since - and a red badge over a moving
                        picture reads as a bug. */}
                    {since && drawn !== true && !playing ? (
                        <Badge variant="danger" title={`Not answering since ${since}`}>
                            Quiet
                        </Badge>
                    ) : null}
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

/**
 * Why there is no picture, said specifically enough to act on.
 *
 * "Not answering" on its own is the same sentence for a camera that missed one
 * frame and for one that has been dark since the small hours, and only the
 * second is worth getting out of bed for. Polaris already knows which this is -
 * the availability pass writes down when it stopped - so the tile says it.
 */
function Unavailable({
    camera,
    live,
    since
}: {
    camera: CameraView;
    live: boolean;
    since: string | null;
}) {
    if (!camera.enabled)
        return <Placeholder icon={<VideoOff className="size-5 shrink-0" />} label="Switched off" />;
    if (since)
        return (
            <Placeholder
                icon={<Camera className="size-5 shrink-0" />}
                label={`Not answering since ${since}`}
            />
        );
    if (!live)
        return <Placeholder icon={<Camera className="size-5 shrink-0" />} label="Starting" />;
    return <Placeholder icon={<Camera className="size-5 shrink-0" />} label="Not answering" />;
}

function Placeholder({ icon, label }: { icon: React.ReactNode; label: string }) {
    return (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-background text-foreground-subtle">
            {icon}
            <span className="text-[0.6875rem]">{label}</span>
        </span>
    );
}
