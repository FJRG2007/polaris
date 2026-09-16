"use client";

/**
 * The line between two panels, and the way to move it.
 *
 * Every app that draws panels side by side lets people decide how wide they are,
 * and the reason is not preference: the right split depends on what is in them.
 * A conversation list is a column of names on one screen and a wall of them on
 * another, and a call taking half the column is right while somebody is sharing a
 * document and wrong the moment they stop.
 *
 * What this owns is the dragging and the limits. Where the size is kept - and
 * whether it survives the tab - belongs to whoever draws the panel, because that
 * is the thing that knows which screen this is. What it must never do is let a
 * panel reach a size the view cannot be used at, so `min` and `max` are required
 * rather than optional: a divider dragged to the edge is how a layout becomes a
 * sliver nobody can get back.
 *
 * Reachable without a mouse, which a divider usually is not. It takes focus, the
 * arrow keys move it a step at a time, and Home and End go straight to the
 * limits - so the person who cannot drag can still decide, and the person who
 * dragged it somewhere silly can put it back with a double press.
 */

import {
    useCallback,
    useRef,
    type PointerEvent as ReactPointerEvent,
    type KeyboardEvent
} from "react";

/** How far one arrow press moves it. A step small enough to arrive somewhere
 *  deliberate, large enough that crossing a panel is not a hundred presses. */
const STEP = 16;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function ResizeHandle({
    axis,
    side = "start",
    size,
    min,
    max,
    onChange,
    onReset,
    label,
    className
}: {
    /** `x` moves a width, `y` moves a height. */
    axis: "x" | "y";
    /**
     * Which side of the line the panel being sized is on.
     *
     * `start` is a panel before the handle - a list on the left, a call above -
     * where dragging away from it makes it bigger. `end` is a panel after the
     * handle, which every panel down the right-hand side is, and there the same
     * movement means the opposite: dragging left widens it, because the edge
     * being moved is its own leading edge rather than its trailing one.
     *
     * Getting this wrong is not subtle, and it is not a crash either - the panel
     * simply shrinks when somebody pulls it wider, which reads as the control
     * being broken rather than as being inverted.
     */
    side?: "start" | "end";
    /** What the panel is at now, in pixels. */
    size: number;
    min: number;
    max: number;
    onChange: (size: number) => void;
    /** What a double press goes back to. Without one the control is still
     *  useful, so this is optional rather than a required default nobody chose. */
    onReset?: () => void;
    /** Said to a screen reader, because a line between two panels has no text of
     *  its own: "Conversation list width" rather than "separator". */
    label: string;
    className?: string;
}) {
    // Where the press started, and how big the panel was then. Held in a ref
    // rather than in state: it changes on every pointer event and nothing drawn
    // depends on it, so a render per pixel would be a render for nothing.
    const from = useRef<{ at: number; size: number } | null>(null);

    /** Which way the pointer has to travel to make the panel bigger: away from a
     *  panel that starts before this line, towards one that starts after it. */
    const towards = side === "end" ? -1 : 1;

    const move = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const start = from.current;
            if (!start) return;
            const moved = ((axis === "x" ? event.clientX : event.clientY) - start.at) * towards;
            onChange(clamp(start.size + moved, min, max));
        },
        [axis, max, min, onChange, towards]
    );

    const down = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            // Only the primary button, and captured on this element: without the
            // capture the drag stops the moment the pointer crosses into the
            // panel it is resizing, which is most of the drag.
            if (event.button !== 0) return;
            from.current = { at: axis === "x" ? event.clientX : event.clientY, size };
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        [axis, size]
    );

    const up = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        from.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }, []);

    const key = useCallback(
        (event: KeyboardEvent<HTMLDivElement>) => {
            const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
            const forward = axis === "x" ? "ArrowRight" : "ArrowDown";
            // The same inversion the drag makes: on a panel down the right-hand
            // side, left is wider. The key and the pointer have to agree, or the
            // divider does one thing to the mouse and the opposite to the arrows.
            const step = STEP * towards;
            if (event.key === back) onChange(clamp(size - step, min, max));
            else if (event.key === forward) onChange(clamp(size + step, min, max));
            else if (event.key === "Home") onChange(min);
            else if (event.key === "End") onChange(max);
            else return;
            // Only once something was actually handled: an unrelated key pressed
            // on a focused divider belongs to whatever else is listening for it.
            event.preventDefault();
        },
        [axis, max, min, onChange, size]
    );

    return (
        <div
            role="separator"
            tabIndex={0}
            aria-label={label}
            aria-orientation={axis === "x" ? "vertical" : "horizontal"}
            aria-valuenow={Math.round(size)}
            aria-valuemin={min}
            aria-valuemax={max}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onDoubleClick={onReset}
            onKeyDown={key}
            className={[
                // Thin to look at and wide enough to catch: the bar itself is a
                // hairline, and the element around it is what the pointer finds.
                "group relative shrink-0 touch-none",
                axis === "x" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
                "bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/40",
                "focus-visible:outline-none",
                className ?? ""
            ]
                .filter(Boolean)
                .join(" ")}
        />
    );
}
