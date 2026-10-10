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
import { FONT_FAMILIES, type FontFamily } from "@/lib/font-families";

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

/** What a box is to its slide's layout: the title, the line under it, the
 *  body, or nothing in particular. A title is set in the theme's heading face,
 *  everything else in its body face, and a layout put on a slide moves the
 *  boxes that play a part in it into place - Google Slides' placeholders. */
export const ROLES = ["", "title", "subtitle", "body"] as const;

export type BoxRole = (typeof ROLES)[number];

/** The faces a box may be set in. */
export const SLIDE_FONTS: readonly FontFamily[] = FONT_FAMILIES;

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
    /** Its part in the slide's layout - see `ROLES`. */
    readonly role: BoxRole;
    /** The face its words are set in; empty for the theme's. */
    readonly font: string;
    /** The group it belongs to, or empty: boxes in one group are chosen,
     *  moved and arranged together. */
    readonly group: string;
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
export const LINE_STROKE = "#4d5561";

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
        role: "",
        font: "",
        group: "",
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
        valign: "middle",
        role: "title"
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
        // The title every slide was given before there were layouts is a
        // title, though it was never told so.
        role: oneOf(ROLES, one.role, kind === "text" && one.id === "title" ? "title" : ""),
        font: oneOf(["", ...SLIDE_FONTS], one.font, ""),
        group: typeof one.group === "string" ? one.group.slice(0, 64) : "",
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
 * The new places in the stack after the boxes `ids` - one, or every box
 * chosen - are moved `how`: only the boxes whose place actually changes, so a
 * box already on top brought to the front writes nothing. Several boxes keep
 * their order among themselves. "Forward" and "backward" step each past one
 * neighbour that is not moving with it, as in Google Slides.
 */
export function arrange(
    boxes: readonly Box[],
    ids: string | readonly string[],
    how: Arrange
): Map<string, number> {
    const moving = new Set(typeof ids === "string" ? [ids] : ids);
    let order = stackOrder(boxes);
    const changes = new Map<string, number>();
    if (!order.some((box) => moving.has(box.id))) return changes;
    if (how === "front" || how === "back") {
        const chosen = order.filter((box) => moving.has(box.id));
        const rest = order.filter((box) => !moving.has(box.id));
        order = how === "front" ? [...rest, ...chosen] : [...chosen, ...rest];
    } else if (how === "forward") {
        for (let at = order.length - 2; at >= 0; at -= 1) {
            if (moving.has(order[at]!.id) && !moving.has(order[at + 1]!.id)) {
                [order[at], order[at + 1]] = [order[at + 1]!, order[at]!];
            }
        }
    } else {
        for (let at = 1; at < order.length; at += 1) {
            if (moving.has(order[at]!.id) && !moving.has(order[at - 1]!.id)) {
                [order[at], order[at - 1]] = [order[at - 1]!, order[at]!];
            }
        }
    }
    // Nothing moved: the stack is as it was, so nothing is written - not even
    // the numbering of boxes that shared a place.
    const before = stackOrder(boxes);
    if (order.every((box, at) => box.id === before[at]!.id)) return changes;
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
    reversed: z.boolean().optional(),
    role: z.enum(ROLES).optional(),
    font: z.enum(["", ...FONT_FAMILIES]).optional(),
    group: z.string().max(64).optional()
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
            reversed: box.reversed,
            role: box.role,
            font: box.font,
            group: box.group
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
    // A pasted group is a group again, of the copies - never one with the
    // boxes it was copied from.
    const groups = new Map<string, string>();
    const regroup = (group: string | undefined): string => {
        if (!group) return "";
        if (!groups.has(group)) groups.set(group, newId());
        return groups.get(group)!;
    };
    return read.data.boxes.map((one) => {
        const box = readBox({
            ...one,
            id: newId(),
            version: 1,
            z: 0,
            group: regroup(one.group)
        });
        return { ...box, ...clampFrame(box, smallestFor(box)) };
    });
}
// ---------------------------------------------------------------------------
// Themes and backgrounds
// ---------------------------------------------------------------------------

/** A deck's look: the colour of its slides, the colour and faces of its
 *  words, and the colour a new shape is filled with. */
export interface DeckTheme {
    readonly background: string;
    readonly text: string;
    readonly accent: string;
    readonly headingFont: FontFamily;
    readonly bodyFont: FontFamily;
}

/** The themes on offer, plainest first - a handful, each a colour set and a
 *  pair of faces, the way Google Slides' theme panel starts. */
export const THEMES = {
    light: {
        background: "#ffffff",
        text: "#1f2328",
        accent: "#7c5cff",
        headingFont: "Arial",
        bodyFont: "Arial"
    },
    dark: {
        background: "#1f2328",
        text: "#f5f6f7",
        accent: "#a78bfa",
        headingFont: "Arial",
        bodyFont: "Arial"
    },
    paper: {
        background: "#fbf8f1",
        text: "#2b2622",
        accent: "#b4532a",
        headingFont: "Georgia",
        bodyFont: "Georgia"
    },
    ocean: {
        background: "#0b3954",
        text: "#ffffff",
        accent: "#4cc9f0",
        headingFont: "Trebuchet MS",
        bodyFont: "Verdana"
    },
    forest: {
        background: "#f1f7ee",
        text: "#1e3a26",
        accent: "#2f855a",
        headingFont: "Georgia",
        bodyFont: "Verdana"
    },
    sunset: {
        background: "#fff4e6",
        text: "#3d1f0f",
        accent: "#e8590c",
        headingFont: "Trebuchet MS",
        bodyFont: "Arial"
    },
    typewriter: {
        background: "#ffffff",
        text: "#111111",
        accent: "#111111",
        headingFont: "Courier New",
        bodyFont: "Courier New"
    }
} as const satisfies Record<string, DeckTheme>;

export type ThemeId = keyof typeof THEMES;

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

/** A deck that never chose a theme: white slides and dark words, whatever the
 *  screen around them looks like - a slide is paper, not part of the app. */
export const DEFAULT_THEME: DeckTheme = THEMES.light;

/** The fields of the theme, as the deck stores them. */
export const THEME_FIELDS = ["background", "text", "accent", "headingFont", "bodyFont"] as const;

function solid(value: unknown, fallback: string): string {
    return typeof value === "string" && HEX.test(value) ? value : fallback;
}

/** A deck's theme as stored, each field checked and any missing one the
 *  default's - so a deck from before themes is white. */
export function readTheme(stored: ReadonlyMap<string, unknown>): DeckTheme {
    return {
        background: solid(stored.get("background"), DEFAULT_THEME.background),
        text: solid(stored.get("text"), DEFAULT_THEME.text),
        accent: solid(stored.get("accent"), DEFAULT_THEME.accent),
        headingFont: oneOf(SLIDE_FONTS, stored.get("headingFont"), DEFAULT_THEME.headingFont),
        bodyFont: oneOf(SLIDE_FONTS, stored.get("bodyFont"), DEFAULT_THEME.bodyFont)
    };
}

/** Which offered theme a deck's colours are, if they are exactly one of them;
 *  the faces may have been changed since. */
export function themeIdOf(theme: DeckTheme): ThemeId | null {
    return (
        THEME_IDS.find((id) =>
            (["background", "text", "accent"] as const).every(
                (field) => THEMES[id][field] === theme[field]
            )
        ) ?? null
    );
}

/** What one slide is drawn with: the theme, and its own background if it was
 *  given one. */
export interface SlideLook {
    readonly background: string;
    readonly text: string;
    readonly headingFont: string;
    readonly bodyFont: string;
}

export const DEFAULT_LOOK: SlideLook = {
    background: DEFAULT_THEME.background,
    text: DEFAULT_THEME.text,
    headingFont: DEFAULT_THEME.headingFont,
    bodyFont: DEFAULT_THEME.bodyFont
};

export function lookOf(
    theme: DeckTheme,
    backgrounds: ReadonlyMap<string, unknown>,
    slideId: string
): SlideLook {
    return {
        background: solid(backgrounds.get(slideId), theme.background),
        text: theme.text,
        headingFont: theme.headingFont,
        bodyFont: theme.bodyFont
    };
}

/** Whether a slide was given a background of its own. */
export function hasOwnBackground(
    backgrounds: ReadonlyMap<string, unknown>,
    slideId: string
): boolean {
    return solid(backgrounds.get(slideId), "") !== "";
}

/** A colour a slide's background may be set to: a solid hex, nothing else. */
export function readBackground(value: unknown): string | null {
    const kept = solid(value, "");
    return kept || null;
}

/** The face a box's words are set in: its own, or the theme's for its part. */
export function fontOf(box: Pick<Box, "font" | "role">, look: SlideLook): string {
    if (box.font) return box.font;
    return box.role === "title" ? look.headingFont : look.bodyFont;
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

/** Where the boxes of a new slide go - Google Slides' and PowerPoint's own
 *  first six. */
export const LAYOUTS = [
    "title",
    "titleBody",
    "twoColumns",
    "section",
    "titleOnly",
    "blank"
] as const;

export type Layout = (typeof LAYOUTS)[number];

/** What a new slide is laid out as when nothing says otherwise: a title and a
 *  body, as Ctrl+M makes one in Google Slides. */
export const NEXT_LAYOUT: Layout = "titleBody";

interface Place {
    readonly id: string;
    readonly role: BoxRole;
    readonly frame: BoxFrame;
    readonly points: number;
    readonly align: Box["align"];
    readonly valign: Box["valign"];
    readonly list?: Box["list"];
}

function placeholder(place: Place): Box {
    return {
        ...newBox("text", place.id),
        ...place.frame,
        role: place.role,
        size: fractionOfPoints(place.points),
        align: place.align,
        valign: place.valign,
        list: place.list ?? "none"
    };
}

const HEADER: BoxFrame = { x: 0.06, y: 0.06, w: 0.88, h: 0.16 };

const TITLE_TOP: Place = {
    id: "title",
    role: "title",
    frame: HEADER,
    points: 40,
    align: "left",
    valign: "middle"
};

function body(id: string, frame: BoxFrame, points: number): Place {
    return { id, role: "body", frame, points, align: "left", valign: "top", list: "bullet" };
}

const PLACES: Readonly<Record<Layout, readonly Place[]>> = {
    title: [
        {
            id: "title",
            role: "title",
            frame: { x: 0.08, y: 0.28, w: 0.84, h: 0.24 },
            points: 54,
            align: "center",
            valign: "bottom"
        },
        {
            id: "subtitle",
            role: "subtitle",
            frame: { x: 0.08, y: 0.54, w: 0.84, h: 0.14 },
            points: 24,
            align: "center",
            valign: "top"
        }
    ],
    titleBody: [TITLE_TOP, body("body", { x: 0.06, y: 0.26, w: 0.88, h: 0.66 }, 24)],
    twoColumns: [
        TITLE_TOP,
        body("body", { x: 0.06, y: 0.26, w: 0.43, h: 0.66 }, 22),
        body("body2", { x: 0.51, y: 0.26, w: 0.43, h: 0.66 }, 22)
    ],
    section: [
        {
            id: "title",
            role: "title",
            frame: { x: 0.08, y: 0.36, w: 0.84, h: 0.28 },
            points: 48,
            align: "center",
            valign: "middle"
        }
    ],
    titleOnly: [TITLE_TOP],
    blank: []
};

/** The boxes a slide laid out as `layout` starts with: empty, each saying what
 *  it is for until something is typed into it. */
export function layoutBoxes(layout: Layout): Box[] {
    return PLACES[layout].map((place, at) => ({ ...placeholder(place), z: at + 1 }));
}

/** What putting a layout on a slide that already has boxes changes. */
export interface LayoutChange {
    /** Boxes to write: placeholders moved into place, and new ones. */
    readonly set: readonly Box[];
    /** Boxes to remove: empty placeholders the layout has no place for. */
    readonly remove: readonly string[];
}

/**
 * A layout put on a slide that has things on it already.
 *
 * As in Google Slides: a box that plays a part the layout has a place for -
 * the title, a body - moves into that place and keeps its words; a part the
 * slide is missing is added, empty; an empty part the layout has no place for
 * goes; anything else on the slide - a picture, a shape, a box with words the
 * layout has no place for - stays exactly where it is.
 */
export function applyLayout(
    boxes: readonly Box[],
    layout: Layout,
    newId: () => string
): LayoutChange {
    const waiting = new Map<BoxRole, Box[]>();
    for (const box of stackOrder(boxes)) {
        if (!box.role) continue;
        waiting.set(box.role, [...(waiting.get(box.role) ?? []), box]);
    }
    const taken = new Set(boxes.map((box) => box.id));
    const set: Box[] = [];
    let z = nextZ(boxes);
    for (const place of PLACES[layout]) {
        const existing = waiting.get(place.role)?.shift();
        if (existing) {
            set.push({ ...existing, ...place.frame, version: existing.version + 1 });
            continue;
        }
        const id = taken.has(place.id) ? newId() : place.id;
        taken.add(id);
        set.push({ ...placeholder({ ...place, id }), z });
        z += 1;
    }
    const remove: string[] = [];
    for (const left of waiting.values()) {
        for (const box of left) {
            if (box.text.trim()) set.push({ ...box, role: "", version: box.version + 1 });
            else remove.push(box.id);
        }
    }
    return { set, remove };
}

// ---------------------------------------------------------------------------
// Several boxes at once
// ---------------------------------------------------------------------------

/** The smallest frame round every frame given. */
export function boundsOf(frames: readonly BoxFrame[]): BoxFrame {
    if (frames.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    const left = Math.min(...frames.map((one) => one.x));
    const top = Math.min(...frames.map((one) => one.y));
    const right = Math.max(...frames.map((one) => one.x + one.w));
    const bottom = Math.max(...frames.map((one) => one.y + one.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The box `id` and every box grouped with it: what one click chooses. */
export function unitOf(boxes: readonly Box[], id: string): string[] {
    const box = boxes.find((one) => one.id === id);
    if (!box) return [];
    if (!box.group) return [box.id];
    return boxes.filter((one) => one.group === box.group).map((one) => one.id);
}

/** Chosen boxes as the things they move as: each group whole, each box on its
 *  own otherwise - what lining up and spacing out treat as one. */
export function unitsOf(chosen: readonly Box[]): { ids: string[]; frame: BoxFrame }[] {
    const units = new Map<string, Box[]>();
    for (const box of chosen) {
        const key = box.group ? `group:${box.group}` : `box:${box.id}`;
        units.set(key, [...(units.get(key) ?? []), box]);
    }
    return [...units.values()].map((members) => ({
        ids: members.map((box) => box.id),
        frame: boundsOf(members)
    }));
}

/** Whether the chosen boxes can be grouped: two things or more, which are not
 *  already one group. */
export function canGroup(chosen: readonly Box[]): boolean {
    return unitsOf(chosen).length >= 2;
}

export function canUngroup(chosen: readonly Box[]): boolean {
    return chosen.some((box) => box.group !== "");
}

/** The six ways boxes line up, as the Arrange menu names them. */
export const ALIGN_BOXES = ["left", "center", "right", "top", "middle", "bottom"] as const;

export type AlignBoxes = (typeof ALIGN_BOXES)[number];

function shifted(frame: BoxFrame, dx: number, dy: number): BoxFrame {
    return { x: frame.x + dx, y: frame.y + dy, w: frame.w, h: frame.h };
}

/**
 * Where chosen boxes go when they are lined up `how`.
 *
 * Several things line up with each other - with the edge or the middle of the
 * frame round them all; one thing on its own lines up with the slide, as in
 * Google Slides and PowerPoint. A group is one thing and moves whole. Only the
 * boxes that actually move are in the answer.
 */
export function alignBoxes(chosen: readonly Box[], how: AlignBoxes): Map<string, BoxFrame> {
    const units = unitsOf(chosen);
    const to = units.length === 1 ? { x: 0, y: 0, w: 1, h: 1 } : boundsOf(chosen);
    const out = new Map<string, BoxFrame>();
    for (const unit of units) {
        const { frame } = unit;
        const dx =
            how === "left"
                ? to.x - frame.x
                : how === "center"
                  ? to.x + to.w / 2 - (frame.x + frame.w / 2)
                  : how === "right"
                    ? to.x + to.w - (frame.x + frame.w)
                    : 0;
        const dy =
            how === "top"
                ? to.y - frame.y
                : how === "middle"
                  ? to.y + to.h / 2 - (frame.y + frame.h / 2)
                  : how === "bottom"
                    ? to.y + to.h - (frame.y + frame.h)
                    : 0;
        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;
        for (const box of chosen) {
            if (unit.ids.includes(box.id)) out.set(box.id, shifted(box, dx, dy));
        }
    }
    return out;
}

/** Whether the chosen boxes can be spaced out: three things or more. */
export function canDistribute(chosen: readonly Box[]): boolean {
    return unitsOf(chosen).length >= 3;
}

/**
 * Where chosen boxes go when they are spaced evenly across (`x`) or down
 * (`y`): the first and the last stay, and every gap between neighbours
 * becomes the same.
 */
export function distributeBoxes(chosen: readonly Box[], axis: "x" | "y"): Map<string, BoxFrame> {
    const out = new Map<string, BoxFrame>();
    const units = unitsOf(chosen);
    if (units.length < 3) return out;
    const start = (frame: BoxFrame): number => (axis === "x" ? frame.x : frame.y);
    const length = (frame: BoxFrame): number => (axis === "x" ? frame.w : frame.h);
    units.sort((left, right) => start(left.frame) - start(right.frame));
    const first = units[0]!.frame;
    const last = units[units.length - 1]!.frame;
    const span = start(last) + length(last) - start(first);
    const filled = units.reduce((sum, unit) => sum + length(unit.frame), 0);
    const gap = (span - filled) / (units.length - 1);
    let at = start(first);
    for (const unit of units) {
        const move = at - start(unit.frame);
        at += length(unit.frame) + gap;
        if (Math.abs(move) < 1e-9) continue;
        for (const box of chosen) {
            if (!unit.ids.includes(box.id)) continue;
            out.set(box.id, axis === "x" ? shifted(box, move, 0) : shifted(box, 0, move));
        }
    }
    return out;
}

/** A frame inside `from`, put in the same place inside `to` - each chosen box
 *  when the frame round them all is resized. */
export function scaleInto(frame: BoxFrame, from: BoxFrame, to: BoxFrame): BoxFrame {
    const sx = from.w > 0 ? to.w / from.w : 1;
    const sy = from.h > 0 ? to.h / from.h : 1;
    return {
        x: to.x + (frame.x - from.x) * sx,
        y: to.y + (frame.y - from.y) * sy,
        w: frame.w * sx,
        h: frame.h * sy
    };
}

/** Whether a frame lies wholly inside another. */
export function within(frame: BoxFrame, area: BoxFrame): boolean {
    const slack = 1e-9;
    return (
        frame.x >= area.x - slack &&
        frame.y >= area.y - slack &&
        frame.x + frame.w <= area.x + area.w + slack &&
        frame.y + frame.h <= area.y + area.h + slack
    );
}

/** The boxes a selection rectangle drawn over `area` picks up: those wholly
 *  inside it, as in Google Slides, and a group only when all of it is. */
export function inArea(boxes: readonly Box[], area: BoxFrame): string[] {
    const inside = new Set(boxes.filter((box) => within(box, area)).map((box) => box.id));
    return boxes
        .filter(
            (box) =>
                inside.has(box.id) &&
                (!box.group ||
                    boxes.every((other) => other.group !== box.group || inside.has(other.id)))
        )
        .map((box) => box.id);
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/** How close, in pixels, an edge or a middle must come to another before it
 *  snaps to it - Excalidraw's distance, and about Google Slides'. */
export const SNAP_PX = 8;

/** A line a box snapped to: across (`x`, an upright line at that x) or down
 *  (`y`, a level line at that y). */
export interface Guide {
    readonly axis: "x" | "y";
    readonly at: number;
}

/** What a moving box may snap to. */
export interface SnapTargets {
    readonly xs: readonly number[];
    readonly ys: readonly number[];
}

/** The slide's edges and middle, and the edges and middles of every other box
 *  on it. */
export function snapTargets(others: readonly BoxFrame[]): SnapTargets {
    const xs = [0, 0.5, 1];
    const ys = [0, 0.5, 1];
    for (const one of others) {
        xs.push(one.x, one.x + one.w / 2, one.x + one.w);
        ys.push(one.y, one.y + one.h / 2, one.y + one.h);
    }
    return { xs, ys };
}

/** How far to move so the nearest of `points` lands on a target within
 *  `tolerance`, or null when none is that close. */
function nearest(
    points: readonly number[],
    targets: readonly number[],
    tolerance: number
): number | null {
    let best: number | null = null;
    for (const point of points) {
        for (const target of targets) {
            const move = target - point;
            if (Math.abs(move) <= tolerance && (best === null || Math.abs(move) < Math.abs(best)))
                best = move;
        }
    }
    return best;
}

/** The guides to draw once a frame has snapped: every target one of its edges
 *  or its middle now sits exactly on. */
function guidesFor(frame: BoxFrame, targets: SnapTargets, across: boolean, down: boolean): Guide[] {
    const on = (value: number, list: readonly number[]): boolean =>
        list.some((target) => Math.abs(target - value) < 1e-6);
    const guides: Guide[] = [];
    if (across) {
        for (const x of [frame.x, frame.x + frame.w / 2, frame.x + frame.w])
            if (on(x, targets.xs)) guides.push({ axis: "x", at: x });
    }
    if (down) {
        for (const y of [frame.y, frame.y + frame.h / 2, frame.y + frame.h])
            if (on(y, targets.ys)) guides.push({ axis: "y", at: y });
    }
    return guides;
}

/**
 * A frame being dragged, pulled onto the nearest target within `tolerance`
 * (fractions of the slide, across and down) - its left edge, middle or right
 * edge onto one across, its top, middle or bottom onto one down - and the
 * guides that show what it snapped to.
 */
export function snapMove(
    frame: BoxFrame,
    targets: SnapTargets,
    tolerance: { x: number; y: number }
): { frame: BoxFrame; guides: Guide[] } {
    const dx = nearest(
        [frame.x, frame.x + frame.w / 2, frame.x + frame.w],
        targets.xs,
        tolerance.x
    );
    const dy = nearest(
        [frame.y, frame.y + frame.h / 2, frame.y + frame.h],
        targets.ys,
        tolerance.y
    );
    const snapped = shifted(frame, dx ?? 0, dy ?? 0);
    return { frame: snapped, guides: guidesFor(snapped, targets, dx !== null, dy !== null) };
}

/** A frame being resized by `handle`, its moving edges pulled onto the nearest
 *  target within `tolerance`; the edges that are not moving stay put. */
export function snapResize(
    frame: BoxFrame,
    handle: Handle,
    targets: SnapTargets,
    tolerance: { x: number; y: number }
): { frame: BoxFrame; guides: Guide[] } {
    let { x, y, w, h } = frame;
    let across = false;
    let down = false;
    if (handle.endsWith("e") || handle.endsWith("w")) {
        const east = handle.endsWith("e");
        const move = nearest([east ? x + w : x], targets.xs, tolerance.x);
        const next = move === null ? w : east ? w + move : w - move;
        if (move !== null && next >= SMALLEST) {
            if (!east) x += move;
            w = next;
            across = true;
        }
    }
    if (handle.startsWith("n") || handle.startsWith("s")) {
        const south = handle.startsWith("s");
        const move = nearest([south ? y + h : y], targets.ys, tolerance.y);
        const next = move === null ? h : south ? h + move : h - move;
        if (move !== null && next >= SMALLEST) {
            if (!south) y += move;
            h = next;
            down = true;
        }
    }
    const snapped = { x, y, w, h };
    return { frame: snapped, guides: guidesFor(snapped, targets, across, down) };
}
