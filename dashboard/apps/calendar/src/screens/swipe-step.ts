"use client";

/**
 * Swipe the calendar sideways on a phone to go to the next or previous month,
 * week or day - the way a phone's own calendar does.
 *
 * Only for a finger and only on a phone-sized screen: a mouse has the arrows and
 * the keyboard shortcuts, and on a wide screen a sideways drag is how a range of
 * the grid gets selected.
 *
 * The page keeps its vertical scroll: nothing is claimed while the finger moves,
 * and the decision is taken once it lifts. A touch only counts when it went far
 * enough, clearly more sideways than up or down, and quickly - a slow drag is
 * somebody reading or selecting, not flicking a page. A second finger, a page
 * pinched in, a touch the system cancelled, a touch that started on something
 * that scrolls sideways itself or inside a dialog, and a touch that leaves text
 * selected are never a swipe.
 *
 * The rules live in `swipeDirection`, which takes plain numbers, so the tests can
 * drive it without a DOM.
 */

import { useEffect, useRef, type RefObject } from "react";

/** How far the finger has to travel sideways to count. */
export const SWIPE_DISTANCE = 60;

/** How much more sideways than vertical the move has to be. */
export const SWIPE_RATIO = 1.5;

/** How long a swipe may take at most. */
export const SWIPE_MS = 700;

/** Below this width the calendar is laid out for a phone (Tailwind's `md`). */
export const PHONE_QUERY = "(max-width: 767px)";

/**
 * Which way a finished touch moves the calendar: 1 to the next page (finger
 * moved left), -1 to the previous one (finger moved right), or null when it was
 * not a swipe.
 */
export function swipeDirection(dx: number, dy: number, ms: number): 1 | -1 | null {
    if (ms > SWIPE_MS) return null;
    if (Math.abs(dx) < SWIPE_DISTANCE) return null;
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return null;
    return dx < 0 ? 1 : -1;
}

/** Whether a touch that starts here belongs to something else: a dialog over the
 *  calendar, or an element that scrolls sideways on its own. */
function ownedElsewhere(target: EventTarget | null, root: Element): boolean {
    const from = target instanceof Element ? target : null;
    if (from?.closest("[role=dialog]")) return true;
    for (let node = from; node && node !== root; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1) {
            const overflow = getComputedStyle(node).overflowX;
            if (overflow === "auto" || overflow === "scroll") return true;
        }
    }
    return false;
}

/** Whether the page is pinched in, where a sideways move pans the zoomed view. */
function zoomedIn(): boolean {
    const scale = window.visualViewport?.scale ?? 1;
    return scale > 1.01;
}

/** Listen for swipes on `ref` and step the calendar with them, on a phone only. */
export function useSwipeStep(ref: RefObject<HTMLElement | null>, step: (direction: 1 | -1) => void) {
    // Read at the moment of the swipe, so a new `step` each render does not
    // tear the listeners down and put them back.
    const latest = useRef(step);
    latest.current = step;
    useEffect(() => {
        const element = ref.current;
        if (!element || typeof window.matchMedia !== "function") return;
        const phone = window.matchMedia(PHONE_QUERY);
        let start: { x: number; y: number; at: number } | null = null;

        const onStart = (event: TouchEvent) => {
            const touch = event.touches[0];
            start =
                phone.matches &&
                event.touches.length === 1 &&
                touch &&
                !zoomedIn() &&
                !ownedElsewhere(event.target, element)
                    ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp }
                    : null;
        };
        const onMove = (event: TouchEvent) => {
            if (event.touches.length > 1) start = null;
        };
        const onEnd = (event: TouchEvent) => {
            const from = start;
            start = null;
            const touch = event.changedTouches[0];
            if (!from || !touch) return;
            if (window.getSelection()?.toString()) return;
            const direction = swipeDirection(
                touch.clientX - from.x,
                touch.clientY - from.y,
                event.timeStamp - from.at
            );
            if (direction) latest.current(direction);
        };
        const onCancel = () => (start = null);

        element.addEventListener("touchstart", onStart, { passive: true });
        element.addEventListener("touchmove", onMove, { passive: true });
        element.addEventListener("touchend", onEnd);
        element.addEventListener("touchcancel", onCancel);
        return () => {
            element.removeEventListener("touchstart", onStart);
            element.removeEventListener("touchmove", onMove);
            element.removeEventListener("touchend", onEnd);
            element.removeEventListener("touchcancel", onCancel);
        };
    }, [ref]);
}
