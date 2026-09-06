"use client";

/**
 * Pushing into a picture that is already on screen.
 *
 * Written for the camera viewer and then wanted by everything else that shows a
 * picture somebody wants a closer look at: a screen somebody is sharing in a
 * call - which is the one where reading a line of code in it is the whole point
 * - and a video opened out of Drive. Three copies of a wheel handler and a drag
 * would have been three sets of the clamping bugs this exists to avoid, so it is
 * one hook and the arithmetic stays in `lib/home/zoom`, pure and tested.
 *
 * It hands back the props for the frame. The caller draws whatever it likes
 * inside and applies `transform` to it; nothing here knows or cares whether that
 * is an image, a video element or a live camera.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
    coverOf,
    isZoomed,
    panBy,
    zoomBy,
    zoomTransform,
    MAX_ZOOM,
    NO_ZOOM,
    ZOOM_STEP,
    type Zoom
} from "@/lib/home/zoom";

export interface ZoomPan {
    /** Put on the element the gestures happen over. A callback ref, because an
     *  effect that ran once with no element never runs again - which is exactly
     *  how the camera viewer's wheel came to do nothing. */
    readonly frameRef: (element: HTMLElement | null) => void;
    /** Spread onto that same element. */
    readonly frameProps: {
        onDoubleClick: (event: { clientX: number; clientY: number }) => void;
        onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerUp: () => void;
        onPointerCancel: () => void;
    };
    /** For the element being scaled. */
    readonly transform: string;
    readonly zoom: Zoom;
    readonly zoomed: boolean;
    /** The buttons, which have no pointer to aim at and so work from the middle. */
    readonly zoomIn: () => void;
    readonly zoomOut: () => void;
    readonly reset: () => void;
    /** Told the shape of the picture and of the frame, so the clamping is
     *  measured against the picture rather than against the box around it -
     *  otherwise it can be dragged until the bars are in the middle. */
    readonly measure: (picture: number | null, frame: number | null) => void;
}

export function useZoomPan(): ZoomPan {
    const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
    const [shape, setShape] = useState<number | null>(null);
    const [frameShape, setFrameShape] = useState<number | null>(null);
    const element = useRef<HTMLElement | null>(null);
    const detach = useRef<(() => void) | null>(null);
    const dragging = useRef<{ x: number; y: number } | null>(null);

    const cover = useMemo(() => coverOf(shape, frameShape), [shape, frameShape]);
    const covering = useRef(cover);
    covering.current = cover;

    /** Where the pointer is inside the frame, as fractions from its centre. */
    const pointAt = useCallback((event: { clientX: number; clientY: number }) => {
        const box = element.current?.getBoundingClientRect();
        if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
        return {
            x: (event.clientX - box.left) / box.width - 0.5,
            y: (event.clientY - box.top) / box.height - 0.5
        };
    }, []);

    /**
     * The wheel, attached by hand.
     *
     * React registers its own wheel listener as passive, so `preventDefault`
     * inside a JSX handler is ignored and the page scrolls underneath anyway -
     * which over a picture taller than the window is the whole view sliding away
     * while somebody tries to zoom into it.
     */
    const frameRef = useCallback(
        (node: HTMLElement | null) => {
            detach.current?.();
            detach.current = null;
            element.current = node;
            if (!node) return;
            const onWheel = (event: WheelEvent) => {
                event.preventDefault();
                // Proportional to how hard the wheel was turned. A notch is a
                // small push and a trackpad sends a stream of tiny ones, and a
                // fixed step on each of those leaps past whatever was aimed at.
                const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
                const amount = Math.max(-240, Math.min(240, event.deltaY * lines));
                setZoom((current) =>
                    zoomBy(current, Math.exp(-amount / 320), pointAt(event), covering.current)
                );
            };
            node.addEventListener("wheel", onWheel, { passive: false });
            detach.current = () => node.removeEventListener("wheel", onWheel);
        },
        [pointAt]
    );

    return {
        frameRef,
        frameProps: {
            // A second press puts it back rather than pushing further in: the
            // way out has to be as easy as the way in.
            onDoubleClick: (event) =>
                setZoom((current) =>
                    isZoomed(current)
                        ? NO_ZOOM
                        : zoomBy(current, ZOOM_STEP * 2, pointAt(event), covering.current)
                ),
            onPointerDown: (event) => {
                if (!isZoomed(zoom) || event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                dragging.current = pointAt(event);
            },
            onPointerMove: (event) => {
                const from = dragging.current;
                if (!from) return;
                const to = pointAt(event);
                dragging.current = to;
                setZoom((current) => panBy(current, to.x - from.x, to.y - from.y, covering.current));
            },
            onPointerUp: () => (dragging.current = null),
            onPointerCancel: () => (dragging.current = null)
        },
        transform: zoomTransform(zoom, cover),
        zoom,
        zoomed: isZoomed(zoom),
        zoomIn: () => setZoom((current) => zoomBy(current, ZOOM_STEP, undefined, covering.current)),
        zoomOut: () =>
            setZoom((current) => zoomBy(current, 1 / ZOOM_STEP, undefined, covering.current)),
        reset: () => setZoom(NO_ZOOM),
        measure: (picture, frame) => {
            setShape(picture);
            setFrameShape(frame);
        }
    };
}

export { MAX_ZOOM, NO_ZOOM, ZOOM_STEP };
