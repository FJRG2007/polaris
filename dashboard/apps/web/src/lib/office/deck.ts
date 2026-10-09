/**
 * What a presentation is made of.
 *
 * Polaris' own, and that is a decision rather than an oversight. There is no
 * open-source web presentation editor that is both complete and permissively
 * licensed for a product to embed: the good one is MIT and written in another
 * framework entirely, and porting a whole editor is more work than the model
 * below, which is genuinely small. A deck is slides, and a slide is boxes with
 * positions.
 *
 * **Positions are fractions of the slide, never pixels.** A deck written on a
 * laptop and presented on a projector is the same deck, and the moment a box
 * remembers that it was at x=412 it is a deck that only looks right on the
 * screen it was made on. Everything here is 0 to 1, and the canvas multiplies.
 *
 * Pure, so the arithmetic that decides where a box lands can be tested without a
 * canvas, and so the exporters read the same model the editor writes.
 */

import { z } from "zod";

/** What a box on a slide is. Three, deliberately: a deck made of more kinds than
 *  this is a deck nobody finishes. */
export const BOX_KINDS = ["text", "shape", "image"] as const;

export type BoxKind = (typeof BOX_KINDS)[number];

/** Where a box sits and how big it is, as fractions of the slide. */
export interface BoxFrame {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface Box extends BoxFrame {
    readonly id: string;
    readonly kind: BoxKind;
    /** What it says. Empty on a shape or an image. */
    readonly text: string;
    /** How big the words are, as a fraction of the slide's height - so they
     *  scale with the slide instead of being a point size that means nothing on
     *  a projector. */
    readonly size: number;
    /** A colour token or a hex. Empty means the theme's own. */
    readonly color: string;
    readonly fill: string;
    /** Left, centre or right. Only means anything on text. */
    readonly align: "left" | "center" | "right";
    /** A source, for an image. */
    readonly src: string;
    /** Which counts up when somebody changes it, so two people editing the same
     *  box resolve the same way a drawing does. */
    readonly version: number;
}

/** One slide. The boxes live apart, keyed by slide, so moving a box is a change
 *  to that box rather than to the slide it is on. */
export interface Slide {
    readonly id: string;
    /** Shown under the slide while presenting, and never on it. */
    readonly notes: string;
}

/** The shape of the canvas. Sixteen by nine, because everything a deck is shown
 *  on is. */
export const SLIDE_RATIO = 16 / 9;

/** Where a box's key lives in the shared document. */
export function boxKey(slideId: string, boxId: string): string {
    return `${slideId}::${boxId}`;
}

export function readBoxKey(key: string): { slideId: string; boxId: string } | null {
    const at = key.indexOf("::");
    if (at < 0) return null;
    return { slideId: key.slice(0, at), boxId: key.slice(at + 2) };
}

/** A box as it starts. Placed a little in from the edge and a third of the way
 *  down, which is where somebody who just pressed "add" is looking. */
export function newBox(kind: BoxKind, id: string): Box {
    return {
        id,
        kind,
        x: 0.1,
        y: 0.3,
        w: kind === "text" ? 0.8 : 0.3,
        h: kind === "text" ? 0.15 : 0.25,
        text: kind === "text" ? "" : "",
        size: 0.06,
        color: "",
        fill: kind === "shape" ? "#7c5cff" : "",
        align: "left",
        src: "",
        version: 1
    };
}

/** The title box a new slide gets, so a deck never starts as a blank rectangle
 *  with no way in. */
export function titleBox(id: string): Box {
    return { ...newBox("text", id), y: 0.12, h: 0.2, size: 0.1, align: "center" };
}

/**
 * A frame, kept on the slide.
 *
 * Boxes are clamped rather than refused: dragging one off the edge is something
 * people do constantly and the useful answer is "it stopped at the edge", not
 * "nothing happened". A box is never allowed to become smaller than something
 * anybody could grab again.
 */
export const SMALLEST = 0.02;

export function clampFrame(frame: BoxFrame): BoxFrame {
    const w = Math.min(1, Math.max(SMALLEST, frame.w));
    const h = Math.min(1, Math.max(SMALLEST, frame.h));
    return {
        w,
        h,
        x: Math.min(1 - w, Math.max(0, frame.x)),
        y: Math.min(1 - h, Math.max(0, frame.y))
    };
}

/** Which of two versions of a box is the later, by the same rule a drawing uses
 *  and for the same reason: inside one box there is nothing to merge, so
 *  something has to choose, and both screens have to choose the same. */
export function laterBox(left: Box, right: Box): Box {
    if (left.version !== right.version) return left.version > right.version ? left : right;
    // A tie is two people who each changed it once since they last spoke. The
    // id is the only thing left that both sides agree on.
    return left.id <= right.id ? left : right;
}

/** The boxes of one slide, in the order they were added - which is the order
 *  they are drawn in, so a box added later sits on top. */
export function boxesOn(slideId: string, boxes: ReadonlyMap<string, Box>): Box[] {
    const on: Box[] = [];
    for (const [key, box] of boxes) {
        const at = readBoxKey(key);
        if (at?.slideId === slideId) on.push(box);
    }
    return on;
}

/** What a deck reads as, for the excerpt and for a plain-text export: every
 *  slide's words, in order. */
export function deckText(slides: readonly Slide[], boxes: ReadonlyMap<string, Box>): string[] {
    return slides.map((slide) =>
        boxesOn(slide.id, boxes)
            .map((box) => box.text.trim())
            .filter(Boolean)
            .join("\n")
    );
}

/** The boxes of every slide at once, for a screen that draws them all - the
 *  slide list - and would otherwise walk every box once per slide. */
export function groupBySlide(boxes: ReadonlyMap<string, Box>): Map<string, Box[]> {
    const out = new Map<string, Box[]>();
    for (const [key, box] of boxes) {
        const at = readBoxKey(key);
        if (!at) continue;
        const list = out.get(at.slideId);
        if (list) list.push(box);
        else out.set(at.slideId, [box]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Moving and resizing
// ---------------------------------------------------------------------------

/** The eight grips round a chosen box: the corners and the middle of each side,
 *  named by compass point the way every drawing tool names them. */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export type Handle = (typeof HANDLES)[number];

export interface ResizeOptions {
    /** Shift: the box keeps its proportions. */
    readonly keepRatio?: boolean;
    /** Alt: the box grows from its centre, so both opposite sides move. */
    readonly fromCenter?: boolean;
}

/**
 * A box, after its grip `handle` was dragged by `dx`, `dy` (fractions of the
 * slide).
 *
 * The side opposite the grip stays where it was, as in every drawing tool; a
 * side grip changes one dimension, a corner both. Kept on the slide by stopping
 * the moving sides at its edges - never by sliding the whole box, which is what
 * clamping the result afterwards would do and which reads as the box running
 * away from the pointer. Never smaller than `SMALLEST`, so a box shrunk to
 * nothing can still be grabbed.
 */
export function resizeFrame(
    start: BoxFrame,
    handle: Handle,
    dx: number,
    dy: number,
    options: ResizeOptions = {}
): BoxFrame {
    const west = handle.endsWith("w");
    const east = handle.endsWith("e");
    const north = handle.startsWith("n");
    const south = handle.startsWith("s");
    const centered = options.fromCenter === true;
    const twice = centered ? 2 : 1;
    // How far each dimension may grow before a moving side leaves the slide.
    const room = (from: number, size: number, toStart: boolean, toEnd: boolean): number => {
        if (centered || (!toStart && !toEnd))
            return 2 * Math.min(from + size / 2, 1 - from - size / 2);
        return toStart ? from + size : 1 - from;
    };
    const roomW = room(start.x, start.w, west, east);
    const roomH = room(start.y, start.h, north, south);
    let w = start.w + (east ? dx : west ? -dx : 0) * twice;
    let h = start.h + (south ? dy : north ? -dy : 0) * twice;
    if (options.keepRatio) {
        const horizontal = east || west;
        const vertical = north || south;
        let scale =
            horizontal && vertical
                ? Math.max(w / start.w, h / start.h)
                : horizontal
                  ? w / start.w
                  : h / start.h;
        scale = Math.min(scale, roomW / start.w, roomH / start.h);
        scale = Math.max(scale, SMALLEST / start.w, SMALLEST / start.h);
        w = start.w * scale;
        h = start.h * scale;
    } else {
        w = Math.min(roomW, Math.max(SMALLEST, w));
        h = Math.min(roomH, Math.max(SMALLEST, h));
    }
    // A side grip with the proportions kept also changes the other dimension;
    // that one grows evenly about the middle, as both do with Alt.
    const x =
        west && !centered
            ? start.x + start.w - w
            : east && !centered
              ? start.x
              : start.x + (start.w - w) / 2;
    const y =
        north && !centered
            ? start.y + start.h - h
            : south && !centered
              ? start.y
              : start.y + (start.h - h) / 2;
    return clampFrame({ x, y, w, h });
}

/**
 * How far an arrow key moves a box: a three-hundred-and-twentieth of the slide's
 * width, and the same distance on screen downwards - which, on a slide wider
 * than it is tall, is a larger fraction of its height. Ten times that with
 * Shift, as in every editor that nudges.
 */
export const NUDGE = 1 / 320;

export function nudgeFrame(frame: BoxFrame, right: number, down: number, large: boolean): BoxFrame {
    const step = NUDGE * (large ? 10 : 1);
    return clampFrame({
        ...frame,
        x: frame.x + right * step,
        y: frame.y + down * step * SLIDE_RATIO
    });
}

/** Where a copy lands: a step down and to the right of what it copies, so it is
 *  visibly a second box rather than one hiding exactly behind the other. */
export const COPY_OFFSET = 0.02;

export function copyOf(box: Box, id: string, offset = COPY_OFFSET): Box {
    const frame = clampFrame({
        x: box.x + offset,
        y: box.y + offset * SLIDE_RATIO,
        w: box.w,
        h: box.h
    });
    return { ...box, ...frame, id, version: 1 };
}

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

/** The clipboard type boxes travel under, between slides and between tabs. */
export const CLIPBOARD_TYPE = "application/x-polaris-slide-boxes";

const fraction = z.number().finite().min(0).max(1);

/** A picture's address, as a box may hold one: inline image data, a web address
 *  or one of Polaris' own paths. A pasted `javascript:` or `file:` address never
 *  reaches the page. */
const imageSource = z
    .string()
    .max(8_000_000)
    .refine((value) => value === "" || /^(data:image\/|https:\/\/|\/(?!\/))/.test(value));

const pastedBox = z.object({
    kind: z.enum(BOX_KINDS),
    x: fraction,
    y: fraction,
    w: fraction,
    h: fraction,
    text: z.string().max(20_000),
    size: z.number().finite().min(0.005).max(1),
    color: z.string().max(64),
    fill: z.string().max(64),
    align: z.enum(["left", "center", "right"]),
    src: imageSource
});

const pastedBoxes = z.object({ boxes: z.array(pastedBox).min(1).max(500) });

/** What goes on the clipboard: the boxes, without the ids and versions that
 *  belong to the slide they were copied from. */
export function writeClipboard(boxes: readonly Box[]): string {
    return JSON.stringify({
        boxes: boxes.map(({ kind, x, y, w, h, text, size, color, fill, align, src }) => ({
            kind,
            x,
            y,
            w,
            h,
            text,
            size,
            color,
            fill,
            align,
            src
        }))
    });
}

/**
 * Boxes off the clipboard, checked field by field, or none.
 *
 * The clipboard is anybody's - another tab, another site, a hand-written string
 * - so what comes off it is untrusted, and anything that is not exactly a box
 * is refused whole rather than half-used. Each box gets a new id from `newId`
 * and a first version: it is a new box wherever it lands.
 */
export function readClipboard(raw: string, newId: () => string): Box[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    const read = pastedBoxes.safeParse(parsed);
    if (!read.success) return [];
    return read.data.boxes.map((one) => ({
        ...one,
        ...clampFrame(one),
        id: newId(),
        version: 1
    }));
}
