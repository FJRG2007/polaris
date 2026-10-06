/**
 * Getting around a board: zooming on the wheel towards the pointer, moving by
 * dragging the board itself, and pinching on a touch screen.
 *
 * What every map and diagram tool does, and what the automation diagrams did
 * through React Flow before they were drawn here. One place for it, so the
 * Deploy board and the automation diagrams answer the same hand the same way:
 *
 * - the wheel zooms towards the pointer, whichever way it arrives - a mouse
 *   wheel, or a trackpad pinch, which the browser sends as a wheel with Ctrl;
 * - dragging the board (not a card on it) moves it, and a drag that moved is
 *   not also a click on whatever it ended over;
 * - two fingers pinch.
 *
 * The arithmetic is pure and separate (`zoomViewAt`, `fitBoard`), because it is
 * the part that is wrong in every hand-rolled version and it can be asserted
 * rather than dragged at. A board drawn by a transform keeps a `BoardView`; one
 * drawn in a scrolling box takes the zoom and the pan as they come.
 */

import { useEffect, useRef, type RefObject } from "react";

/** Where a board is: a point on the board is drawn at `point * zoom + (x, y)`. */
export interface BoardView {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}

export interface BoardPoint {
    readonly x: number;
    readonly y: number;
}

export interface BoardBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** How fast the wheel zooms: one notch of a mouse wheel is about 10%. */
const WHEEL_RATE = 0.002;

/** How far a press may wander and still be a click rather than a drag. */
const CLICK_SLOP = 4;

/**
 * The click a drag ends in, if the browser sends one, is not a click on what it
 * ended over. Only the click of this same release: a drag that sends none (a
 * touch, or a release outside the window) leaves nothing behind to eat the next.
 */
export function swallowNextClick(): void {
    const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** The factor one wheel event zooms by. Lines and pages are turned into the
 *  pixels a wheel in pixel mode would have sent, so every mouse zooms alike. */
export function wheelFactor(event: {
    readonly deltaY: number;
    readonly deltaMode: number;
}): number {
    const pixels =
        event.deltaMode === 1
            ? event.deltaY * 16
            : event.deltaMode === 2
              ? event.deltaY * 400
              : event.deltaY;
    // Bounded, so one violent flick does not leap from one end to the other.
    const delta = Math.max(-200, Math.min(200, pixels));
    return Math.exp(-delta * WHEEL_RATE);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * Zoom by a factor, holding `anchor` (a point of the frame) over the same
 * point of the board. Clamped to the limits first, so a wheel held at full zoom
 * does not keep sliding the board.
 */
export function zoomViewAt(
    view: BoardView,
    factor: number,
    anchor: BoardPoint,
    limits: { readonly min: number; readonly max: number }
): BoardView {
    const zoom = clamp(
        view.zoom * (Number.isFinite(factor) && factor > 0 ? factor : 1),
        limits.min,
        limits.max
    );
    const applied = zoom / view.zoom;
    return {
        zoom,
        x: anchor.x - (anchor.x - view.x) * applied,
        y: anchor.y - (anchor.y - view.y) * applied
    };
}

/**
 * The view that puts `bounds` in the middle of the frame, as large as it fits
 * with `padding` (a share of the frame) around it, within the zoom limits.
 */
export function fitBoard(
    bounds: BoardBounds,
    frame: { readonly width: number; readonly height: number },
    options: { readonly padding: number; readonly minZoom: number; readonly maxZoom: number }
): BoardView {
    const room = 1 - options.padding * 2;
    const fits =
        bounds.width > 0 && bounds.height > 0
            ? Math.min((frame.width * room) / bounds.width, (frame.height * room) / bounds.height)
            : options.maxZoom;
    const zoom = clamp(fits, options.minZoom, options.maxZoom);
    return {
        zoom,
        x: frame.width / 2 - (bounds.x + bounds.width / 2) * zoom,
        y: frame.height / 2 - (bounds.y + bounds.height / 2) * zoom
    };
}

export interface BoardGestures {
    /** Zoom by `factor` towards `anchor`, a point of the frame in pixels. */
    readonly onZoom: (factor: number, anchor: BoardPoint) => void;
    /** Move the board by this many pixels on screen. */
    readonly onPan: (dx: number, dy: number) => void;
    /** Whether a press on this element is a press on the board itself, which
     *  moves it, rather than on something drawn on it. */
    readonly grabs: (target: Element) => boolean;
}

/**
 * Wire the gestures to the board's frame. The wheel listener is registered by
 * hand because React's is passive, and a passive one cannot stop the page from
 * zooming or scrolling instead of the board.
 */
export function useBoardGestures(
    frame: RefObject<HTMLElement | null>,
    gestures: BoardGestures,
    enabled = true
): void {
    const latest = useRef(gestures);
    latest.current = gestures;

    useEffect(() => {
        const element = frame.current;
        if (!element || !enabled) return;
        const anchorOf = (clientX: number, clientY: number): BoardPoint => {
            const rect = element.getBoundingClientRect();
            return { x: clientX - rect.left, y: clientY - rect.top };
        };

        function onWheel(event: WheelEvent): void {
            event.preventDefault();
            latest.current.onZoom(wheelFactor(event), anchorOf(event.clientX, event.clientY));
        }

        // Every finger or button on the board, by pointer id, at where it was last.
        const pointers = new Map<number, BoardPoint>();
        let travelled = 0;
        let pinch: number | null = null;

        const spread = (): number => {
            const [a, b] = [...pointers.values()];
            return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
        };

        function onDown(event: PointerEvent): void {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            if (!(event.target instanceof Element) || !latest.current.grabs(event.target)) return;
            if (pointers.size === 0) travelled = 0;
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (pointers.size === 2) pinch = spread();
            element!.dataset.panning = "true";
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onUp);
        }

        function onMove(event: PointerEvent): void {
            const last = pointers.get(event.pointerId);
            if (!last) return;
            const dx = event.clientX - last.x;
            const dy = event.clientY - last.y;
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (pointers.size >= 2 && pinch) {
                const now = spread();
                const [a, b] = [...pointers.values()];
                if (now > 0 && a && b) {
                    latest.current.onZoom(now / pinch, anchorOf((a.x + b.x) / 2, (a.y + b.y) / 2));
                    pinch = now;
                }
                travelled = CLICK_SLOP + 1;
                return;
            }
            travelled += Math.abs(dx) + Math.abs(dy);
            if (dx !== 0 || dy !== 0) latest.current.onPan(dx, dy);
        }

        function onUp(event: PointerEvent): void {
            pointers.delete(event.pointerId);
            if (pointers.size < 2) pinch = null;
            if (pointers.size > 0) return;
            delete element!.dataset.panning;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            // A drag that moved the board ends over something; it was not a click
            // on that something.
            if (travelled > CLICK_SLOP) {
                swallowNextClick();
            }
        }

        element.addEventListener("wheel", onWheel, { passive: false });
        element.addEventListener("pointerdown", onDown);
        return () => {
            element.removeEventListener("wheel", onWheel);
            element.removeEventListener("pointerdown", onDown);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
    }, [frame, enabled]);
}
