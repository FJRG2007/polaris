"use client";

/**
 * What a shared screen is arriving at, said on its tile: "720P 30FPS".
 *
 * Read off the picture being drawn rather than asked of the sender. What
 * somebody chose to send and what reaches this browser differ by exactly the
 * thing the reader wants to know - a share sent at 1080p and thinned to 720p on
 * the way, or a film that has dropped to twelve frames a second - and the
 * `<video>` element knows both: its height, and how many frames it has painted.
 */

import { useEffect, useState, type RefObject } from "react";

export interface StreamFormat {
    readonly height: number;
    readonly fps: number;
}

/**
 * The format from two readings a known time apart.
 *
 * Null until there is a picture and a frame count to compare: a tile that has
 * not drawn anything yet says nothing rather than "0P 0FPS".
 */
export function streamFormat(
    height: number,
    framesBefore: number | null,
    framesNow: number | null,
    seconds: number
): StreamFormat | null {
    if (height <= 0 || framesBefore === null || framesNow === null || seconds <= 0) return null;
    const fps = Math.max(0, Math.round((framesNow - framesBefore) / seconds));
    return { height, fps };
}

/** How often the reading is taken. A second is the unit the number is in. */
const READ_EVERY_MS = 1000;

function paintedFrames(element: HTMLVideoElement): number | null {
    return typeof element.getVideoPlaybackQuality === "function"
        ? element.getVideoPlaybackQuality().totalVideoFrames
        : null;
}

/**
 * The format of what the video element is showing, read once a second while
 * `enabled`. Null while it is not, and in a browser that does not count frames.
 */
export function useStreamFormat(
    video: RefObject<HTMLVideoElement | null>,
    enabled: boolean
): StreamFormat | null {
    const [format, setFormat] = useState<StreamFormat | null>(null);
    useEffect(() => {
        if (!enabled) {
            setFormat(null);
            return;
        }
        let before: { frames: number | null; at: number } | null = null;
        const read = () => {
            const element = video.current;
            if (!element) return;
            const now = { frames: paintedFrames(element), at: performance.now() };
            if (before) {
                const next = streamFormat(
                    element.videoHeight,
                    before.frames,
                    now.frames,
                    (now.at - before.at) / 1000
                );
                setFormat((was) =>
                    was?.height === next?.height && was?.fps === next?.fps ? was : next
                );
            }
            before = now;
        };
        read();
        const timer = setInterval(read, READ_EVERY_MS);
        return () => clearInterval(timer);
    }, [video, enabled]);
    return format;
}
