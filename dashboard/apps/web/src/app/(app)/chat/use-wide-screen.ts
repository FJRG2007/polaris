"use client";

/**
 * Whether a conversation has room for a panel beside it.
 *
 * Its own module because two panels ask - the roster and the profile beside a
 * direct message - and they must never disagree: one drawn as a column while the
 * other opens as a dialog would put two things on screen that were each written
 * to be the only one there.
 *
 * 1024 rather than the usual 768, and the reason is what is already on screen at
 * that width: the spaces rail and the conversation list take 536px of a 768px
 * screen, so a column here would leave the messages 232px - a conversation four
 * words wide. At 1024 there is 488px left for it, which is a conversation. Below
 * that the same panel opens as a dialog instead.
 */

import { useEffect, useState } from "react";

export const WIDE_ENOUGH = "(min-width: 1024px)";

/** True once there is room. False on the server and on the first paint, so
 *  nothing is drawn that is about to be taken away again. */
export function useWideScreen(): boolean {
    const [wide, setWide] = useState(false);
    useEffect(() => {
        // Guarded rather than assumed. Somewhere without media queries cannot
        // answer "is there room", and the honest answer to a question that
        // cannot be asked is the one that draws nothing: a panel that failed to
        // measure would otherwise take the conversation's width on faith.
        if (typeof window.matchMedia !== "function") return;
        const query = window.matchMedia(WIDE_ENOUGH);
        setWide(query.matches);
        const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
        query.addEventListener("change", onChange);
        return () => query.removeEventListener("change", onChange);
    }, []);
    return wide;
}
