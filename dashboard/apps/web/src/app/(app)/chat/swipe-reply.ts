"use client";

/**
 * Swipe a message to the right to answer it, the way WhatsApp does on a phone.
 *
 * The line follows the finger, a reply arrow fades and grows in the gap it
 * leaves, and once the drag passes `REPLY_AT` the arrow fills, the phone ticks
 * once and letting go quotes the message in the composer - exactly what the
 * menu's Reply does. Dragging back under the line before letting go cancels, and
 * either way the message springs back to where it was.
 *
 * Only for a finger. A mouse already has the hover bar and the right-click menu,
 * and a drag with a mouse is how text gets selected. The gesture also has to
 * share the screen with three things a finger does far more often, and loses to
 * each of them:
 *
 * - **Scrolling.** The row is `touch-action: pan-y`, so the browser keeps the
 *   vertical scroll to itself, and nothing here moves until the first few pixels
 *   say which way the finger is going. Mostly up or down is a scroll, and this
 *   lets go of the gesture for the rest of it (the axis lock).
 * - **The long press.** A press that does not move is the context menu's. The
 *   menu's own timer is cancelled by the first move, so a swipe never opens it
 *   and a long press never swipes.
 * - **Selecting text, and scrolling sideways inside a message.** A press that
 *   lands while text is selected, or inside a code block or table wider than the
 *   message, is left alone.
 *
 * Moves are written straight to the element's style rather than through React
 * state: a re-render per pointer move on a list of two hundred messages is a
 * gesture that stutters.
 */

import { useCallback, useEffect, useRef } from "react";

/** How far the finger has to travel before the gesture decides which way it is
 *  going. Under this it is a tap or the start of a long press. */
export const DECIDE_AT = 10;

/** How far a drag has to go to count as a reply. WhatsApp's is about a fifth of
 *  a phone's width. */
export const REPLY_AT = 64;

/** How far the line goes at most. Past `REPLY_AT` it follows the finger more and
 *  more reluctantly, which is how the gesture says it has had enough. */
export const MAX_PULL = 96;

/** How long the spring back takes. */
const SETTLE_MS = 180;

/** Where the line sits for a finger that has travelled `dx`: one to one up to
 *  the threshold, then damped towards `MAX_PULL`, and never to the left. */
export function pullFor(dx: number): number {
    if (dx <= 0) return 0;
    if (dx <= REPLY_AT) return dx;
    const extra = dx - REPLY_AT;
    const room = MAX_PULL - REPLY_AT;
    return REPLY_AT + room * (1 - Math.exp(-extra / room));
}

/** Which way a press that has moved this far is going: still undecided, a swipe
 *  to the right, or anything else (a scroll, a swipe left), which this leaves to
 *  the browser. */
export function axisOf(dx: number, dy: number): "undecided" | "reply" | "other" {
    if (Math.hypot(dx, dy) < DECIDE_AT) return "undecided";
    return dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2 ? "reply" : "other";
}

/** Whether this browser is driven by a finger. Asked when the press starts
 *  rather than once, so a tablet with a keyboard dock attached answers right. */
function coarse(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)").matches
        : false;
}

/** Whether the press landed somewhere that scrolls sideways on its own - a long
 *  line of code, a wide table - where a drag means "show me the rest". */
function inSideScroller(target: Element | null, row: Element): boolean {
    for (let node = target; node && node !== row; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1) {
            const overflow = getComputedStyle(node).overflowX;
            if (overflow === "auto" || overflow === "scroll") return true;
        }
    }
    return false;
}

/** Whether the reader has text selected inside this row, and so is adjusting a
 *  selection rather than swiping. */
function selecting(row: Element): boolean {
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || selection.toString() === "") return false;
    return row.contains(selection.anchorNode) || row.contains(selection.focusNode);
}

/** A short tick, where the device has one. Silently nothing elsewhere - iOS
 *  Safari has no vibration at all. */
function tick(): void {
    try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
            navigator.vibrate(12);
        }
    } catch {
        // A browser that refuses (no user gesture yet, a policy) just stays quiet.
    }
}

interface Gesture {
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    axis: "undecided" | "reply" | "other";
    armed: boolean;
}

/**
 * The swipe, for one message row.
 *
 * `line` is what moves (the row's content) and `cue` is the arrow behind it.
 * Returns the handlers to spread on the row; with no `onReply` the row is left
 * exactly as it was.
 */
export function useSwipeReply(onReply: (() => void) | undefined) {
    const line = useRef<HTMLDivElement | null>(null);
    const cue = useRef<HTMLSpanElement | null>(null);
    const gesture = useRef<Gesture | null>(null);
    /** Set once a swipe has moved, so the click the browser may send at the end
     *  of it does not also press whatever the finger started on. */
    const swallowClick = useRef(false);
    const latest = useRef(onReply);
    latest.current = onReply;

    const draw = useCallback((pull: number, armed: boolean, animate: boolean) => {
        const moving = line.current;
        const arrow = cue.current;
        if (moving) {
            moving.style.transition = animate ? `transform ${SETTLE_MS}ms ease-out` : "none";
            moving.style.transform = pull === 0 ? "" : `translateX(${pull}px)`;
        }
        if (arrow) {
            const shown = Math.min(1, pull / REPLY_AT);
            arrow.style.transition = animate
                ? `opacity ${SETTLE_MS}ms ease-out, transform ${SETTLE_MS}ms ease-out`
                : "none";
            arrow.style.opacity = String(shown);
            arrow.style.transform = `translateY(-50%) scale(${0.6 + 0.4 * shown})`;
            arrow.dataset.armed = armed ? "true" : "false";
        }
    }, []);

    const settle = useCallback(() => {
        gesture.current = null;
        draw(0, false, true);
    }, [draw]);

    // A row that loses its reply mid-swipe (the message was deleted under the
    // finger) springs back rather than staying pulled out.
    useEffect(() => {
        if (!onReply && gesture.current) settle();
    }, [onReply, settle]);

    const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (!latest.current || event.pointerType !== "touch" || !event.isPrimary) return;
        if (!coarse()) return;
        const row = event.currentTarget;
        const target = event.target as Element | null;
        if (selecting(row) || inSideScroller(target, row)) return;
        // Somewhere a finger already means something else: a field, a player,
        // a slider. Buttons and links are fine - a tap still presses them.
        if (
            target?.closest(
                "input, textarea, [contenteditable='true'], iframe, video, audio, [role='slider']"
            )
        ) {
            return;
        }
        swallowClick.current = false;
        gesture.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            axis: "undecided",
            armed: false
        };
    }, []);

    const onPointerMove = useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            const current = gesture.current;
            if (!current || event.pointerId !== current.pointerId) return;
            const dx = event.clientX - current.startX;
            const dy = event.clientY - current.startY;
            if (current.axis === "undecided") {
                current.axis = axisOf(dx, dy);
                if (current.axis === "other") {
                    gesture.current = null;
                    return;
                }
                if (current.axis === "undecided") return;
                // Decided: this is a swipe. Keep the finger's moves coming here
                // even when it leaves the row.
                swallowClick.current = true;
                try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                    // Capture is a nicety; without it a drag off the row ends it.
                }
            }
            const pull = pullFor(dx);
            const armed = pull >= REPLY_AT;
            if (armed && !current.armed) tick();
            current.armed = armed;
            draw(pull, armed, false);
        },
        [draw]
    );

    const finish = useCallback(
        (event: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
            const current = gesture.current;
            if (!current || event.pointerId !== current.pointerId) return;
            const reply = !cancelled && current.axis === "reply" && current.armed;
            const moved = current.axis === "reply";
            gesture.current = null;
            if (moved) draw(0, false, true);
            if (reply) latest.current?.();
        },
        [draw]
    );

    const onPointerUp = useCallback(
        (event: React.PointerEvent<HTMLElement>) => finish(event, false),
        [finish]
    );
    const onPointerCancel = useCallback(
        (event: React.PointerEvent<HTMLElement>) => finish(event, true),
        [finish]
    );

    /** Capture-phase, so the press a swipe ended on is not also a tap on the
     *  link or button under it. */
    const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
    }, []);

    /** The long press's menu, which a swipe under way must not open. */
    const onContextMenuCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (gesture.current?.axis !== "reply") return;
        event.preventDefault();
        event.stopPropagation();
    }, []);

    return {
        line,
        cue,
        enabled: Boolean(onReply),
        handlers: onReply
            ? {
                  onPointerDown,
                  onPointerMove,
                  onPointerUp,
                  onPointerCancel,
                  onClickCapture,
                  onContextMenuCapture
              }
            : {}
    };
}
