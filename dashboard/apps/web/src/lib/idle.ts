/**
 * Whether anybody can be looking at the page: hidden, or its window not the
 * one in front.
 *
 * The desktop app keeps `backgroundThrottling` off so a call survives behind a
 * full-screen game, which also means Chromium keeps drawing every decorative
 * loop while the window sits minimized or in the tray - a sampled install spent
 * an eighth of a core in its GPU process doing that. The page cannot rely on
 * `visibilitychange` there, but the window's own `blur` does fire when it is
 * minimized, hidden or simply behind another window, so both count.
 *
 * While idle, `<html data-idle>` pauses infinite CSS animations (globals.css)
 * and `animateWhileAwake` stops script loops. Nothing here touches media or
 * call code: a paused animation is a frozen picture, never a muted stream.
 */

import { useSyncExternalStore } from "react";

export const IDLE_ATTRIBUTE = "data-idle";

const listeners = new Set<(idle: boolean) => void>();
let idle = false;
let watchers = 0;
let detach: (() => void) | null = null;

/** Whether the document, read right now, is out of sight or out of focus. */
export function readIdle(doc: Document = document): boolean {
    return doc.visibilityState === "hidden" || !doc.hasFocus();
}

/** The last state the watcher saw; false where nothing is watching. */
export function isIdle(): boolean {
    return idle;
}

function settle(): void {
    const next = readIdle();
    if (next === idle) return;
    idle = next;
    document.documentElement.toggleAttribute(IDLE_ATTRIBUTE, idle);
    for (const listener of listeners) listener(idle);
}

/**
 * Keep `data-idle` on `<html>` in step with the page. Counted, so every caller
 * may start it and the last one to stop removes the listeners.
 */
export function watchIdle(): () => void {
    if (typeof document === "undefined") return () => {};
    watchers += 1;
    if (!detach) {
        // Focus moving into an iframe blurs the window too; by the next task
        // `hasFocus()` knows the page still holds it, so read it then.
        let pending: ReturnType<typeof setTimeout> | undefined;
        const later = () => {
            clearTimeout(pending);
            pending = setTimeout(settle, 0);
        };
        document.addEventListener("visibilitychange", settle);
        window.addEventListener("focus", settle);
        window.addEventListener("blur", later);
        window.addEventListener("pagehide", settle);
        window.addEventListener("pageshow", settle);
        settle();
        detach = () => {
            clearTimeout(pending);
            document.removeEventListener("visibilitychange", settle);
            window.removeEventListener("focus", settle);
            window.removeEventListener("blur", later);
            window.removeEventListener("pagehide", settle);
            window.removeEventListener("pageshow", settle);
        };
    }
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        watchers -= 1;
        if (watchers > 0 || !detach) return;
        detach();
        detach = null;
        idle = false;
        document.documentElement.removeAttribute(IDLE_ATTRIBUTE);
    };
}

/** Hear every change of idle state; also starts the watcher while subscribed. */
export function onIdleChange(listener: (idle: boolean) => void): () => void {
    listeners.add(listener);
    const unwatch = watchIdle();
    return () => {
        listeners.delete(listener);
        unwatch();
    };
}

/** Live idle state for a component. */
export function useIdle(): boolean {
    return useSyncExternalStore(
        (change) => onIdleChange(change),
        isIdle,
        () => false
    );
}

/**
 * Run `frame(now)` on every animation frame while the page is not idle, and
 * not at all while it is. The returned function stops it for good.
 */
export function animateWhileAwake(frame: (now: number) => void): () => void {
    let raf = 0;
    const loop = (now: number) => {
        frame(now);
        raf = requestAnimationFrame(loop);
    };
    const pause = () => {
        cancelAnimationFrame(raf);
        raf = 0;
    };
    const resume = () => {
        if (!raf) raf = requestAnimationFrame(loop);
    };
    const unsubscribe = onIdleChange((now) => (now ? pause() : resume()));
    if (!isIdle()) resume();
    return () => {
        unsubscribe();
        pause();
    };
}
