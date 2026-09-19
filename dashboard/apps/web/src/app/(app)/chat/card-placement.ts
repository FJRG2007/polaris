/**
 * Where a card about somebody opens, given what was pressed.
 *
 * Beside it, the way every chat client puts one: to the right of a name or a
 * face, with its top level with what was pressed, so the eye does not have to go
 * looking. To the left when the right has no room - a name in a roster down the
 * right-hand edge. Underneath when neither side has room, which is a phone. And
 * always wholly on screen: a card cut off by the bottom of the window hides the
 * buttons, which are the part anybody opened it for.
 */

export interface Box {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

export interface Size {
    readonly width: number;
    readonly height: number;
}

/** Space kept between the card and what was pressed. */
const GAP = 8;
/** Space kept between the card and the edge of the window. */
const MARGIN = 8;

export function placeCard(anchor: Box, card: Size, view: Size): { left: number; top: number } {
    const fitsRight = anchor.right + GAP + card.width <= view.width - MARGIN;
    const fitsLeft = anchor.left - GAP - card.width >= MARGIN;

    if (fitsRight || fitsLeft) {
        const left = fitsRight ? anchor.right + GAP : anchor.left - GAP - card.width;
        return { left, top: clamp(anchor.top, MARGIN, view.height - MARGIN - card.height) };
    }

    // Neither side: under it, or over it when there is more room above.
    const left = clamp(anchor.left, MARGIN, view.width - MARGIN - card.width);
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - card.height;
    const top = below + card.height <= view.height - MARGIN || above < MARGIN ? below : above;
    return { left, top: clamp(top, MARGIN, view.height - MARGIN - card.height) };
}

/** Within the bounds, and at the low one when the two cross - a card taller than
 *  the window starts at the top, where its name is. */
function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(value, high));
}
