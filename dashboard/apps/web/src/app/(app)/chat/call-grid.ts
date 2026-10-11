"use client";

/**
 * How big each face in a call is, so the grid looks like every voice channel
 * people already know: wide 16:9 tiles, as large as the panel allows, and a short
 * last row centred under the others rather than left hanging on the left.
 *
 * Measured rather than a column lookup: a fixed number of columns stretches each
 * tile to whatever height the panel happens to have, which turned five faces in a
 * tall panel into five portrait strips. The panel is only measured when it
 * changes size, never per frame.
 */

import { useEffect, useState } from "react";

/** A video frame's shape. Cameras and screens both send 16:9. */
export const TILE_RATIO = 16 / 9;

/**
 * How far a camera's shape may be from its tile's before cropping it to fill the
 * tile stops being a trim and starts being a different picture. 4:3 in a 16:9
 * tile is a third apart and loses a little above and below; an upright phone in
 * a wide tile is three times apart and would keep only a strip across the face.
 */
export const COVER_WITHIN = 1.4;

/**
 * Whether a picture is cropped to fill its tile (true) or shown whole inside it
 * (false). Either way it keeps its own shape - nothing here ever stretches a
 * picture to fit. Unknown shapes fill, which is how a tile drew before either
 * was measured.
 */
export function fillsTile(picture: number | null, tile: number | null): boolean {
    if (!picture || !tile || picture <= 0 || tile <= 0) return true;
    const apart = picture > tile ? picture / tile : tile / picture;
    return apart <= COVER_WITHIN;
}

export interface TileFit {
    readonly columns: number;
    readonly width: number;
    readonly height: number;
}

/**
 * The column count that gives `count` tiles of `ratio` the largest size inside a
 * `width` x `height` box with `gap` between them. Every count is tried: with a
 * room of a few dozen at most it is a handful of divisions.
 */
export function fitTiles(
    count: number,
    width: number,
    height: number,
    gap: number,
    ratio = TILE_RATIO
): TileFit {
    let best: TileFit = { columns: 1, width: 0, height: 0 };
    if (count < 1 || width <= 0 || height <= 0) return best;
    for (let columns = 1; columns <= count; columns++) {
        const rows = Math.ceil(count / columns);
        const across = (width - gap * (columns - 1)) / columns;
        const down = (height - gap * (rows - 1)) / rows;
        const tileWidth = Math.floor(Math.min(across, down * ratio));
        if (tileWidth > best.width)
            best = { columns, width: tileWidth, height: Math.floor(tileWidth / ratio) };
    }
    return best;
}

/** The size each of `count` tiles should take in the element the ref is on.
 *  Zero until the element has been measured. A callback ref, because the grid
 *  comes and goes with the call's layout and has to be measured again each time
 *  it is mounted. */
export function useTileFit<T extends HTMLElement>(count: number, gap: number) {
    const [node, ref] = useState<T | null>(null);
    const [box, setBox] = useState({ width: 0, height: 0 });
    useEffect(() => {
        // Absent in old browsers and in tests: the even grid and the full-size
        // face stand in, which is what a call looked like before.
        if (!node || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => {
            if (!entry) return;
            const { width, height } = entry.contentRect;
            setBox((was) =>
                was.width === width && was.height === height ? was : { width, height }
            );
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [node]);
    return { ref, fit: fitTiles(count, box.width, box.height, gap) };
}

/** The largest a face in an empty tile is drawn. */
export const FACE_MAX = 72;
/** The smallest: below this the initials stop being readable. */
const FACE_MIN = 28;

/** How big the face in a tile `height` pixels tall is: under half the tile, so
 *  the name in the corner never runs into it, and never past `FACE_MAX`. Equal
 *  tiles get equal faces, so the grid still reads as one size. */
export function faceSize(height: number): number {
    if (height <= 0) return FACE_MAX;
    return Math.max(FACE_MIN, Math.min(FACE_MAX, Math.floor(height * 0.42)));
}

/** The face size for the tile a ref is on, following the tile as it resizes. */
export function useFaceSize(frame: { readonly current: HTMLElement | null }): number {
    const [height, setHeight] = useState(0);
    useEffect(() => {
        const node = frame.current;
        // Absent in old browsers and in tests: the even grid and the full-size
        // face stand in, which is what a call looked like before.
        if (!node || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setHeight(entry.contentRect.height);
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [frame]);
    return faceSize(height);
}
