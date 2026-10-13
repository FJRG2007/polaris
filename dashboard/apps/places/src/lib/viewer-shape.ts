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
