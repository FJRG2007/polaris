"use client";

/**
 * What a shared screen is arriving at, said on its tile: "720P 30FPS".
 *
 * Read off the picture being drawn rather than asked of the sender. What
 * somebody chose to send and what reaches this browser differ by exactly the
 * thing the reader wants to know - a share sent at 1080p and thinned to 720p on
 * the way, or a film that has dropped to twelve frames a second - and the
 * `<video>` element knows both: its height, and how many frames it has painted.
 *
 * The rate is said as a standard one (15, 24, 30, 60) and held. A shared screen
 * only sends a frame when something on it changes, so a still page paints one
 * or two a second while it looks perfect, and a tile that said "1FPS" over it
 * read as broken. Seconds with nothing moving say nothing about the rate and are
 * left out; the number only comes down when moving frames keep arriving slower.
 */

import { useEffect, useState, type RefObject } from "react";

export interface StreamFormat {
    readonly height: number;
    readonly fps: number;
}

/** What the tile says: the height, and a standard rate once one is known. */
export interface ShownFormat {
    readonly height: number;
    readonly fps: number | null;
}

/** The rates a stream is said to run at. */
const STANDARD_FPS = [15, 24, 30, 60] as const;
/** Below this, a second had too little moving on it to say anything. */
const MOVING_FROM_FPS = 10;
/** Moving seconds in a row below the shown rate before it comes down. */
const DROP_AFTER = 10;

/** The standard rate nearest a measured one; a tie goes up. */
export function standardRate(fps: number): number {
    return STANDARD_FPS.reduce((best, rate) =>
        Math.abs(rate - fps) <= Math.abs(best - fps) ? rate : best
    );
}

export interface SteadyRate {
    readonly shown: number | null;
    /** Moving readings below `shown` since it was last met. */
    readonly lower: readonly number[];
}

export const NO_RATE: SteadyRate = { shown: null, lower: [] };

/** Fold one second's measured rate into the rate the tile says. */
export function steadyRate(state: SteadyRate, measured: number): SteadyRate {
    if (measured < MOVING_FROM_FPS) return state;
    const rate = standardRate(measured);
    if (state.shown === null || rate >= state.shown) return { shown: rate, lower: [] };
    const lower = [...state.lower, rate];
    return lower.length >= DROP_AFTER ? { shown: Math.max(...lower), lower: [] } : { ...state, lower };
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
): ShownFormat | null {
    const [format, setFormat] = useState<ShownFormat | null>(null);
    useEffect(() => {
        if (!enabled) {
            setFormat(null);
            return;
        }
        let before: { frames: number | null; at: number } | null = null;
        let rate = NO_RATE;
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
                if (next) rate = steadyRate(rate, next.fps);
                const shown = next ? { height: next.height, fps: rate.shown } : null;
                setFormat((was) =>
                    was?.height === shown?.height && was?.fps === shown?.fps ? was : shown
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
