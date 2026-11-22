"use client";

/**
 * Press and hold a message to open its actions, the way every phone chat does.
 *
 * A finger that stays put for `HOLD_MS` opens them. Moving it further than
 * `DECIDE_AT` first - the start of a scroll or of a swipe to reply - lets go for
 * the rest of the touch, and so does the browser taking the touch over for a
 * scroll (`pointercancel`). Lifting before the time is a tap, and the tap is
 * left alone, so a link in the message still opens.
 *
 * Once the hold has opened the actions, the click the browser sends when the
 * finger lifts is swallowed: it would otherwise land on whatever was under the
 * finger - a link, a picture - and open that behind the sheet.
 *
 * The browser's own long-press menu (`contextmenu`, which Android raises at
 * about the same moment) is always refused on a touch screen, since the hold is
 * what answers it. One that arrives on its own - a mouse plugged into a tablet -
 * opens the actions as well.
 */

import { DECIDE_AT } from "./swipe-reply";
import { useCallback, useEffect, useRef } from "react";

/** How long a finger has to stay down. Android's own long press is 400-500 ms. */
export const HOLD_MS = 450;

export interface LongPressHandlers {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

/**
 * The handlers for one row. `onHold` gets the element the finger was on and the
 * row the handlers sit on, which is what `messageTarget` reads.
 */
export function useLongPress(
    onHold: (target: Element | null, row: Element) => void
): LongPressHandlers {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    /** The hold opened the actions, so the click that follows is not a tap. */
    const held = useRef(false);
    const hold = useRef(onHold);
    hold.current = onHold;

    const cancel = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        start.current = null;
    }, []);

    useEffect(() => cancel, [cancel]);

    return {
        onPointerDown: (event) => {
            cancel();
            held.current = false;
            // A mouse has its right button; a second finger is a pinch.
            if (event.pointerType === "mouse" || !event.isPrimary) return;
            const target = event.target as Element | null;
            const row = event.currentTarget;
            start.current = { x: event.clientX, y: event.clientY };
            timer.current = setTimeout(() => {
                timer.current = null;
                start.current = null;
                held.current = true;
                navigator.vibrate?.(10);
                hold.current(target, row);
            }, HOLD_MS);
        },
        onPointerMove: (event) => {
            const from = start.current;
            if (!from) return;
            if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > DECIDE_AT) cancel();
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onContextMenu: (event) => {
            event.preventDefault();
            if (held.current || timer.current) return;
            hold.current(event.target as Element | null, event.currentTarget);
        },
        onClickCapture: (event) => {
            if (!held.current) return;
            held.current = false;
            event.preventDefault();
            event.stopPropagation();
        }
    };
}
