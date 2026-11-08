"use client";

/**
 * Whether the person playing has stepped away from the game: its tab hidden, or
 * the window in the background (another program in front, another window
 * focused), for longer than a moment. A game frame inside this page keeps the
 * page focused, so playing never reads as away. Back is at once.
 */

import { useEffect, useState } from "react";

/** How long hidden or in the background before it counts as away. */
export const AWAY_AFTER_MS = 60_000;

/** Pure, for the tests: away once the page has been out of view this long. */
export function awayAt(outOfViewSince: number | null, now: number): boolean {
    return outOfViewSince !== null && now - outOfViewSince >= AWAY_AFTER_MS;
}

export function useGameAway(): boolean {
    const [away, setAway] = useState(false);
    useEffect(() => {
        let since: number | null = null;
        let timer: number | undefined;
        const check = () => {
            const out = document.visibilityState === "hidden" || !document.hasFocus();
            window.clearTimeout(timer);
            if (!out) {
                since = null;
                setAway(false);
                return;
            }
            since ??= Date.now();
            const now = Date.now();
            setAway(awayAt(since, now));
            if (!awayAt(since, now)) timer = window.setTimeout(check, since + AWAY_AFTER_MS - now);
        };
        check();
        document.addEventListener("visibilitychange", check);
        window.addEventListener("focus", check);
        window.addEventListener("blur", check);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener("visibilitychange", check);
            window.removeEventListener("focus", check);
            window.removeEventListener("blur", check);
        };
    }, []);
    return away;
}
