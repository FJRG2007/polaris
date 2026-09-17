"use client";

/**
 * What the cameras are looking at, kept current for as long as somebody is.
 *
 * Polled rather than pushed, and that is a deliberate trade. A stream per open
 * camera would be a connection held open per tile on a wall of twelve, each one
 * for a message that arrives during the few seconds a day something is actually
 * in front of that camera. A poll costs one small request while somebody is
 * watching and nothing at all the moment they look away, which is the shape of
 * the thing being asked for.
 *
 * Every camera on screen in one ask. A hook per tile would be a request per tile
 * and the cost would grow with the size of the wall; this way a wall of twelve
 * costs what a wall of one does.
 *
 * Paced by arrival, like the frames beside it: the next ask is scheduled when
 * the last answer lands, so a slow link stretches the gap by itself instead of
 * queueing requests that overtake each other.
 *
 * The rectangle is a little ahead of the picture, and there is no fixing that
 * from here. A browser buffers a second or two of video before it shows any of
 * it, and a still is whatever the relay last decoded - so the position is true
 * before the frame it belongs to is on screen. It is the same second-or-so every
 * camera system has, it reads as a box that leads slightly rather than as a box
 * in the wrong place, and the alternative - holding positions back to match a
 * buffer nobody can measure - would be guessing.
 */

import type { LiveBox } from "@polaris/core";
import { useEffect, useMemo, useState } from "react";

/** How soon after one answer the next is asked for. Twice a second: the
 *  detector publishes five times that, and a rectangle redrawn twice a second
 *  reads as following somebody rather than as jumping after them. */
const GAP_MS = 500;

/** The same, after an answer that did not arrive. A dashboard that has gone away
 *  must not be asked twice a second whether it is back. */
const RETRY_MS = 5_000;

const NOTHING: Readonly<Record<string, readonly LiveBox[]>> = {};

/** Where everything is, by camera. A camera with nothing in front of it is not
 *  in the answer at all, so callers read it with a fallback. */
export function useDetections(
    cameraIds: readonly string[],
    active: boolean
): Readonly<Record<string, readonly LiveBox[]>> {
    const [found, setFound] = useState<Readonly<Record<string, readonly LiveBox[]>>>(NOTHING);
    // The list is rebuilt on every render by every caller, so the effect below
    // is keyed on what is actually in it rather than on the array's identity -
    // otherwise the poll restarts several times a second and never completes.
    const key = useMemo(() => [...cameraIds].sort().join(","), [cameraIds]);

    useEffect(() => {
        if (!active || !key) {
            // Cleared rather than held. What is on screen when somebody stops
            // watching is a frame from a moment ago, and a rectangle left on top
            // of it is the one thing this must never draw: a box around a place
            // where there is no longer anybody.
            setFound(NOTHING);
            return;
        }

        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const controller = new AbortController();

        const ask = async () => {
            let next = GAP_MS;
            try {
                const response = await fetch(
                    `/api/home/cameras/detections?ids=${encodeURIComponent(key)}`,
                    { signal: controller.signal, cache: "no-store" }
                );
                if (response.ok) {
                    const body = (await response.json()) as {
                        boxes?: Record<string, LiveBox[]>;
                    };
                    if (!stopped) setFound(body.boxes ?? NOTHING);
                } else {
                    next = RETRY_MS;
                    if (!stopped) setFound(NOTHING);
                }
            } catch {
                // Aborted by the cleanup below, or the dashboard is unreachable.
                // Either way there is nothing to draw and nothing to say: the
                // picture is still there, and a camera view is not the screen
                // that reports that Polaris is having a bad time.
                next = RETRY_MS;
            }
            if (stopped) return;
            timer = setTimeout(() => void ask(), next);
        };

        void ask();
        return () => {
            stopped = true;
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [key, active]);

    return found;
}
