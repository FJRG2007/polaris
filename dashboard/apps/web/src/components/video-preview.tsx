"use client";

/**
 * A video in a list, which is mostly a video nobody is going to watch.
 *
 * The reason this is not simply a player: a conversation is a list of forty
 * messages, and a player per video means the browser opening forty connections
 * and pulling at least the head of every file the moment the room is opened.
 * With a handful of screen clips in a channel that is tens of megabytes fetched
 * so that somebody can read the text above them. At the scale this is built for
 * it is also tens of megabytes per reader per open, off somebody's own disk.
 *
 * So nothing is fetched until it is asked for. What is drawn is a still of the
 * thing with a play button on it, and pressing it opens the video over the
 * conversation - which is what every messenger settled on, and for a reason
 * worth stating: a video playing in a list is a video the size of a message,
 * beside the thing that is about to scroll it out of view. The moment somebody
 * presses play they have stopped reading, and the screen should say so.
 *
 * A local file being staged in a composer is the one exception, and it is passed
 * `eager`: those bytes are already in this browser, there is no request to
 * avoid, and somebody who has just attached a video wants to see that it is the
 * right one without opening anything.
 */

import { cn } from "@polaris/ui";
import { Play } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { VideoViewer } from "@/components/video-viewer";
import { MediaPlayer } from "@/components/media-player";

/** Bytes as a person reads them. Kept local rather than imported so this can be
 *  dropped into any screen without dragging a formatter with it. */
function readable(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function VideoPreview({
    src,
    name,
    size,
    download,
    poster,
    eager = false,
    className
}: {
    src: string;
    /** What it is called, drawn on the frame before anything is fetched. */
    name?: string;
    /** How big it is, for the same reason: it is the one fact that decides
     *  whether somebody presses play on a phone. */
    size?: number;
    /** Where to save it from, handed to the player once there is one. */
    download?: string;
    poster?: string;
    /** Draw the player straight away. For bytes that are already here. */
    eager?: boolean;
    className?: string;
}) {
    const [watching, setWatching] = useState(false);

    // Bytes that are already here: drawn as the player itself, in place. There
    // is nothing to fetch and nothing to open - it is being looked at by the
    // person who just attached it.
    if (eager) {
        return (
            <MediaPlayer
                kind="video"
                src={src}
                name={name}
                poster={poster}
                download={download}
                preload="metadata"
                className={cn("overflow-hidden rounded-md border border-border bg-black", className)}
            />
        );
    }

    return (
        <>
            {watching &&
                typeof document !== "undefined" &&
                // On the body rather than here: the viewer covers the window,
                // and this sits inside a scrolling list that a fixed child would
                // be positioned and clipped by.
                createPortal(
                    <VideoViewer
                        src={src}
                        name={name}
                        poster={poster}
                        download={download}
                        onClose={() => setWatching(false)}
                    />,
                    document.body
                )}
            <button
                type="button"
            onClick={() => setWatching(true)}
            aria-label={name ? `Play ${name}` : "Play the video"}
            className={cn(
                "group relative flex aspect-video w-full max-w-md items-center justify-center overflow-hidden rounded-md border border-border bg-black/80 transition-colors hover:bg-black",
                className
            )}
            style={poster ? { backgroundImage: `url(${poster})`, backgroundSize: "cover" } : undefined}
        >
            <span className="grid size-14 place-items-center rounded-full bg-black/60 ring-1 ring-white/30 transition-transform group-hover:scale-105">
                <Play className="size-6 translate-x-0.5 fill-white text-white" />
            </span>
            {(name || size !== undefined) && (
                <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 text-left text-[0.6875rem] text-white/90">
                    <span className="truncate" title={name}>
                        {name}
                    </span>
                    {size !== undefined && <span className="shrink-0">{readable(size)}</span>}
                </span>
            )}
            </button>
        </>
    );
}
