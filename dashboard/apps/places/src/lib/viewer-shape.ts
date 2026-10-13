/**
 * The shape the camera viewer is drawn at.
 *
 * Whatever a camera's stream description says, the picture it sends can be
 * another shape, and a fixed 16:9 box draws a narrower one with black bands
 * down both sides. So the box follows the picture as measured off the element
 * that shows it, and 16:9 is only where it starts.
 *
 * Client-safe: pure.
 */

/** Width over height before anything has been measured. */
export const DEFAULT_SHAPE = 16 / 9;

/** How tall the dialog may be, as a share of the window, from the dialog's own cap. */
const MAX_HEIGHT = "85dvh";

/** The widest the dialog is drawn, from its `max-w-5xl`. */
const MAX_WIDTH = "64rem";

/**
 * The picture's shape: from the element's own size when it has one, otherwise
 * the last one measured, otherwise 16:9. A size of nothing (an element that has
 * not decoded yet) is not a shape and never replaces one.
 */
export function pictureShape(
    known: number | null,
    measured?: { width: number; height: number }
): number {
    if (measured && measured.width > 0 && measured.height > 0) {
        return measured.width / measured.height;
    }
    return known !== null && Number.isFinite(known) && known > 0 ? known : DEFAULT_SHAPE;
}

/**
 * The box the still and the stream share, and how wide the dialog around it may
 * be: a tall picture narrows the dialog rather than overflowing the window.
 */
export function viewerFrame(shape: number | null): { aspectRatio: string; maxWidth: string } {
    const ratio = pictureShape(shape);
    return {
        aspectRatio: String(ratio),
        maxWidth: `min(${MAX_WIDTH}, calc(${MAX_HEIGHT} * ${ratio}))`
    };
}

/**
 * A stream's shape, from the most trustworthy measurement there is.
 *
 * A `<video>`'s own size is not its picture's: a stream can declare a pixel
 * shape of its own (some cameras' do, wrongly), and the browser then reports
 * and draws a 2304x1296 picture as 4:3 - every timestamp and face a third
 * taller than it is. So the pixels actually decoded (`coded`) come first, then
 * the shape of a still (decoded by the relay, square pixels), and the
 * element's own report only when there is neither - fresh on every call, so a
 * stream that changes size in-band is followed even where no frame can be read.
 */
export function streamShape(
    still: number | null,
    coded: number | null,
    reported?: { width: number; height: number }
): number {
    if (coded !== null && Number.isFinite(coded) && coded > 0) return coded;
    if (still !== null && Number.isFinite(still) && still > 0) return still;
    return pictureShape(null, reported);
}

/**
 * Where the stream is drawn in the viewer: its own shape, as large as fits the
 * frame (the dialog, or the whole screen) and centred in it.
 *
 * The element is given the picture's shape rather than left to the browser,
 * and the picture fills it exactly (`object-fill`), because the browser's idea
 * of the stream's shape is the one that can be wrong (see `streamShape`).
 */
export function streamBox(shape: number | null): { aspectRatio: string; width: string } {
    const ratio = pictureShape(shape);
    return { aspectRatio: String(ratio), width: `min(100%, calc(100dvh * ${ratio}))` };
}

/**
 * The size, as a share of a box of shape `surface`, of a picture of shape
 * `picture` drawn to cover it: a wider picture is full height and overhangs on
 * the sides, a narrower one full width and overhangs above and below. Centred
 * by the caller, which crops the overhang.
 */
export function coverBox(
    picture: number | null,
    surface: number
): { width: string; height: string } {
    const ratio = pictureShape(picture);
    if (ratio >= surface)
        return { width: `${((ratio / surface) * 100).toFixed(4)}%`, height: "100%" };
    return { width: "100%", height: `${((surface / ratio) * 100).toFixed(4)}%` };
}
