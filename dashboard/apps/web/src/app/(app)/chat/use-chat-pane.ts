"use client";

/**
 * One side panel's width: what was remembered, what the row has room for, and
 * the three ways it changes - dragged, put back, or put back with the rest of
 * the layout.
 *
 * Every panel in Chat had its own copy of this, and a fourth copy is where a
 * panel starts forgetting to listen for "Reset layout".
 */

import { usePaneCeiling } from "./pane-room";
import { useCallback, useEffect, useState } from "react";
import { forgetPaneSize, onLayoutReset, readPaneSize, savePaneSize } from "./pane-preferences";

export interface PaneBounds {
    readonly min: number;
    readonly max: number;
    readonly fallback: number;
}

/**
 * The chat beside a call - a voice channel's or a meeting's. One width for both,
 * because they are the same column: the record of a room, narrow on purpose, and
 * somebody who widened it in one expects it wide in the other.
 */
export const CALL_CHAT_PANE: PaneBounds = { min: 260, max: 560, fallback: 320 };

export function useChatPane(pane: string, bounds: PaneBounds) {
    const { min, max, fallback } = bounds;
    const [width, setWidth] = useState(fallback);
    // What the row can actually spare, which is not the same as what the panel
    // may be: a width remembered from a wider window would otherwise arrive here
    // and take it out of the conversation.
    const { ceiling, measure } = usePaneCeiling({ min, max });

    // After the first paint: there is no localStorage on the server, and a width
    // read during render would not match what was sent.
    useEffect(
        () => setWidth(readPaneSize(pane, { min, max, fallback })),
        [pane, min, max, fallback]
    );

    useEffect(() => onLayoutReset(() => setWidth(fallback)), [fallback]);

    const resize = useCallback(
        (size: number) => {
            setWidth(size);
            // Settled rather than written per pixel - see `savePaneSize`.
            savePaneSize(pane, size);
        },
        [pane]
    );

    const reset = useCallback(() => {
        forgetPaneSize(pane);
        setWidth(fallback);
    }, [pane, fallback]);

    /** What is on screen: what somebody chose, held to what there is room for.
     *  The choice itself is left alone, so it comes back with the room. */
    const drawn = Math.min(width, ceiling);

    return { drawn, ceiling, measure, resize, reset, min };
}
