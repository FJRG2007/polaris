/**
 * Zooming into a picture that is already on screen.
 *
 * The phone app lets you push into the picture to read a number plate or see who
 * is at the gate, and it is the thing people reach for first once a camera is
 * open. It costs nothing at the camera: the frame that arrived is the frame that
 * arrived, and this only decides which part of it fills the screen.
 *
 * Two rules, and both of them are about never showing somebody the void:
 *
 *   - The picture always covers the frame. A pan that would bring an edge inside
 *     the frame is clamped at the edge, so there is no way to end up looking at
 *     a black margin and wondering whether the camera moved.
 *   - Zooming happens towards a point. Pushing in with the pointer over the gate
 *     keeps the gate under the pointer, rather than diving at the centre of the
 *     picture and leaving the reader to find the gate again.
 *
 * Pure, and separate from the viewer that draws it, because the clamping is the
 * part that is wrong in every hand-rolled version of this and it is arithmetic
 * rather than something to verify by dragging at a camera.
 */

/** Where the picture sits, as a scale and a shift. The shift is in fractions of
 *  the frame, so it survives the frame being resized or going fullscreen. */
export interface Zoom {
    readonly scale: number;
    readonly x: number;
    readonly y: number;
}

/**
 * How much of the frame the picture actually covers when nothing is zoomed.
 *
 * Never larger than the frame in either direction, and smaller in one of them
 * whenever the camera's shape is not the frame's - the picture is drawn to fit
 * inside rather than to fill, so a 4:3 doorbell in a 16:9 dialog has a bar down
 * each side and covers `{ x: 0.75, y: 1 }`.
 *
 * This is the thing the clamping has to be measured against. Measured against
 * the frame instead, the picture can be dragged until one of those bars is in
 * the middle of the screen, which reads as a camera that has come loose from its
 * mount rather than as a control that let go.
 */
export interface Cover {
    readonly x: number;
    readonly y: number;
}

/** A picture that fills the frame, which is what a camera the same shape as the
 *  dialog does and what the pure callers assume when they say nothing. */
export const FILLS: Cover = { x: 1, y: 1 };

/** What a picture of this shape covers in a frame of that shape. Both are width
 *  over height; either being unknown means "assume it fills", which is what the
 *  first frame is drawn under. */
export function coverOf(picture: number | null | undefined, frame: number | null | undefined): Cover {
    if (!picture || !frame || picture <= 0 || frame <= 0) return FILLS;
    // Wider than the frame: it fits across and leaves a bar above and below.
    return picture > frame ? { x: 1, y: frame / picture } : { x: picture / frame, y: 1 };
}

/** Not zoomed at all, which is where every camera opens. */
export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

/** How far in it goes. Eight times is past the point where a 2K frame has any
 *  detail left to show; more than that is magnifying the compression. */
export const MAX_ZOOM = 8;

/** Steps for the buttons and the keyboard, which need a fixed one - a wheel
 *  carries its own amount and does not use this. */
export const ZOOM_STEP = 1.5;

/** Whether anything is zoomed. Read by the viewer to decide whether dragging
 *  pans the picture or does nothing. */
export function isZoomed(zoom: Zoom): boolean {
    return zoom.scale > 1.001;
}

function clampScale(scale: number): number {
    if (!Number.isFinite(scale)) return 1;
    return Math.min(MAX_ZOOM, Math.max(1, scale));
}

/**
 * The shift, held inside what the picture can actually cover.
 *
 * At a scale of `s` the picture covers `s * cover` of the frame, so it can be
 * moved by half of whatever that is over one before its edge comes into view.
 * Where it does not reach across the frame at all - a narrow picture at a low
 * zoom - there is no room and it stays in the middle, which is also what puts it
 * back the moment somebody zooms all the way out.
 */
export function clampOffset(zoom: Zoom, cover: Cover = FILLS): Zoom {
    const scale = clampScale(zoom.scale);
    const roomIn = (reach: number) => Math.max(0, (scale * reach - 1) / 2);
    const hold = (value: number, reach: number) => {
        if (!Number.isFinite(value)) return 0;
        const room = roomIn(Number.isFinite(reach) && reach > 0 ? reach : 1);
        const held = Math.min(room, Math.max(-room, value));
        // Clamping to zero from below yields negative zero, which compares equal
        // to zero and prints as "-0.0000%". Not wrong, and not what anybody wants
        // to find in a transform they are reading.
        return held === 0 ? 0 : held;
    };
    return { scale, x: hold(zoom.x, cover.x), y: hold(zoom.y, cover.y) };
}

/**
 * Zoom by a factor, towards a point in the frame.
 *
 * `at` is where the pointer is, in fractions of the frame from its centre: -0.5
 * is the left or top edge, 0.5 the right or bottom, and { x: 0, y: 0 } the
 * middle - which is what the buttons and the keyboard pass, since they have no
 * pointer to zoom towards.
 *
 * The arithmetic is the same either way: whatever is under that point has to
 * still be under it afterwards, so the shift moves by the point's distance from
 * the centre times the change in scale.
 */
export function zoomBy(
    zoom: Zoom,
    factor: number,
    at: { x: number; y: number } = { x: 0, y: 0 },
    cover: Cover = FILLS
): Zoom {
    const scale = clampScale(zoom.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1));
    // Clamped first, so a factor that would take it past either end moves the
    // picture by the amount it actually zoomed rather than by the amount asked
    // for - otherwise holding the wheel at full zoom keeps panning.
    const applied = scale / zoom.scale;
    const shift = (value: number, point: number) => value * applied - point * (applied - 1);
    return clampOffset({ scale, x: shift(zoom.x, at.x), y: shift(zoom.y, at.y) }, cover);
}

/**
 * Drag the picture by a distance, in fractions of the frame.
 *
 * Added as it comes, not divided by the scale. The offset IS the shift on
 * screen, so what the pointer moved is what the picture moves - the picture
 * stays under the finger, which is the only behaviour a drag can have without
 * feeling broken. That it covers less of the picture when zoomed in follows by
 * itself, because there is more picture per pixel of frame.
 */
export function panBy(zoom: Zoom, dx: number, dy: number, cover: Cover = FILLS): Zoom {
    if (!isZoomed(zoom)) return zoom;
    return clampOffset(
        {
            scale: zoom.scale,
            x: zoom.x + (Number.isFinite(dx) ? dx : 0),
            y: zoom.y + (Number.isFinite(dy) ? dy : 0)
        },
        cover
    );
}

/**
 * The CSS transform for a zoom.
 *
 * The order is load-bearing and it is the opposite of the one that reads
 * naturally. A browser applies the rightmost function first, so
 * `translate(...) scale(...)` scales the picture and then shifts the result -
 * which is what the offset here means: a share of the FRAME, the same at every
 * scale. Written the other way round the shift would be scaled too, and the
 * clamping below it - which is in frame fractions - would let the picture be
 * dragged off its own edge by a factor of the zoom.
 */
export function zoomTransform(zoom: Zoom, cover: Cover = FILLS): string {
    const { scale, x, y } = clampOffset(zoom, cover);
    return `translate(${(x * 100).toFixed(4)}%, ${(y * 100).toFixed(4)}%) scale(${scale})`;
}
