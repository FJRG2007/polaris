"use client";

import { useEffect, useRef, useState, type AnimationEvent } from "react";

/** Longest an exit may take before the element goes anyway: a tab in the
 *  background, or an element that never animated, sends no `animationend`. */
const EXIT_MOST_MS = 400;

/**
 * Keeps an element mounted while it animates out, the way Radix's Presence
 * does for a dialog: `mounted` stays true after `open` turns false until the
 * closing animation ends, and `state` is what the CSS keys its animation on.
 * Give the element `onAnimationEnd`.
 */
export function useExitPresence(open: boolean): {
    mounted: boolean;
    state: "open" | "closed";
    onAnimationEnd: (event: AnimationEvent) => void;
} {
    const [mounted, setMounted] = useState(open);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => {
        clearTimeout(timer.current);
        if (open) return setMounted(true);
        timer.current = setTimeout(() => setMounted(false), EXIT_MOST_MS);
        return () => clearTimeout(timer.current);
    }, [open]);
    const onAnimationEnd = (event: AnimationEvent) => {
        // An animation inside the element bubbles here too; only its own counts.
        if (open || event.target !== event.currentTarget) return;
        clearTimeout(timer.current);
        setMounted(false);
    };
    return { mounted: open || mounted, state: open ? "open" : "closed", onAnimationEnd };
}
