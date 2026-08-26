"use client";

/**
 * Framing a picture before it is uploaded.
 *
 * Every picture Polaris stores is drawn at one shape - a face in a circle, a
 * space in a rounded square, a banner in a 3:1 band - so something has to decide
 * which part of the photograph survives. That used to be the middle, silently:
 * you chose a file and the middle of it became your face, which for a photograph
 * of two people standing apart is the gap between them.
 *
 * So the crop is a question now, asked once, in the shape the answer will be
 * drawn in. Drag to move, zoom to fill, and what is inside the frame is exactly
 * what everybody else will see. Doing nothing and pressing Save gives the middle
 * - the old behaviour is the default, not the only option.
 *
 * The framing is held as a point of the image (0..1 on each axis) plus a zoom
 * rather than as pixels on screen, so the frame can be measured, resized by a
 * phone rotating, or drawn at any size without the picture jumping.
 *
 * The result is re-encoded here, in the browser: it costs nothing, it means a
 * phone photo does not arrive as eight megabytes of something drawn 24 pixels
 * wide, and re-encoding drops the EXIF block - which on a phone photo carries
 * the place and time it was taken, and which nobody setting a profile picture
 * means to publish. The server checks the bytes again regardless: this runs on
 * the uploader's machine, so it is a courtesy rather than a control.
 */

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/** What a picture is being cut to, wherever it will be drawn. */
export interface CropShape {
    /** Width over height of the finished picture. */
    ratio: number;
    /** Whether it is drawn as a circle, so it is framed as one. */
    round: boolean;
    /** The widest the finished picture is written. Wider than anywhere it is
     *  drawn, and far short of what a camera hands you. */
    maxWidth: number;
}

/** A face: drawn in a circle everywhere, at 512 for the largest place it
 *  appears. */
export const FACE_CROP: CropShape = { ratio: 1, round: true, maxWidth: 512 };

/** A square picture that is not a face - an organization, a space. Same size,
 *  drawn with a corner radius rather than as a circle. */
export const TILE_CROP: CropShape = { ratio: 1, round: false, maxWidth: 512 };

/** The band across a profile, at the proportions every client that has one
 *  settled on. */
export const BAND_CROP: CropShape = { ratio: 3, round: false, maxWidth: 1200 };

export const CROP_ACCEPTED = "image/png,image/jpeg,image/webp,image/gif";

/** How far in the picture can be pushed. Past this a photograph is being
 *  enlarged past its own detail, which no crop can make look better. */
const MAX_ZOOM = 5;

/** How much room is left above and below the frame for the part of the picture
 *  that is being cut off, dimmed rather than hidden. Sideways it gets whatever
 *  the dialog has spare, which is usually more. */
const SPILL = 24;

/** The widest the frame is drawn, by how wide the shape is. A band gets more
 *  room because it is short; a square that used all of it would push the buttons
 *  off a laptop screen. */
function frameCap(ratio: number): number {
    return ratio >= 2 ? 440 : 288;
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

/** Where the frame sits on the picture, in the picture's own terms: the point at
 *  the middle of the frame, each axis 0..1, and how far in it is zoomed. */
interface Framing {
    x: number;
    y: number;
    zoom: number;
}

const CENTRED: Framing = { x: 0.5, y: 0.5, zoom: 1 };

/**
 * The part of the picture the frame is over, in source pixels.
 *
 * At zoom 1 this is the largest rectangle of the wanted shape that fits inside
 * the picture, centred - which is the crop Polaris used to take without asking.
 * Zooming shrinks it; the centre is clamped so the frame can never hang off the
 * edge and leave a strip of nothing in somebody's banner.
 *
 * The whole of the cropping is this function: everything else is pointers and
 * pixels on a screen. Exported so it can be checked without one.
 */
export function cropRect(
    width: number,
    height: number,
    shape: CropShape,
    framing: Framing
): { x: number; y: number; width: number; height: number } {
    const coverWidth = Math.min(width, height * shape.ratio);
    const cropWidth = coverWidth / framing.zoom;
    const cropHeight = cropWidth / shape.ratio;
    const centreX = clamp(framing.x * width, cropWidth / 2, width - cropWidth / 2);
    const centreY = clamp(framing.y * height, cropHeight / 2, height - cropHeight / 2);
    return {
        x: centreX - cropWidth / 2,
        y: centreY - cropHeight / 2,
        width: cropWidth,
        height: cropHeight
    };
}

/** The distance between two pointers, which is what a pinch is. */
function spread(points: Map<number, { x: number; y: number }>): number {
    const [first, second] = [...points.values()];
    if (!first || !second) return 0;
    return Math.hypot(first.x - second.x, first.y - second.y);
}

export function ImageCropDialog({
    file,
    shape,
    busy = false,
    onCancel,
    onCropped
}: {
    /** The file that was just chosen. Nothing has been sent yet. */
    file: File;
    shape: CropShape;
    /** Whether the caller is still sending the last one, so the button says so
     *  rather than looking like it did nothing. */
    busy?: boolean;
    onCancel: () => void;
    /** The finished picture, cut and re-encoded. */
    onCropped: (blob: Blob) => void;
}) {
    const picture = useRef<HTMLImageElement>(null);
    // The stage is state rather than a ref: it lives inside a portal, which
    // mounts a commit later than this component, so a ref read in the first
    // effect is still null and an effect that ran once would never look again -
    // leaving the frame unmeasured and the picture invisible.
    const [stage, setStage] = useState<HTMLDivElement | null>(null);
    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const pinch = useRef<{ spread: number; zoom: number } | null>(null);

    const [source, setSource] = useState<{ width: number; height: number } | null>(null);
    const [framing, setFraming] = useState<Framing>(CENTRED);
    const [boardWidth, setBoardWidth] = useState(0);
    const [error, setError] = useState("");
    const [cutting, setCutting] = useState(false);

    const url = useMemo(() => URL.createObjectURL(file), [file]);
    useEffect(() => () => URL.revokeObjectURL(url), [url]);

    // Measured rather than fixed: the dialog is narrower on a phone than on a
    // laptop, and a frame wider than the dialog is one whose right-hand edge
    // nobody can see.
    useEffect(() => {
        if (!stage) return;
        const measure = () => setBoardWidth(stage.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(stage);
        return () => observer.disconnect();
    }, [stage]);

    const frameWidth = Math.max(0, Math.min(boardWidth - SPILL * 2, frameCap(shape.ratio)));
    const frameHeight = frameWidth / shape.ratio;
    // Centred sideways in whatever the dialog is wide, so the two halves of the
    // picture that are being cut off are shown in equal measure.
    const frameLeft = Math.max(0, (boardWidth - frameWidth) / 2);
    const crop = source ? cropRect(source.width, source.height, shape, framing) : null;
    // Pixels on screen per pixel of the picture. Everything the pointer does is
    // in screen pixels and everything held in state is in the picture's, so this
    // is the only conversion there is.
    const drawn = crop && frameWidth > 0 ? frameWidth / crop.width : 0;

    /**
     * Move the frame by so many pixels on screen.
     *
     * Held between the same edges the crop itself is clamped to, rather than
     * anywhere in 0..1: a drag that ran past the edge would otherwise bank
     * distance the picture never moved, and dragging back would do nothing until
     * that debt was paid off.
     */
    const nudge = (dx: number, dy: number) => {
        if (!source || !crop || !drawn) return;
        const halfX = crop.width / 2 / source.width;
        const halfY = crop.height / 2 / source.height;
        setFraming((was) => ({
            ...was,
            x: clamp(was.x + dx / (source.width * drawn), halfX, 1 - halfX),
            y: clamp(was.y + dy / (source.height * drawn), halfY, 1 - halfY)
        }));
    };

    const setZoom = (zoom: number) => setFraming((was) => ({ ...was, zoom: clamp(zoom, 1, MAX_ZOOM) }));

    // A native listener because React's wheel handler is passive: preventDefault
    // inside it does nothing, and the page scrolls under the picture instead of
    // the picture zooming.
    useEffect(() => {
        if (!stage) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            setFraming((was) => ({ ...was, zoom: clamp(was.zoom * Math.exp(-event.deltaY / 400), 1, MAX_ZOOM) }));
        };
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => stage.removeEventListener("wheel", onWheel);
    }, [stage]);

    const save = async () => {
        const image = picture.current;
        if (!image || !crop) return;
        setCutting(true);
        try {
            const width = Math.max(1, Math.round(Math.min(shape.maxWidth, crop.width)));
            const height = Math.max(1, Math.round(width / shape.ratio));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("no canvas");
            // A phone photo is being reduced to a fraction of its size here, and
            // the default resampling makes that look like a screenshot of a
            // screenshot.
            context.imageSmoothingQuality = "high";
            context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
            const blob = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, "image/webp", 0.9)
            );
            if (!blob) throw new Error("no blob");
            onCropped(blob);
        } catch {
            setError("This browser could not save that picture");
        } finally {
            // Put back either way. The caller normally takes the dialog away at
            // this point, but a caller that keeps it open must not be left with
            // a Save button that never comes back.
            setCutting(false);
        }
    };

    const working = busy || cutting;

    return (
        <Dialog open onOpenChange={(next) => !next && !working && onCancel()}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Frame the picture</DialogTitle>
                    <DialogDescription>
                        What is inside the frame is what everybody else sees. Drag it to move, and use
                        the slider to zoom.
                    </DialogDescription>
                </DialogHeader>

                <div
                    ref={setStage}
                    // touch-none, or a drag on a phone scrolls the dialog instead
                    // of moving the picture.
                    className="relative flex touch-none items-center justify-center overflow-hidden rounded-lg bg-surface"
                    style={{ height: frameHeight > 0 ? frameHeight + SPILL * 2 : undefined }}
                    onPointerDown={(event) => {
                        if (!source) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                        if (pointers.current.size === 2) {
                            pinch.current = { spread: spread(pointers.current), zoom: framing.zoom };
                        }
                    }}
                    onPointerMove={(event) => {
                        const held = pointers.current.get(event.pointerId);
                        if (!held) return;
                        const next = { x: event.clientX, y: event.clientY };
                        pointers.current.set(event.pointerId, next);
                        if (pointers.current.size >= 2) {
                            const started = pinch.current;
                            const now = spread(pointers.current);
                            if (started && started.spread > 0 && now > 0) {
                                setZoom((started.zoom * now) / started.spread);
                            }
                            return;
                        }
                        // Dragging moves the picture, so the frame moves the
                        // other way over it.
                        nudge(-(next.x - held.x), -(next.y - held.y));
                    }}
                    onPointerUp={(event) => {
                        pointers.current.delete(event.pointerId);
                        pinch.current = null;
                    }}
                    onPointerCancel={(event) => {
                        pointers.current.delete(event.pointerId);
                        pinch.current = null;
                    }}
                >
                    <img
                        ref={picture}
                        src={url}
                        alt=""
                        draggable={false}
                        onLoad={(event) =>
                            setSource({
                                width: event.currentTarget.naturalWidth,
                                height: event.currentTarget.naturalHeight
                            })
                        }
                        onError={() => setError("That file could not be read as an image")}
                        className="pointer-events-none absolute max-w-none select-none"
                        style={
                            source && crop && drawn
                                ? {
                                      width: source.width * drawn,
                                      height: source.height * drawn,
                                      left: frameLeft + frameWidth / 2 - (crop.x + crop.width / 2) * drawn,
                                      top: SPILL + frameHeight / 2 - (crop.y + crop.height / 2) * drawn
                                  }
                                : { visibility: "hidden" }
                        }
                    />
                    {/* The frame itself: a hole punched in a dimmed sheet, so what
                        is about to be cut off is still visible while it is being
                        cut off. The sheet is this element's own shadow, which is
                        the only way to get a hole with a radius. */}
                    <div
                        aria-hidden
                        className={`pointer-events-none absolute ring-1 ring-inset ring-white/40 ${
                            shape.round ? "rounded-full" : "rounded-md"
                        }`}
                        style={{
                            left: frameLeft,
                            top: SPILL,
                            width: frameWidth,
                            height: frameHeight,
                            boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.55)"
                        }}
                    />
                    {/* Focusable and nudged with the arrow keys: a framing only a
                        mouse can express is one a keyboard cannot express at all.
                        Sits over the picture rather than around it so the focus
                        ring follows the frame. */}
                    <div
                        tabIndex={0}
                        role="group"
                        aria-label="Move the picture inside the frame with the arrow keys"
                        className={`absolute cursor-move ${shape.round ? "rounded-full" : "rounded-md"}`}
                        style={{ left: frameLeft, top: SPILL, width: frameWidth, height: frameHeight }}
                        onKeyDown={(event) => {
                            const step = event.shiftKey ? 1 : 8;
                            const moves: Record<string, [number, number]> = {
                                ArrowLeft: [-step, 0],
                                ArrowRight: [step, 0],
                                ArrowUp: [0, -step],
                                ArrowDown: [0, step]
                            };
                            const move = moves[event.key];
                            if (move) {
                                event.preventDefault();
                                nudge(move[0], move[1]);
                            }
                        }}
                    />
                </div>

                <label className="mt-3 flex items-center gap-3 text-xs">
                    <span className="text-foreground-subtle font-medium">Zoom</span>
                    <input
                        type="range"
                        min={100}
                        max={MAX_ZOOM * 100}
                        step={1}
                        value={Math.round(framing.zoom * 100)}
                        disabled={!source}
                        aria-label="Zoom"
                        onChange={(event) => setZoom(Number(event.target.value) / 100)}
                        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary"
                    />
                </label>

                {error && (
                    <p role="alert" className="text-danger mt-3 text-sm">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" disabled={working} onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button disabled={working || !source || Boolean(error)} onClick={() => void save()}>
                        {working ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
