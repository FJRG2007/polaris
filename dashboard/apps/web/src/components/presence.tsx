"use client";

/**
 * Whether someone is here right now, from the last activity recorded against them.
 *
 * Two screens ask this and both used to answer it from a `Date.now()` read once at
 * render: the answer was right when the page loaded and then froze, so "Active now"
 * stayed on the screen long after the person had gone and a fresh visit needed a
 * reload to appear. The clock below ticks instead.
 */

import { useEffect, useState } from "react";

/**
 * How recent activity has to be to count as being here.
 *
 * A signed-in session records activity at most once a minute (see session-guard's
 * ACTIVITY_WRITE_INTERVAL_MS), so anything under two minutes would flicker off
 * between two writes for someone who never left. Three gives that write a chance to
 * be late without calling a present person absent.
 */
export const ONLINE_WINDOW_MS = 3 * 60_000;

/** A clock that re-renders its component on an interval. */
export function useNow(intervalMs = 15_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}

/** Whether a timestamp counts as present, against a clock the caller owns. */
export function isOnline(iso: string | null | undefined, now: number, windowMs = ONLINE_WINDOW_MS) {
    if (!iso) return false;
    const at = new Date(iso).getTime();
    return Number.isFinite(at) && now - at < windowMs;
}

/** The green dot that marks someone as present. */
export function OnlineDot({ className }: { className?: string }) {
    return (
        <span
            aria-hidden
            className={`inline-block size-2 shrink-0 rounded-full bg-success ${className ?? ""}`}
        />
    );
}
