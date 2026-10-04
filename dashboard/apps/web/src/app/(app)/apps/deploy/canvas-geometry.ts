/**
 * The arithmetic behind the project canvas: where a line between two services
 * leaves one card and enters the other, how far the board may zoom, and the
 * zoom and scroll that frame every service at once.
 *
 * Pure, and kept apart from the board that draws it, because these are the
 * parts that are wrong in every hand-rolled canvas - a line drawn from card
 * centre to card centre runs underneath both cards, a zoom that does not hold
 * the point under the pointer loses the reader's place - and they are numbers
 * to assert rather than things to verify by dragging cards around.
 */

export interface Point {
    x: number;
    y: number;
}

/** A card's footprint on the board, in board coordinates (zoom 1). */
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 1.5;
/** One press of zoom in or out. Multiplied, so in-then-out lands where it began. */
export const ZOOM_STEP = 1.2;

/** A zoom level inside the range the board supports. Not rounded: a trackpad
 *  pinch arrives as many tiny steps, and rounding each one away would leave the
 *  board stuck at the level it started from. The label rounds instead. */
export function clampZoom(zoom: number): number {
    if (!Number.isFinite(zoom)) return 1;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** The line between two cards, and the point halfway along it. */
export interface EdgePath {
    d: string;
    mid: Point;
}

/**
 * A curve between two cards that leaves and enters through their facing sides.
 *
 * Side by side, it runs from the right edge of the left card to the left edge of
 * the right one; stacked, from the bottom of the upper card to the top of the
 * lower. Overlapping cards (one dragged onto another) fall back to the sides, so
 * a line is always drawn and never collapses to a point.
 */
export function edgePath(from: Rect, to: Rect): EdgePath {
    const horizontalGap = Math.max(to.x - (from.x + from.w), from.x - (to.x + to.w));
    const verticalGap = Math.max(to.y - (from.y + from.h), from.y - (to.y + to.h));
    const sideBySide = horizontalGap >= verticalGap;

    let start: Point;
    let end: Point;
    let c1: Point;
    let c2: Point;
    if (sideBySide) {
        const leftToRight = from.x + from.w / 2 <= to.x + to.w / 2;
        start = { x: leftToRight ? from.x + from.w : from.x, y: from.y + from.h / 2 };
        end = { x: leftToRight ? to.x : to.x + to.w, y: to.y + to.h / 2 };
        const bend = Math.max(32, Math.abs(end.x - start.x) / 2);
        const direction = leftToRight ? 1 : -1;
        c1 = { x: start.x + bend * direction, y: start.y };
        c2 = { x: end.x - bend * direction, y: end.y };
    } else {
        const topToBottom = from.y + from.h / 2 <= to.y + to.h / 2;
        start = { x: from.x + from.w / 2, y: topToBottom ? from.y + from.h : from.y };
        end = { x: to.x + to.w / 2, y: topToBottom ? to.y : to.y + to.h };
        const bend = Math.max(32, Math.abs(end.y - start.y) / 2);
        const direction = topToBottom ? 1 : -1;
        c1 = { x: start.x, y: start.y + bend * direction };
        c2 = { x: end.x, y: end.y - bend * direction };
    }

    // A cubic Bezier at t = 0.5 is (P0 + 3 P1 + 3 P2 + P3) / 8.
    const mid = {
        x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
        y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8
    };
    return {
        d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
        mid
    };
}

/** The smallest rectangle holding every card, or null when there are none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The zoom that fits every card in the frame with `pad` pixels to spare, and the
 * scroll that centres them.
 *
 * Never above 1: fitting two cards on a wide screen should not blow them up to
 * one and a half times their size. Never below the minimum either - past it a
 * card's name is unreadable, so a project that spreads further than that opens
 * at the minimum centred on its middle and is scrolled from there.
 */
export function fitView(
    bounds: Rect,
    frame: { width: number; height: number },
    pad = 32
): { zoom: number; scrollLeft: number; scrollTop: number } {
    const fit = Math.min(
        (frame.width - pad * 2) / Math.max(1, bounds.w),
        (frame.height - pad * 2) / Math.max(1, bounds.h)
    );
    const zoom = clampZoom(Math.min(1, fit));
    return {
        zoom,
        scrollLeft: Math.max(0, (bounds.x + bounds.w / 2) * zoom - frame.width / 2),
        scrollTop: Math.max(0, (bounds.y + bounds.h / 2) * zoom - frame.height / 2)
    };
}

/**
 * The scroll that keeps one point of the board under the same spot of the frame
 * across a change of zoom - the pointer for a Ctrl+wheel, the middle of the frame
 * for the buttons - so zooming moves towards what the reader is looking at
 * rather than towards the board's top-left corner.
 */
export function scrollForZoom(
    scroll: { left: number; top: number },
    anchor: Point,
    from: number,
    to: number
): { left: number; top: number } {
    const boardX = (scroll.left + anchor.x) / from;
    const boardY = (scroll.top + anchor.y) / from;
    return {
        left: Math.max(0, boardX * to - anchor.x),
        top: Math.max(0, boardY * to - anchor.y)
    };
}

/** The services one service is joined to, by a link drawn by hand or by one of
 *  them using the other's variables. */
export function neighboursOf(
    id: string,
    edges: readonly { source: string; target: string }[]
): Set<string> {
    const found = new Set<string>();
    for (const edge of edges) {
        if (edge.source === id) found.add(edge.target);
        else if (edge.target === id) found.add(edge.source);
    }
    return found;
}
