"use client";

/**
 * What the camera was actually looking at, drawn over the picture it kept.
 *
 * A still with no box is a picture of a garden, and the reader has to find the
 * person in it themselves - at a thumbnail size, at night, that is most of the
 * work of reviewing a camera. The box is the difference between "something
 * happened" and "here is what happened, and it was there".
 *
 * Coordinates are fractions of the frame, so this is percentages and nothing
 * else: no measuring, no resize observer, and it stays correct at every size the
 * same picture is drawn at. The picture it sits over has to be drawn whole
 * rather than cropped to fill - a box over a cropped picture points at the wrong
 * part of it, which is worse than no box at all.
 *
 * Percentages of the picture, though, and not of the tile it was dropped into.
 * A still keeps the camera's own shape, and a 4:3 camera in a 16:9 tile is drawn
 * with a bar down each side - so the two shapes are what says where the picture
 * actually is, and the box is placed inside that rather than over the whole
 * tile. Until the still has loaded there is nothing to know, and the tile is the
 * best guess available.
 */

import { cn } from "@polaris/ui";
import type { CSSProperties } from "react";

/**
 * Where the picture sits inside the box it was drawn in.
 *
 * Both shapes are width over height. The picture is scaled until it just fits,
 * so one axis fills and the other is the ratio of the two shapes - and centred,
 * which is what `m-auto` against a full inset does with the size below.
 */
function pictureFrame(
    picture: number | null | undefined,
    tile: number | null | undefined
): CSSProperties {
    const usable = (value: number | null | undefined): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0;
    if (!usable(picture) || !usable(tile)) return {};
    return {
        width: `${Math.min(1, picture / tile) * 100}%`,
        height: `${Math.min(1, tile / picture) * 100}%`
    };
}

export function DetectionBox({
    box,
    label,
    className,
    picture,
    tile
}: {
    box: { x1: number; y1: number; x2: number; y2: number } | null;
    /** Drawn against the top edge of the box when there is room for it. */
    label?: string | null;
    className?: string;
    /** The still's own shape, width over height, once it is known. */
    picture?: number | null;
    /** The shape of the element the still was drawn in. */
    tile?: number | null;
}) {
    if (!box) return null;
    const width = box.x2 - box.x1;
    const height = box.y2 - box.y1;
    if (width <= 0 || height <= 0) return null;

    return (
        <span
            aria-hidden
            className="pointer-events-none absolute inset-0 m-auto"
            style={pictureFrame(picture, tile)}
        >
            <span
                className={cn(
                    "absolute rounded-[3px] border-2 border-primary shadow-[0_0_0_1px_rgba(0,0,0,0.5)]",
                    className
                )}
                style={{
                    left: `${box.x1 * 100}%`,
                    top: `${box.y1 * 100}%`,
                    width: `${width * 100}%`,
                    height: `${height * 100}%`
                }}
            >
                {label ? (
                    <span className="absolute -top-px left-0 -translate-y-full whitespace-nowrap rounded-t-[3px] bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
                        {label}
                    </span>
                ) : null}
            </span>
        </span>
    );
}
