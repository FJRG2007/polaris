"use client";

/**
 * Pushing into a picture that is already on screen - the one gesture engine for
 * every picture, video and camera in Polaris that can be looked at closer.
 *
 * It used to be three: the picture viewer had its own, this hook served the
 * calls and Drive's videos, and the camera viewer carried a copy of it. All
 * three put the zoom in React state and set it on every pointer move and every
 * wheel event, so a drag across a large photo re-rendered the viewer sixty-plus
 * times a second, and the picture viewer also eased every one of those moves
 * through a CSS transition - the picture trailed the finger and froze while a
 * render caught up.
 *
 * Now the gesture never touches React. The approach is the one the fast
 * viewers converged on (PhotoSwipe, panzoom, OpenSeadragon's drawer):
 *
 *   - The live zoom is a ref. Pointer and wheel events only update it and ask
 *     for one animation frame; that frame writes `transform` straight onto the
 *     element, so however many events arrive, the picture moves once per frame.
 *   - Only `transform` (a `translate3d`) moves, on an element that is its own
 *     compositor layer, and it carries `will-change: transform` only while the
 *     gesture lasts: moving is then the GPU placing a texture, and taking the
 *     hint off when the gesture settles lets the browser re-raster the picture
 *     sharp at the scale it stopped at.
 *   - React hears about it once, when the gesture settles (pointers up, or the
 *     wheel quiet for a moment) - which is what the zoom percentage and the
 *     "back to fit" buttons need, and all they need.
 *   - The frame is measured when a gesture starts, never inside the loop, so a
 *     move never forces a layout.
 *
 * The arithmetic stays in `zoom.ts`, pure and tested.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as geometry from "./zoom";

type Zoom = geometry.Zoom;
type Cover = geometry.Cover;
type FramePoint = geometry.FramePoint;

/** How long the wheel has to be still before a wheel gesture counts as over. */
const WHEEL_SETTLE_MS = 160;

/** A touch that moved less than this is a tap, for the double-tap. */
const TAP_SLOP = 10;

/** Two taps this close in time and place are a double-tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

/** How long a discrete step (a button, a key, a double press) eases over. A
 *  gesture never eases: an eased transform trails a finger by its duration. */
const STEP_MS = 160;

export interface ZoomPanOptions {
    /**
     * `touch-action` on the frame while nothing is zoomed. `none` (the default)
     * gives every touch to the picture, which is right for a viewer that fills
     * the screen. A frame inside a page that scrolls passes `pan-x pan-y`, so a
     * finger can still scroll past it and only a pinch is the picture's.
     */
    readonly idleTouchAction?: string;
}

export interface ZoomPan {
    /** Put on the element the gestures happen over. A callback ref, because an
     *  effect that ran once with no element never runs again - which is exactly
     *  how the camera viewer's wheel came to do nothing. */
    readonly frameRef: (element: HTMLElement | null) => void;
    /** Put on each element that moves with the zoom (the picture, and anything
     *  drawn over it). The transform is written onto it directly; never put
     *  `transform` in its `style` as well, or a render puts the old one back. */
    readonly targetRef: (element: HTMLElement | null) => () => void;
    /** Spread onto that same element. */
    readonly frameProps: {
        onDoubleClick: (event: { clientX: number; clientY: number }) => void;
        onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerUp: (event?: React.PointerEvent<HTMLElement>) => void;
        onPointerCancel: (event?: React.PointerEvent<HTMLElement>) => void;
    };
    /** The settled transform, for anything that has to be told it as a value. */
    readonly transform: string;
    /** The settled zoom - updated when a gesture ends, not during it. */
    readonly zoom: Zoom;
    readonly zoomed: boolean;
    /** Whether the picture is zoomed or being pinched right now, read live -
     *  for a caller deciding whether a touch is its swipe or the picture's. */
    readonly engaged: () => boolean;
    /** The buttons, which have no pointer to aim at and so work from the middle. */
    readonly zoomIn: () => void;
    readonly zoomOut: () => void;
    readonly reset: (options?: { readonly animate?: boolean }) => void;
    /** Told the shape of the picture and of the frame (width over height), for
     *  a picture drawn `object-contain` into an element that fills the frame.
     *  Without it the covered share is measured from the target's own box,
     *  which is right for a picture sized to itself and centred. */
    readonly measure: (picture: number | null, frame: number | null) => void;
}

interface Metrics {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export function useZoomPan(options: ZoomPanOptions = {}): ZoomPan {
    const idleTouch = options.idleTouchAction ?? "none";
    const [zoom, setZoom] = useState<Zoom>(geometry.NO_ZOOM);
    const live = useRef<Zoom>(geometry.NO_ZOOM);
    const frame = useRef<HTMLElement | null>(null);
    const targets = useRef(new Set<HTMLElement>());
    const detachWheel = useRef<(() => void) | null>(null);
    const metrics = useRef<Metrics>({ left: 0, top: 0, width: 0, height: 0 });
    const shapes = useRef<{ picture: number | null; frame: number | null }>({
        picture: null,
        frame: null
    });
    const cover = useRef<Cover>(geometry.FILLS);
    const frameRequest = useRef(0);
    const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const gesturing = useRef(false);
    const pinched = useRef(false);
    const pointers = useRef(new Map<number, FramePoint>());
    const tap = useRef<{ x: number; y: number; at: number; moved: boolean } | null>(null);
    const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
    const toggledAt = useRef(0);

    /** Read the frame and what the picture covers of it. Called when a gesture
     *  starts - never per move. */
    const measureFrame = useCallback(() => {
        const node = frame.current;
        if (!node) return;
        const box = node.getBoundingClientRect();
        metrics.current = { left: box.left, top: box.top, width: box.width, height: box.height };
        const { picture, frame: frameShape } = shapes.current;
        if (picture && frameShape) {
            cover.current = geometry.coverOf(picture, frameShape);
            return;
        }
        const target = targets.current.values().next().value as HTMLElement | undefined;
        if (!target || box.width === 0 || box.height === 0 || target.offsetWidth === 0) {
            cover.current = geometry.FILLS;
            return;
        }
        cover.current = {
            x: Math.min(1, target.offsetWidth / box.width),
            y: Math.min(1, target.offsetHeight / box.height)
        };
    }, []);

    const pointAt = useCallback((event: { clientX: number; clientY: number }): FramePoint => {
        const box = metrics.current;
        if (box.width === 0 || box.height === 0) return { x: 0, y: 0 };
        return {
            x: (event.clientX - box.left) / box.width - 0.5,
            y: (event.clientY - box.top) / box.height - 0.5
        };
    }, []);

    const paint = useCallback((ease: boolean) => {
        const value = geometry.zoomTransformPx(live.current, cover.current, metrics.current);
        for (const target of targets.current) {
            target.style.transition = ease ? `transform ${STEP_MS}ms ease-out` : "";
            target.style.transform = value;
        }
    }, []);

    /** One write per frame, however many events asked for it. */
    const schedule = useCallback(() => {
        if (frameRequest.current) return;
        frameRequest.current = requestAnimationFrame(() => {
            frameRequest.current = 0;
            paint(false);
        });
    }, [paint]);

    const begin = useCallback(() => {
        if (gesturing.current) return;
        gesturing.current = true;
        pinched.current = false;
        measureFrame();
        for (const target of targets.current) {
            target.style.transition = "";
            target.style.willChange = "transform";
        }
        if (frame.current) frame.current.style.touchAction = "none";
    }, [measureFrame]);

    /** Tell React where it ended up, once. */
    const commit = useCallback(() => {
        const next = live.current;
        setZoom((current) =>
            current.scale === next.scale && current.x === next.x && current.y === next.y
                ? current
                : next
        );
        if (frame.current) {
            frame.current.style.touchAction = geometry.isZoomed(next) ? "none" : idleTouch;
        }
    }, [idleTouch]);

    const settle = useCallback(() => {
        if (!gesturing.current) return;
        gesturing.current = false;
        if (frameRequest.current) {
            cancelAnimationFrame(frameRequest.current);
            frameRequest.current = 0;
        }
        paint(false);
        for (const target of targets.current) target.style.willChange = "";
        commit();
    }, [paint, commit]);

    /** A discrete change - a button, a key, a double press: measured, eased,
     *  and committed at once. */
    const step = useCallback(
        (next: (current: Zoom, cover: Cover) => Zoom, ease = true) => {
            if (!gesturing.current) measureFrame();
            live.current = next(live.current, cover.current);
            paint(ease && !gesturing.current);
            if (!gesturing.current) commit();
        },
        [measureFrame, paint, commit]
    );

    const toggleAt = useCallback(
        (point: FramePoint) => {
            toggledAt.current = performance.now();
            step((current, covered) =>
                geometry.isZoomed(current)
                    ? geometry.NO_ZOOM
                    : geometry.zoomBy(current, geometry.ZOOM_STEP * 2, point, covered)
            );
        },
        [step]
    );

    /**
     * The wheel, attached by hand.
     *
     * React registers its own wheel listener as passive, so `preventDefault`
     * inside a JSX handler is ignored and the page scrolls (or, with ctrl held,
     * the whole page zooms) underneath - which over a picture is the view sliding
     * away while somebody tries to zoom into it.
     */
    const frameRef = useCallback(
        (node: HTMLElement | null) => {
            detachWheel.current?.();
            detachWheel.current = null;
            frame.current = node;
            if (!node) return;
            node.style.touchAction = geometry.isZoomed(live.current) ? "none" : idleTouch;
            const onWheel = (event: WheelEvent) => {
                event.preventDefault();
                begin();
                live.current = geometry.zoomBy(
                    live.current,
                    geometry.wheelFactor(event),
                    pointAt(event),
                    cover.current
                );
                schedule();
                clearTimeout(wheelTimer.current);
                wheelTimer.current = setTimeout(settle, WHEEL_SETTLE_MS);
            };
            node.addEventListener("wheel", onWheel, { passive: false });
            detachWheel.current = () => node.removeEventListener("wheel", onWheel);
        },
        [begin, pointAt, schedule, settle, idleTouch]
    );

    const targetRef = useCallback(
        (node: HTMLElement | null) => {
            if (!node) return () => {};
            targets.current.add(node);
            node.style.transformOrigin = "center";
            node.style.transform = geometry.zoomTransformPx(
                live.current,
                cover.current,
                metrics.current
            );
            return () => {
                targets.current.delete(node);
            };
        },
        []
    );

    useEffect(
        () => () => {
            cancelAnimationFrame(frameRequest.current);
            clearTimeout(wheelTimer.current);
            detachWheel.current?.();
        },
        []
    );

    const release = useCallback(
        (event?: React.PointerEvent<HTMLElement>) => {
            if (!event) pointers.current.clear();
            else pointers.current.delete(event.pointerId);
            const pressed = tap.current;
            if (event && event.pointerType === "touch" && pressed && !pressed.moved) {
                const now = performance.now();
                const before = lastTap.current;
                if (
                    before &&
                    now - before.at < DOUBLE_TAP_MS &&
                    Math.hypot(event.clientX - before.x, event.clientY - before.y) < DOUBLE_TAP_PX
                ) {
                    lastTap.current = null;
                    tap.current = null;
                    settle();
                    toggleAt(pointAt(event));
                    return;
                }
                lastTap.current = { x: event.clientX, y: event.clientY, at: now };
            }
            if (pointers.current.size === 0) {
                tap.current = null;
                settle();
            }
        },
        [settle, toggleAt, pointAt]
    );

    const zoomIn = useCallback(
        () =>
            step((current, covered) =>
                geometry.zoomBy(current, geometry.ZOOM_STEP, undefined, covered)
            ),
        [step]
    );
    const zoomOut = useCallback(
        () =>
            step((current, covered) =>
                geometry.zoomBy(current, 1 / geometry.ZOOM_STEP, undefined, covered)
            ),
        [step]
    );
    const reset = useCallback(
        (resetOptions?: { readonly animate?: boolean }) =>
            step(() => geometry.NO_ZOOM, resetOptions?.animate ?? true),
        [step]
    );

    const measure = useCallback((picture: number | null, frameShape: number | null) => {
        shapes.current = { picture, frame: frameShape };
        cover.current = geometry.coverOf(picture, frameShape);
        live.current = geometry.clampOffset(live.current, cover.current);
    }, []);

    return {
        frameRef,
        targetRef,
        frameProps: {
            // A second press puts it back rather than pushing further in: the
            // way out has to be as easy as the way in. A double-tap already did
            // it, and the browser may follow that with a dblclick of its own.
            onDoubleClick: (event) => {
                if (performance.now() - toggledAt.current < 500) return;
                measureFrame();
                toggleAt(pointAt(event));
            },
            onPointerDown: (event) => {
                if (event.pointerType === "mouse" && event.button !== 0) return;
                if (pointers.current.size === 0) measureFrame();
                pointers.current.set(event.pointerId, pointAt(event));
                if (pointers.current.size === 1) {
                    tap.current = {
                        x: event.clientX,
                        y: event.clientY,
                        at: performance.now(),
                        moved: false
                    };
                }
                // A single pointer only moves a zoomed picture; two always pinch.
                if (pointers.current.size < 2 && !geometry.isZoomed(live.current)) return;
                begin();
                if (pointers.current.size >= 2) pinched.current = true;
                try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                    // A pointer that is already gone cannot be captured.
                }
            },
            onPointerMove: (event) => {
                const from = pointers.current.get(event.pointerId);
                if (!from) return;
                const pressed = tap.current;
                if (
                    pressed &&
                    Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > TAP_SLOP
                ) {
                    pressed.moved = true;
                }
                if (!gesturing.current) return;
                const to = pointAt(event);
                if (pointers.current.size >= 2) {
                    const [first, second] = [...pointers.current.entries()];
                    const other = first![0] === event.pointerId ? second![1] : first![1];
                    const before: [FramePoint, FramePoint] = [from, other];
                    const after: [FramePoint, FramePoint] = [to, other];
                    live.current = geometry.pinchBy(live.current, before, after, cover.current);
                } else {
                    const { x, y } = { x: to.x - from.x, y: to.y - from.y };
                    live.current = geometry.panBy(live.current, x, y, cover.current);
                }
                pointers.current.set(event.pointerId, to);
                schedule();
            },
            onPointerUp: release,
            onPointerCancel: release
        },
        transform: geometry.zoomTransformPx(zoom, cover.current, metrics.current),
        zoom,
        zoomed: geometry.isZoomed(zoom),
        engaged: () => geometry.isZoomed(live.current) || (gesturing.current && pinched.current),
        zoomIn,
        zoomOut,
        reset,
        measure
    };
}

export const { MAX_ZOOM, NO_ZOOM, ZOOM_STEP } = geometry;
