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
 *  this is a deck nobody finishes - every outline, from a square to an arrow, is
 *  one kind of shape (`SHAPES`). */
export const BOX_KINDS = ["text", "shape", "image"] as const;

export type BoxKind = (typeof BOX_KINDS)[number];

/** Where a box sits and how big it is, as fractions of the slide. */
export interface BoxFrame {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/** What a shape box draws. The four everybody reaches for, two that point, and
 *  two lines - the set Google Slides and PowerPoint put first in their menus. */
export const SHAPES = [
    "rect",
    "rounded",
    "ellipse",
    "triangle",
    "diamond",
    "arrowRight",
    "line",
    "arrow"
] as const;

export type ShapeKind = (typeof SHAPES)[number];

/** The shapes that are a stroke between two ends rather than an area. */
export const LINE_SHAPES: readonly ShapeKind[] = ["line", "arrow"];

export const ALIGNS = ["left", "center", "right"] as const;

/** Where the words sit up and down a box - PowerPoint's "anchor". */
export const VALIGNS = ["top", "middle", "bottom"] as const;

/** A box's lines as they are, as bullets, or numbered. */
export const LISTS = ["none", "bullet", "number"] as const;

export interface Box extends BoxFrame {
    readonly id: string;
    readonly kind: BoxKind;
    /** What it says. A shape can hold words too; an image never does. */
    readonly text: string;
    /** How big the words are, as a fraction of the slide's height - so they
     *  scale with the slide instead of being a point size that means nothing on
     *  a projector. Shown as points on a 540-point-high slide (`pointsOf`). */
    readonly size: number;
    /** The words' colour, a hex. Empty means the slide's own text colour. */
    readonly color: string;
    /** What the box is filled with: a hex, `transparent`, or empty for none. */
    readonly fill: string;
    /** Left, centre or right. */
    readonly align: (typeof ALIGNS)[number];
    /** Top, middle or bottom. */
    readonly valign: (typeof VALIGNS)[number];
    /** The whole box's words, bold, slanted, underlined. Whole-box rather than
     *  per word: a box is one change on the wire, and per-word runs are a rich
     *  text model of their own. */
    readonly bold: boolean;
    readonly italic: boolean;
    readonly underline: boolean;
    readonly list: (typeof LISTS)[number];
    /** What a shape box draws. */
    readonly shape: ShapeKind;
    /** The outline's colour, a hex; empty for none. A line's own colour. */
    readonly stroke: string;
    /** The outline's width, as a fraction of the slide's height. */
    readonly strokeWidth: number;
    /** A line runs from bottom-left to top-right instead of top-left to
     *  bottom-right. Meaningless on anything but a line. */
    readonly flip: boolean;
    /** A line is drawn from its second corner to its first: which end is the
     *  start, so an arrow's head stays on the end it was put on however the
     *  line is turned. */
    readonly reversed: boolean;
    /** Where it sits in the stack: higher is drawn over lower. Boxes written
     *  before there was a stack all read 0 and keep the order they were added. */
    readonly z: number;
    /** A source, for an image: inline data, an address, or `image:<id>` - a
     *  picture kept once in the deck's own store (`IMAGE_PREFIX`). */
    readonly src: string;
    /** Which counts up when somebody changes it, so two people editing the same
     *  box resolve the same way a drawing does. */
    readonly version: number;
}

/** One slide. The boxes live apart, keyed by slide, so moving a box is a change
 *  to that box rather than to the slide it is on. */
export interface Slide {
    readonly id: string;
    /** Shown to the presenter, never on the slide. Where a deck from before the
     *  notes store kept them - see `notesOf`. */
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

/** The slide's height in points, as PowerPoint's widescreen slide measures it
 *  (7.5 inches) - what a font size or a line width is shown in. */
export const SLIDE_POINTS = 540;

/** A size in whole points, as every size menu shows one. */
export function pointsOf(fraction: number): number {
    return Math.round(fraction * SLIDE_POINTS);
}

export function fractionOfPoints(points: number): number {
    return points / SLIDE_POINTS;
}

/** The sizes the size menu offers, in points. */
export const FONT_POINTS = [
    8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96
] as const;

/** What a font size may be, in points - Google Slides' own bounds. */
export const FONT_POINTS_MIN = 1;
export const FONT_POINTS_MAX = 400;

/** A font size one point larger or smaller, kept in bounds - Google Slides'
 *  plus and minus beside the size. */
export function stepPoints(fraction: number, by: number): number {
    const next = Math.round(pointsOf(fraction)) + by;
    return fractionOfPoints(Math.min(FONT_POINTS_MAX, Math.max(FONT_POINTS_MIN, next)));
}

/** The widths the outline menu offers, in points. */
export const STROKE_POINTS = [1, 2, 3, 4, 6, 8, 12] as const;

/** What a new shape is filled with, and its words' colour on that fill. */
export const SHAPE_FILL = "#7c5cff";
const SHAPE_TEXT = "#ffffff";
/** What a new line is drawn in. */
const LINE_STROKE = "#4d5561";

/** A box as it starts. Placed a little in from the edge and a third of the way
 *  down, which is where somebody who just pressed "add" is looking. */
export function newBox(kind: BoxKind, id: string, shape: ShapeKind = "rect"): Box {
    const base: Box = {
        id,
        kind,
        x: 0.1,
        y: 0.3,
        w: kind === "text" ? 0.8 : 0.3,
        h: kind === "text" ? 0.15 : 0.25,
        text: "",
        size: fractionOfPoints(32),
        color: "",
        fill: "",
        align: "left",
        valign: "top",
        bold: false,
        italic: false,
        underline: false,
        list: "none",
        shape: "rect",
        stroke: "",
        strokeWidth: fractionOfPoints(2),
        flip: false,
        reversed: false,
        z: 0,
        src: "",
        version: 1
    };
    if (kind !== "shape") return base;
    if (LINE_SHAPES.includes(shape)) {
        return {
            ...base,
            shape,
            x: 0.3,
            y: 0.5,
            w: 0.4,
            h: 0,
            stroke: LINE_STROKE,
            strokeWidth: fractionOfPoints(3)
        };
    }
    // Square as seen rather than in fractions, which on a wide slide would be
    // a box taller than it is wide; an arrow half as tall as it is long.
    const w = 0.2;
    const h = (w * SLIDE_RATIO) / (shape === "arrowRight" ? 2 : 1);
    return {
        ...base,
        shape,
        x: (1 - w) / 2,
        y: (1 - h) / 2,
        w,
        h,
        size: fractionOfPoints(18),
        fill: SHAPE_FILL,
        color: SHAPE_TEXT,
        align: "center",
        valign: "middle"
    };
}

/** The title box a new slide gets, so a deck never starts as a blank rectangle
 *  with no way in. */
export function titleBox(id: string): Box {
    return {
        ...newBox("text", id),
        y: 0.12,
        h: 0.2,
        size: fractionOfPoints(54),
        align: "center",
        valign: "middle"
    };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A colour as a box may hold one: a hex, `transparent`, or empty. Anything
 *  else - a stored value from an older or a hostile writer - is `fallback`, so
 *  nothing but a colour ever reaches a style. */
export function readColor(value: unknown, fallback: string): string {
    if (value === "" || value === "transparent") return value;
    return typeof value === "string" && HEX.test(value) ? value : fallback;
}

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
    return options.includes(value as T) ? (value as T) : fallback;
}

function finite(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A box as stored, with every field there and of its type.
 *
 * Boxes are written by every version of the editor that ever touched the deck,
 * so a field this one draws may simply not be on a box an older one wrote: each
 * is read with the default that box was drawn with when it was made - a shape
 * from before there were shapes is the violet rounded rectangle it always was.
 */
export function readBox(raw: unknown): Box {
    const one = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kind = oneOf(BOX_KINDS, one.kind, "text");
    const shaped = kind === "shape";
    const shape = oneOf(SHAPES, one.shape, "rounded");
    const area = shaped && !LINE_SHAPES.includes(shape);
    const fill = readColor(one.fill, "");
    return {
        id: typeof one.id === "string" ? one.id : "",
        kind,
        x: finite(one.x, 0),
        y: finite(one.y, 0),
        w: finite(one.w, 0.3),
        h: finite(one.h, 0.25),
        text: typeof one.text === "string" ? one.text : "",
        size: Math.max(0.001, finite(one.size, 0.06)),
        color: readColor(one.color, ""),
        // A shape without a fill has always been drawn violet, so it still is;
        // a shape with none says `transparent`.
        fill: area && fill === "" ? SHAPE_FILL : fill,
        align: oneOf(ALIGNS, one.align, shaped ? "center" : "left"),
        valign: oneOf(VALIGNS, one.valign, shaped ? "middle" : "top"),
        bold: one.bold === true,
        italic: one.italic === true,
        underline: one.underline === true,
        list: oneOf(LISTS, one.list, "none"),
        shape,
        stroke: readColor(one.stroke, ""),
        strokeWidth: Math.min(0.2, Math.max(0, finite(one.strokeWidth, fractionOfPoints(2)))),
        flip: one.flip === true,
        reversed: one.reversed === true,
        z: finite(one.z, 0),
        src: typeof one.src === "string" ? one.src : "",
        version: finite(one.version, 1)
    };
}

/** Whether a box is a line - a stroke between two ends, which may be as thin
 *  as nothing in one direction. */
export function isLine(box: Pick<Box, "kind" | "shape">): boolean {
    return box.kind === "shape" && LINE_SHAPES.includes(box.shape);
}

/** Whether a box holds words: text, and every shape that is an area. */
export function holdsText(box: Pick<Box, "kind" | "shape">): boolean {
    return box.kind === "text" || (box.kind === "shape" && !isLine(box));
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

/** The smallest a box may become: a line may be flat, nothing else may. */
export function smallestFor(box: Pick<Box, "kind" | "shape">): number {
    return isLine(box) ? 0 : SMALLEST;
}

export function clampFrame(frame: BoxFrame, smallest = SMALLEST): BoxFrame {
    const w = Math.min(1, Math.max(smallest, frame.w));
    const h = Math.min(1, Math.max(smallest, frame.h));
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

/** Boxes in the order they are drawn: by their place in the stack, and boxes
 *  that share one - every box from before there was a stack - in the order they
 *  were added. */
export function stackOrder(boxes: readonly Box[]): Box[] {
    return boxes
        .map((box, at) => ({ box, at }))
        .sort((left, right) => left.box.z - right.box.z || left.at - right.at)
        .map((one) => one.box);
}

/** The boxes of one slide, read whole and in the order they are drawn - so a
 *  box later in the stack sits on top. */
export function boxesOn(slideId: string, boxes: ReadonlyMap<string, unknown>): Box[] {
    const on: Box[] = [];
    for (const [key, box] of boxes) {
        const at = readBoxKey(key);
        if (at?.slideId === slideId) on.push(readBox(box));
    }
    return stackOrder(on);
}

/** Where a new box goes in the stack: on top of everything already there. */
export function nextZ(boxes: readonly Box[]): number {
    return boxes.reduce((top, box) => Math.max(top, box.z), 0) + 1;
}

/** The four ways a box moves through the stack, as PowerPoint and Google
 *  Slides name them. */
export const ARRANGE = ["front", "forward", "backward", "back"] as const;

export type Arrange = (typeof ARRANGE)[number];

/**
 * The new places in the stack after box `id` is moved `how`: only the boxes
 * whose place actually changes, so a box already on top brought to the front
 * writes nothing. "Forward" and "backward" step past one neighbour, as in
 * Google Slides.
 */
export function arrange(boxes: readonly Box[], id: string, how: Arrange): Map<string, number> {
    const order = stackOrder(boxes);
    const from = order.findIndex((box) => box.id === id);
    const changes = new Map<string, number>();
    if (from < 0) return changes;
    const last = order.length - 1;
    const to =
        how === "front"
            ? last
            : how === "back"
              ? 0
              : how === "forward"
                ? Math.min(last, from + 1)
                : Math.max(0, from - 1);
    if (to === from) return changes;
    const [moving] = order.splice(from, 1);
    order.splice(to, 0, moving!);
    order.forEach((box, at) => {
        if (box.z !== at + 1) changes.set(box.id, at + 1);
    });
    return changes;
}

/** What a deck reads as, for the excerpt and for a plain-text export: every
 *  slide's words, in order. */
export function deckText(slides: readonly Slide[], boxes: ReadonlyMap<string, unknown>): string[] {
    return slides.map((slide) =>
        boxesOn(slide.id, boxes)
            .map((box) => box.text.trim())
            .filter(Boolean)
            .join("\n")
    );
}

/** The boxes of every slide at once, for a screen that draws them all - the
 *  slide list - and would otherwise walk every box once per slide. Each slide's
 *  in the order it is drawn. */
export function groupBySlide(boxes: ReadonlyMap<string, unknown>): Map<string, Box[]> {
    const out = new Map<string, Box[]>();
    for (const [key, raw] of boxes) {
        const at = readBoxKey(key);
        if (!at) continue;
        const box = readBox(raw);
        const list = out.get(at.slideId);
        if (list) list.push(box);
        else out.set(at.slideId, [box]);
    }
    for (const [slideId, list] of out) out.set(slideId, stackOrder(list));
    return out;
}

/** A slide's speaker notes. Kept apart from the slide, keyed by its id, so two
 *  people - one typing notes, one moving the slide - never write the same
 *  thing; a deck from before that kept them on the slide itself. */
export function notesOf(slide: Slide, notes: ReadonlyMap<string, unknown>): string {
    const kept = notes.get(slide.id);
    if (typeof kept === "string") return kept;
    return typeof slide.notes === "string" ? slide.notes : "";
}

/** The longest speaker notes a slide keeps. */
export const NOTES_MAX = 20_000;

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

export function nudgeFrame(
    frame: BoxFrame,
    right: number,
    down: number,
    large: boolean,
    smallest = SMALLEST
): BoxFrame {
    const step = NUDGE * (large ? 10 : 1);
    return clampFrame(
        {
            ...frame,
            x: frame.x + right * step,
            y: frame.y + down * step * SLIDE_RATIO
        },
        smallest
    );
}

/** Where a copy lands: a step down and to the right of what it copies, so it is
 *  visibly a second box rather than one hiding exactly behind the other. */
export const COPY_OFFSET = 0.02;

export function copyOf(box: Box, id: string, offset = COPY_OFFSET): Box {
    const frame = clampFrame(
        {
            x: box.x + offset,
            y: box.y + offset * SLIDE_RATIO,
            w: box.w,
            h: box.h
        },
        smallestFor(box)
    );
    return { ...box, ...frame, id, version: 1 };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface Point {
    readonly x: number;
    readonly y: number;
}

export interface LineFrame extends BoxFrame {
    readonly flip: boolean;
    readonly reversed: boolean;
}

/** A line's two ends, start first: its frame's corners, top-left to
 *  bottom-right or, flipped, bottom-left to top-right - the other way round
 *  when it is reversed. */
export function lineEnds(box: LineFrame): readonly [Point, Point] {
    const ends: [Point, Point] = box.flip
        ? [
              { x: box.x, y: box.y + box.h },
              { x: box.x + box.w, y: box.y }
          ]
        : [
              { x: box.x, y: box.y },
              { x: box.x + box.w, y: box.y + box.h }
          ];
    return box.reversed ? [ends[1], ends[0]] : ends;
}

const onSlide = (value: number): number => Math.min(1, Math.max(0, value));

/** The frame of a line drawn from `start` to `end`, both kept on the slide -
 *  `lineEnds` gives the same two ends back, in the same order. */
export function lineThrough(start: Point, end: Point): LineFrame {
    const a = { x: onSlide(start.x), y: onSlide(start.y) };
    const b = { x: onSlide(end.x), y: onSlide(end.y) };
    const flip = (b.x - a.x) * (b.y - a.y) < 0;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const h = Math.abs(b.y - a.y);
    // The corner a line is drawn from when it is not reversed.
    const first = { x, y: flip ? y + h : y };
    return {
        x,
        y,
        w: Math.abs(b.x - a.x),
        h,
        flip,
        reversed: a.x !== first.x || a.y !== first.y
    };
}

/**
 * `end`, turned about `start` to the nearest multiple of `stepDegrees` - Shift
 * while pulling a line's end, so level, upright and diagonal lines are easy to
 * draw. Measured on the slide as it is seen, sixteen by nine, so a diagonal is
 * forty-five degrees on screen rather than in fractions.
 */
export function snapAngle(start: Point, end: Point, stepDegrees = 15): Point {
    const dx = (end.x - start.x) * SLIDE_RATIO;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return end;
    const step = (stepDegrees * Math.PI) / 180;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return {
        x: start.x + (Math.cos(angle) * length) / SLIDE_RATIO,
        y: start.y + Math.sin(angle) * length
    };
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** How an image box points at a picture kept once in the deck's own store, so
 *  moving the box sends its position rather than the whole picture again. */
export const IMAGE_PREFIX = "image:";

/** A picture's frame as it is inserted: its own proportions, centred, as large
 *  as `largest` of the slide in either direction. */
export function imageFrame(width: number, height: number, largest = 0.6): BoxFrame {
    // How many slide-heights tall a picture one slide-width wide would be.
    const tall = width > 0 && height > 0 ? (height / width) * SLIDE_RATIO : 1;
    let w = largest;
    let h = w * tall;
    if (h > largest) {
        h = largest;
        w = h / tall;
    }
    return clampFrame({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
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

const pastedColor = z
    .string()
    .max(64)
    .refine((value) => readColor(value, "!") !== "!");

const pastedBox = z.object({
    kind: z.enum(BOX_KINDS),
    x: fraction,
    y: fraction,
    w: fraction,
    h: fraction,
    text: z.string().max(20_000),
    size: z.number().finite().min(0.001).max(1),
    color: pastedColor,
    fill: pastedColor,
    align: z.enum(ALIGNS),
    src: imageSource,
    // Written by this editor since it had them; a box copied from an older tab
    // simply has none, and reads with the defaults.
    valign: z.enum(VALIGNS).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    list: z.enum(LISTS).optional(),
    shape: z.enum(SHAPES).optional(),
    stroke: pastedColor.optional(),
    strokeWidth: z.number().finite().min(0).max(0.2).optional(),
    flip: z.boolean().optional(),
    reversed: z.boolean().optional()
});

const pastedBoxes = z.object({ boxes: z.array(pastedBox).min(1).max(500) });

/** What goes on the clipboard: the boxes, without the ids, versions and places
 *  in the stack that belong to the slide they were copied from. `source` turns
 *  a picture kept in this deck's store into the picture itself, since the deck
 *  it is pasted into has a store of its own. */
export function writeClipboard(
    boxes: readonly Box[],
    source: (src: string) => string = (src) => src
): string {
    return JSON.stringify({
        boxes: boxes.map((box) => ({
            kind: box.kind,
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
            text: box.text,
            size: box.size,
            color: box.color,
            fill: box.fill,
            align: box.align,
            src: box.src ? source(box.src) : "",
            valign: box.valign,
            bold: box.bold,
            italic: box.italic,
            underline: box.underline,
            list: box.list,
            shape: box.shape,
            stroke: box.stroke,
            strokeWidth: box.strokeWidth,
            flip: box.flip,
            reversed: box.reversed
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
    return read.data.boxes.map((one) => {
        const box = readBox({ ...one, id: newId(), version: 1, z: 0 });
        return { ...box, ...clampFrame(box, smallestFor(box)) };
    });
}
