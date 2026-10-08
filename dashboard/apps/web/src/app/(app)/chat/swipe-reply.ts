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
 * and a drag with a mouse is how text gets selected - so this listens to touch
 * events and nothing else.
 *
 * The gesture shares the screen with three things a finger does far more often:
 *
 * - **Scrolling.** The row is `touch-action: pan-y`, so the browser keeps the
 *   vertical scroll to itself and never claims a sideways move. Nothing here
 *   moves until the finger has gone `DECIDE_AT` pixels; then a move clearly to
 *   the right (`dx > |dy| * LOCK_RATIO`) locks the gesture to this row, and from
 *   there every move is claimed (`preventDefault`), so the list cannot start
 *   scrolling under a swipe and the browser cannot cancel it half way. A move
 *   that is mostly vertical lets go for the rest of the touch, and a touch the
 *   browser is already scrolling (its moves can no longer be claimed) never
 *   becomes a swipe.
 * - **The long press.** A press that does not move is the context menu's. The
 *   menu's own timer is cancelled by the first move, and a menu that tries to
 *   open during a swipe is refused.
 * - **Selecting text, and scrolling sideways inside a message.** A press that
 *   lands while text is selected, or inside a code block or table wider than the
 *   message, is left alone.
 *
 * Every way a touch can end - lifted, cancelled by the system, a second finger,
 * the list scrolling, the tab hidden, the row unmounted - goes back to idle and
 * springs the line back, so one interrupted swipe can never leave the next one
 * stuck. The rules live in `createSwipe`, a plain state machine with no DOM in
 * it, which is what the tests drive.
 *
 * Moves are written straight to the element's style rather than through React
 * state: a re-render per touch move on a list of two hundred messages is a
 * gesture that stutters.
 */

import { useCallback, useEffect, useRef } from "react";

/** How far the finger has to travel before the gesture decides which way it is
 *  going. Under this it is a tap or the start of a long press. */
export const DECIDE_AT = 10;

/** How much more sideways than vertical a move has to be to count as a swipe. */
export const LOCK_RATIO = 1.5;

/** How far a drag has to go to count as a reply. WhatsApp's is about a fifth of
 *  a phone's width. */
export const REPLY_AT = 64;

/** How far the line goes at most. Past `REPLY_AT` it follows the finger more and
 *  more reluctantly, which is how the gesture says it has had enough. */
export const MAX_PULL = 96;

/** How long the spring back takes. */
const SETTLE_MS = 220;

/** A spring with a touch of overshoot, for the line going home. */
const SPRING = "cubic-bezier(0.34, 1.4, 0.64, 1)";

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
 *  the browser. A diagonal that is neither stays undecided a little longer, so a
 *  finger that wobbles as it lands is not written off. */
export function axisOf(dx: number, dy: number): "undecided" | "reply" | "other" {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (Math.hypot(dx, dy) < DECIDE_AT) return "undecided";
    if (dx > 0 && ax > ay * LOCK_RATIO) return "reply";
    if (dx <= 0 || ay >= ax || Math.hypot(dx, dy) >= DECIDE_AT * 3) return "other";
    return "undecided";
}

/** One finger on the screen, as the machine sees it. */
export interface TouchPoint {
    readonly id: number;
    readonly x: number;
    readonly y: number;
}

/** What the machine asks of the screen. */
export interface SwipeOutput {
    /** Put the line `pull` pixels to the right; `armed` once past the line;
     *  `settle` when it is going home rather than following the finger. */
    readonly draw: (pull: number, armed: boolean, settle: boolean) => void;
    /** The phone's tick, once, when the drag crosses the line. */
    readonly tick: () => void;
    /** The reply itself. */
    readonly reply: () => void;
}

export type SwipePhase = "idle" | "pending" | "swiping";

/**
 * The gesture as a state machine: idle -> pending (a finger is down, direction
 * unknown) -> swiping (locked to this row) -> idle. Every input returns whether
 * the browser's default for that event has to be stopped.
 */
export function createSwipe(output: SwipeOutput) {
    let phase: SwipePhase = "idle";
    let id = -1;
    let startX = 0;
    let startY = 0;
    let armed = false;
    let pulled = false;

    /** Back to idle from anywhere, the line sent home if it had moved. */
    const reset = (): void => {
        const moved = pulled;
        phase = "idle";
        id = -1;
        armed = false;
        pulled = false;
        if (moved) output.draw(0, false, true);
    };

    return {
        get phase(): SwipePhase {
            return phase;
        },

        /** A finger landed. `touches` is every finger on the screen now. */
        start(touches: readonly TouchPoint[]): boolean {
            if (touches.length !== 1) {
                // A second finger is a pinch or an accident, never a reply.
                reset();
                return false;
            }
            reset();
            const [point] = touches;
            phase = "pending";
            id = point!.id;
            startX = point!.x;
            startY = point!.y;
            return false;
        },

        /** The finger moved. `cancelable` is false once the browser has taken the
         *  touch for a scroll, and a touch it has taken is never a swipe. */
        move(touches: readonly TouchPoint[], cancelable: boolean): boolean {
            if (phase === "idle") return false;
            if (touches.length !== 1) {
                reset();
                return false;
            }
            const point = touches.find((touch) => touch.id === id);
            if (!point) {
                reset();
                return false;
            }
            const dx = point.x - startX;
            const dy = point.y - startY;
            if (phase === "pending") {
                const axis = axisOf(dx, dy);
                if (axis === "undecided") return false;
                if (axis === "other" || !cancelable) {
                    reset();
                    return false;
                }
                phase = "swiping";
            }
            const pull = pullFor(dx);
            const now = pull >= REPLY_AT;
            if (now && !armed) output.tick();
            armed = now;
            pulled = true;
            output.draw(pull, armed, false);
            return true;
        },

        /** The finger lifted. Replies if it was past the line. */
        end(): boolean {
            const swiped = phase === "swiping";
            const fire = swiped && armed;
            reset();
            if (fire) output.reply();
            // A swipe's lift is not also a tap on whatever it started on.
            return swiped;
        },

        /** The system took the touch away, or something else ended it: the list
         *  scrolled, the tab was hidden, the row went away. Never replies. */
        cancel(): void {
            reset();
        }
    };
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

function points(list: TouchList): TouchPoint[] {
    return Array.from(list, (touch) => ({
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY
    }));
}

/**
 * The swipe, for one message row.
 *
 * `line` is what moves (the row's content) and `cue` is the arrow behind it.
 * With no `onReply` the row is left exactly as it was.
 */
export function useSwipeReply(onReply: (() => void) | undefined) {
    const line = useRef<HTMLDivElement | null>(null);
    const cue = useRef<HTMLSpanElement | null>(null);
    const latest = useRef(onReply);
    latest.current = onReply;
    const enabled = Boolean(onReply);

    const draw = useCallback((pull: number, armed: boolean, settle: boolean) => {
        const moving = line.current;
        const arrow = cue.current;
        if (moving) {
            moving.style.transition = settle ? `transform ${SETTLE_MS}ms ${SPRING}` : "none";
            moving.style.transform = pull === 0 ? "" : `translateX(${pull}px)`;
        }
        if (arrow) {
            const shown = Math.min(1, pull / REPLY_AT);
            arrow.style.transition = settle
                ? `opacity ${SETTLE_MS}ms ease-out, transform ${SETTLE_MS}ms ease-out`
                : "transform 120ms ease-out";
            arrow.style.opacity = String(shown);
            arrow.style.transform = `translateY(-50%) scale(${0.5 + 0.5 * shown + (armed ? 0.15 : 0)})`;
            arrow.dataset.armed = armed ? "true" : "false";
        }
    }, []);

    const machine = useRef<ReturnType<typeof createSwipe> | null>(null);
    if (!machine.current) {
        machine.current = createSwipe({ draw, tick, reply: () => latest.current?.() });
    }

    useEffect(() => {
        const row = line.current;
        const swipe = machine.current;
        if (!enabled || !row || !swipe) return;

        const onStart = (event: TouchEvent) => {
            const target = event.target as Element | null;
            if (
                event.touches.length === 1 &&
                (selecting(row) ||
                    inSideScroller(target, row) ||
                    // Somewhere a finger already means something else: a field, a
                    // player, a slider. Buttons and links are fine - a tap still
                    // presses them.
                    target?.closest(
                        "input, textarea, [contenteditable='true'], iframe, video, audio, [role='slider']"
                    ))
            ) {
                swipe.cancel();
                return;
            }
            swipe.start(points(event.touches));
        };
        const onMove = (event: TouchEvent) => {
            if (swipe.move(points(event.touches), event.cancelable) && event.cancelable) {
                event.preventDefault();
            }
        };
        const onEnd = (event: TouchEvent) => {
            // A finger lifted while another stays down ends it too.
            if (event.touches.length > 0) {
                swipe.cancel();
                return;
            }
            if (swipe.end() && event.cancelable) event.preventDefault();
        };
        const onCancel = () => swipe.cancel();
        /** The list scrolled under a press still deciding: the browser has the
         *  touch. Under a swipe the list cannot scroll, so anything that does
         *  scroll it (a new message arriving) ends the swipe. */
        const onScroll = (event: Event) => {
            if (swipe.phase === "idle") return;
            const scroller = event.target;
            if (scroller instanceof Node && scroller !== row && !scroller.contains(row)) return;
            swipe.cancel();
        };
        const onHidden = () => swipe.cancel();
        /** The long press's menu, which a swipe under way must not open. */
        const onContextMenu = (event: Event) => {
            if (swipe.phase !== "swiping") return;
            event.preventDefault();
            event.stopPropagation();
        };

        row.addEventListener("touchstart", onStart, { passive: true });
        row.addEventListener("touchmove", onMove, { passive: false });
        row.addEventListener("touchend", onEnd, { passive: false });
        row.addEventListener("touchcancel", onCancel);
        row.addEventListener("contextmenu", onContextMenu, true);
        document.addEventListener("scroll", onScroll, { capture: true, passive: true });
        window.addEventListener("blur", onHidden);
        document.addEventListener("visibilitychange", onHidden);
        return () => {
            row.removeEventListener("touchstart", onStart);
            row.removeEventListener("touchmove", onMove);
            row.removeEventListener("touchend", onEnd);
            row.removeEventListener("touchcancel", onCancel);
            row.removeEventListener("contextmenu", onContextMenu, true);
            document.removeEventListener("scroll", onScroll, { capture: true });
            window.removeEventListener("blur", onHidden);
            document.removeEventListener("visibilitychange", onHidden);
            // A row that loses its reply mid-swipe (the message was deleted under
            // the finger) springs back rather than staying pulled out.
            swipe.cancel();
        };
    }, [enabled]);

    return { line, cue, enabled };
}
