"use client";

/**
 * The shell's content area: the one box under the header that scrolls.
 *
 * The browser only restores the window's scroll on back/forward and only sends
 * Space/PageDown/arrows to the window when nothing has focus - and under
 * AppShell the window does not scroll. So this box does both itself: it keeps
 * its scroll position per address and puts it back when the user returns to
 * one, and a scrolling key pressed while nothing has focus moves focus here
 * first, so the keyboard scrolls the content rather than nothing.
 */

import { cn } from "../lib/cn";
import { useEffect, useRef, type ReactNode } from "react";

/** How long a return keeps trying to reach its old position while the screen
 *  it left is still rendering in, in frames. */
const RESTORE_FRAMES = 60;

/** The keys a browser scrolls with when nothing has focus. */
const SCROLL_KEYS = new Set([" ", "PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"]);

const here = () => `${location.pathname}${location.search}`;

export function ShellMain({ className, children }: { className?: string; children: ReactNode }) {
    const ref = useRef<HTMLElement>(null);

    useEffect(() => {
        const main = ref.current;
        if (!main) return;
        const saved = new Map<string, number>();
        let recordFrame = 0;
        let restoreFrame = 0;

        const record = () => {
            if (recordFrame) return;
            recordFrame = requestAnimationFrame(() => {
                recordFrame = 0;
                saved.set(here(), main.scrollTop);
            });
        };
        const stopRestoring = () => {
            cancelAnimationFrame(restoreFrame);
            restoreFrame = 0;
        };
        const onPop = () => {
            stopRestoring();
            const target = location.hash ? undefined : saved.get(here());
            if (target === undefined) return;
            let frames = 0;
            const step = () => {
                main.scrollTop = target;
                frames += 1;
                restoreFrame =
                    Math.abs(main.scrollTop - target) > 1 && frames < RESTORE_FRAMES
                        ? requestAnimationFrame(step)
                        : 0;
            };
            restoreFrame = requestAnimationFrame(step);
        };
        const onKey = (event: KeyboardEvent) => {
            stopRestoring();
            const focused = document.activeElement;
            if (focused && focused !== document.body) return;
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
            if (SCROLL_KEYS.has(event.key)) main.focus({ preventScroll: true });
        };

        main.addEventListener("scroll", record, { passive: true });
        window.addEventListener("popstate", onPop);
        window.addEventListener("keydown", onKey);
        const interrupts = ["wheel", "touchstart", "pointerdown"] as const;
        for (const type of interrupts) window.addEventListener(type, stopRestoring, { passive: true });
        return () => {
            cancelAnimationFrame(recordFrame);
            stopRestoring();
            main.removeEventListener("scroll", record);
            window.removeEventListener("popstate", onPop);
            window.removeEventListener("keydown", onKey);
            for (const type of interrupts) window.removeEventListener(type, stopRestoring);
        };
    }, []);

    return (
        <main ref={ref} data-shell-scroll="" tabIndex={-1} className={cn("outline-none", className)}>
            {children}
        </main>
    );
}
