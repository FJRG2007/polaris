"use client";

/**
 * The picture on a tile, and the icon it falls back to.
 *
 * The rule the whole thumbnail path is built on is that an original is read at
 * most once, ever - and this is the half of it that decides when "once"
 * happens. Nothing is requested while a folder is listed. A tile watches for
 * itself coming near the screen and asks then, so scrolling straight through a
 * folder of four hundred photographs opens none of them.
 *
 * Everything else here is about not making it worse than the icon it replaces:
 *
 *   - A name that can never have a picture never renders an image at all, so it
 *     costs no request to find that out.
 *   - The icon is what is drawn until a picture arrives, and what it goes back
 *     to if none does. There is no spinner and no empty box: a tile that is
 *     thinking looks exactly like a tile that has finished, because the answer
 *     is usually "keep the icon" and a flicker between the two is worse than
 *     either.
 *   - The version is in the URL, so the browser can hold the answer for a year
 *     and an edited file is a different address rather than a stale picture.
 *
 * A video is the exception, and it is drawn here rather than on the server. The
 * server would have to hold a decoder to open one, and the browser already has
 * one: it is handed the address of the file, asked for the metadata and one
 * frame a moment in, and it fetches only the bytes it needs to answer - the
 * download route honours Range, so a four-gigabyte film costs the first chunk of
 * it and nothing else. A tenth of a second in rather than the very first frame,
 * which in most recordings is black.
 */

import { cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";

/** How far ahead of the viewport a tile starts asking. Roughly one screen, so
 *  the picture is usually there by the time somebody scrolls to it, and a fast
 *  scroll past still opens nothing. */
const LOOKAHEAD = "300px";

/** How big a still taken out of a video is kept. The tile is small, and a
 *  full-size frame would be held in memory once per file in the folder. */
const STILL_EDGE = 320;

export function EntryThumbnail({
    connectionId,
    path,
    version,
    moving = false,
    className,
    children
}: {
    readonly connectionId: string;
    readonly path: string;
    /** A video, which the browser draws for itself from the file rather than
     *  being handed a picture the server made. */
    readonly moving?: boolean;
    /** What makes this file this version of itself - when it changed and how big
     *  it is. In the URL so the answer can be cached forever and still never be
     *  wrong. */
    readonly version: string;
    readonly className?: string;
    /** The icon, drawn until a picture arrives and kept if none does. */
    readonly children: React.ReactNode;
}) {
    const holder = useRef<HTMLSpanElement>(null);
    const [asked, setAsked] = useState(false);
    const [drawn, setDrawn] = useState(false);
    /** The frame taken out of a video, once, as a still. Null for everything
     *  else and until it has been taken. */
    const [frame, setFrame] = useState<string | null>(null);

    useEffect(() => {
        // A new file in the same tile is a new question.
        setAsked(false);
        setDrawn(false);
        setFrame(null);
    }, [connectionId, path, version]);

    // The file itself for a video, which is seeked and read a frame at a time,
    // and the picture the server drew for everything else.
    const source = moving
        ? `/api/drive/download?c=${encodeURIComponent(connectionId)}&p=${encodeURIComponent(path)}`
        : `/api/drive/thumbnail?c=${encodeURIComponent(connectionId)}&p=${encodeURIComponent(path)}&v=${encodeURIComponent(version)}`;

    /**
     * Take one frame out of a video and let the video go.
     *
     * Not a `<video>` left on the tile. A media element is a page subresource:
     * a folder of clips left the browser showing its loading state - the busy
     * cursor and the spinning tab - for as long as any of them were still
     * settling, and each one held a connection and a decoder while it did. So
     * the element is made here, never rendered, asked for one frame, drawn onto
     * a canvas and torn down, and what stays on the tile is a still.
     *
     * Same-origin, so the canvas is not tainted and can be read back. A format
     * the browser cannot open fires `error` and the tile keeps its icon, which
     * is the same outcome as a picture the server could not draw.
     */
    useEffect(() => {
        if (!asked || !moving) return;
        let live = true;
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.crossOrigin = "use-credentials";
        const done = () => {
            video.removeAttribute("src");
            video.load();
        };
        const take = () => {
            if (!live) return done();
            const canvas = document.createElement("canvas");
            // The tile is small, and a full-size frame would be held in memory
            // once per file in the folder.
            const scale = Math.min(1, STILL_EDGE / Math.max(video.videoWidth || 1, 1));
            canvas.width = Math.max(1, Math.round((video.videoWidth || 1) * scale));
            canvas.height = Math.max(1, Math.round((video.videoHeight || 1) * scale));
            try {
                canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
                const still = canvas.toDataURL("image/webp", 0.7);
                if (live) setFrame(still);
            } catch {
                // A frame that cannot be read is a tile that keeps its icon.
            }
            done();
        };
        video.addEventListener("seeked", take, { once: true });
        video.addEventListener("error", done, { once: true });
        // A tenth of a second in rather than the very first frame, which in most
        // recordings is black. Seeking is what makes the browser fetch only the
        // part it needs, since the download route honours Range.
        video.addEventListener(
            "loadedmetadata",
            () => {
                if (!live) return done();
                video.currentTime = Math.min(0.1, video.duration || 0.1);
            },
            { once: true }
        );
        video.src = source;
        return () => {
            live = false;
            done();
        };
        // `source` is derived from these three and nothing else.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [asked, moving, connectionId, path, version]);

    useEffect(() => {
        if (asked) return;
        const node = holder.current;
        if (!node) return;
        // Without the observer - an old browser, a test - the tile simply asks,
        // which is the behaviour a grid had before any of this and not a
        // failure.
        if (typeof IntersectionObserver !== "function") {
            setAsked(true);
            return;
        }
        const watch = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setAsked(true);
                    watch.disconnect();
                }
            },
            { rootMargin: LOOKAHEAD }
        );
        watch.observe(node);
        return () => watch.disconnect();
    }, [asked, connectionId, path, version]);


    return (
        <span ref={holder} className={cn("relative flex items-center justify-center", className)}>
            {/* The icon is what is there until a picture is, and it goes the
                moment one arrives - whichever of the two arrived. A video's
                frame sets `frame` rather than `drawn`, and leaving the icon out
                of that put a film strip on top of the still. */}
            {drawn || frame ? null : children}
            {frame ? (
                <img
                    src={frame}
                    alt=""
                    draggable={false}
                    className="max-h-full max-w-full rounded-sm object-contain"
                />
            ) : null}
            {asked && !moving ? (
                <img
                    src={source}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onLoad={() => setDrawn(true)}
                    // A file that cannot be drawn answers 404, which is not an
                    // error: it is how a tile is told to keep its icon.
                    onError={() => setDrawn(false)}
                    className={cn(
                        "max-h-full max-w-full rounded-sm object-contain",
                        drawn ? "" : "hidden"
                    )}
                />
            ) : null}
        </span>
    );
}
