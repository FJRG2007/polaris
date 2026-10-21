"use client";

/**
 * The shell's content area: the one box under the header that scrolls.
 *
 * The browser only restores the window's scroll on back/forward and only sends
 * Space/PageDown/arrows to the window when nothing has focus - and under
 * AppShell the window does not scroll. So this box does both itself: it keeps
 * its scroll position per address and puts it back when the user returns to
 * one, and a scrolling key pressed while nothing has focus moves focus here
 * first, so the keyboard scrolls the content rather than nothing. Only that
 * key makes the box focusable, and a pointer press or a blur takes it back, so
 * a click on the page still leaves focus on the body as it would anywhere else.
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
            if (!SCROLL_KEYS.has(event.key)) return;
            main.tabIndex = -1;
            main.focus({ preventScroll: true });
        };
        const release = () => {
            if (!main.hasAttribute("tabindex")) return;
            if (document.activeElement === main) main.blur();
            main.removeAttribute("tabindex");
        };

        main.addEventListener("scroll", record, { passive: true });
        window.addEventListener("popstate", onPop);
        window.addEventListener("keydown", onKey);
        main.addEventListener("blur", release);
        window.addEventListener("pointerdown", release, { capture: true, passive: true });
        const interrupts = ["wheel", "touchstart", "pointerdown"] as const;
        for (const type of interrupts)
            window.addEventListener(type, stopRestoring, { passive: true });
        return () => {
            cancelAnimationFrame(recordFrame);
            stopRestoring();
            main.removeEventListener("scroll", record);
            window.removeEventListener("popstate", onPop);
            window.removeEventListener("keydown", onKey);
            main.removeEventListener("blur", release);
            window.removeEventListener("pointerdown", release, { capture: true });
            for (const type of interrupts) window.removeEventListener(type, stopRestoring);
        };
    }, []);

    return (
        <main ref={ref} data-shell-scroll="" className={cn("outline-none", className)}>
            {children}
        </main>
    );
}
