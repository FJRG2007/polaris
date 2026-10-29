/**
 * Drawing on somebody's shared screen, with their permission.
 *
 * Three things travel, the way hands and game positions do (see
 * `call-signals`, `call-activity`):
 *
 * - **Who may draw is a state.** The person sharing writes the seats they let
 *   draw into their own participant attribute. Somebody who joins later reads
 *   it; a share that ends takes it back. A browser may only write its own
 *   attributes, so nobody can grant themselves a pen on somebody else's screen.
 * - **Asking is an event**, to the person sharing only, and so is the answer.
 * - **A stroke is an event**, to the whole room: points as fractions of the
 *   shared picture, so every screen and the sharer's own display draw it in the
 *   same place whatever size they show it at. A stroke is believed only from a
 *   seat the sharer's attribute names, and fades a few seconds after its last
 *   point, so nothing has to be cleared up.
 *
 * Every message here comes from somebody else's browser, so all of it is parsed
 * with the same strictness as a request body. Pure, so it can be checked
 * without a call server.
 */

import { z } from "zod";

/** The data topic drawing travels on. */
export const ANNOTATE_TOPIC = "polaris-annotate";

/** The attribute the seats allowed to draw ride in, comma separated. Empty is
 *  nobody. */
export const ANNOTATORS = "annotators";

/** The most seats one share lets draw at once. */
export const MAX_ANNOTATORS = 32;

/** The pens, by index on the wire, so a message cannot carry a colour of its
 *  own choosing into a style. */
export const STROKE_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"] as const;

/** The most points one message carries; a longer stroke goes in several. */
export const STROKE_POINTS_MAX = 64;

/** How long a stroke stays after its last point, and how long it then takes to
 *  fade away. */
export const HOLD_MS = 3_000;
export const FADE_MS = 1_000;

/** Bounds on what one browser keeps, whatever the room sends. */
const POINTS_PER_STROKE = 2_048;
const STROKES_MAX = 200;

/** A participant identity as it can ride in the attribute: no separator, no
 *  space, nothing that is not printable. */
const seat = z.string().regex(/^[^\s,\p{Cc}]{1,128}$/u);

/** A fraction of the picture. Finite, and inside it. */
const unit = z.number().finite().min(0).max(1);

export const annotateMessageSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("draw-ask") }).strict(),
    z.object({ kind: z.literal("draw-answer"), allowed: z.boolean() }).strict(),
    z
        .object({
            kind: z.literal("stroke"),
            /** Whose share it is drawn on. */
            on: seat,
            /** Which stroke of the sender's these points continue. */
            id: z.string().regex(/^[a-z0-9]{1,16}$/),
            color: z
                .number()
                .int()
                .min(0)
                .max(STROKE_COLORS.length - 1),
            points: z.array(z.tuple([unit, unit])).min(1).max(STROKE_POINTS_MAX),
            /** The pen came up: nothing more will be added to this stroke. */
            end: z.boolean()
        })
        .strict()
]);

export type AnnotateMessage = z.infer<typeof annotateMessageSchema>;
export type StrokeMessage = Extract<AnnotateMessage, { kind: "stroke" }>;
export type Point = readonly [number, number];

/** The seats a sharer lets draw, read off their attributes. */
export function annotatorsOf(attributes: Record<string, string> | undefined): readonly string[] {
    const raw = attributes?.[ANNOTATORS] ?? "";
    if (!raw) return [];
    return raw
        .split(",")
        .filter((entry) => seat.safeParse(entry).success)
        .slice(0, MAX_ANNOTATORS);
}

/** The attribute value for these seats: each once, valid ones only. */
export function annotatorsAttribute(seats: readonly string[]): string {
    return [...new Set(seats)]
        .filter((entry) => seat.safeParse(entry).success)
        .slice(0, MAX_ANNOTATORS)
        .join(",");
}

export interface Box {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Where the picture actually is inside an element that shows it letterboxed
 * (`object-contain`): the whole box when its shape is not known yet.
 */
export function pictureBox(box: Box, aspect: number | null): Box {
    if (!aspect || !(aspect > 0) || box.width <= 0 || box.height <= 0) return box;
    if (box.width / box.height > aspect) {
        const width = box.height * aspect;
        return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height };
    }
    const height = box.width / aspect;
    return { left: box.left, top: box.top + (box.height - height) / 2, width: box.width, height };
}

/** A point on the page as a fraction of the picture, or null outside it. */
export function toPicture(x: number, y: number, box: Box, aspect: number | null): Point | null {
    const picture = pictureBox(box, aspect);
    if (picture.width <= 0 || picture.height <= 0) return null;
    const px = (x - picture.left) / picture.width;
    const py = (y - picture.top) / picture.height;
    if (px < 0 || px > 1 || py < 0 || py > 1) return null;
    return [Math.round(px * 10_000) / 10_000, Math.round(py * 10_000) / 10_000];
}

/** A stroke as it is drawn: whose, which pen, its points so far. */
export interface Stroke {
    readonly key: string;
    readonly color: string;
    readonly points: Point[];
    /** When its last point arrived, which is what its fading counts from. */
    last: number;
}

/** The strokes on one share, keyed by sender and stroke id. */
export type Board = Map<string, Stroke>;

/** Add a message's points to the board, starting the stroke if it is new. */
export function addStroke(board: Board, from: string, message: StrokeMessage, now: number): void {
    const key = `${from}/${message.id}`;
    const stroke = board.get(key);
    if (stroke) {
        stroke.points.push(...message.points.slice(0, POINTS_PER_STROKE - stroke.points.length));
        stroke.last = now;
        return;
    }
    board.set(key, {
        key,
        color: STROKE_COLORS[message.color] ?? STROKE_COLORS[0],
        points: [...message.points],
        last: now
    });
    // The oldest go first: a map keeps the order things were added in.
    while (board.size > STROKES_MAX) {
        const oldest = board.keys().next().value;
        if (oldest === undefined) break;
        board.delete(oldest);
    }
}

/** How visible a stroke is now: whole while it is held, then fading to none. */
export function strokeAlpha(stroke: Stroke, now: number): number {
    const age = now - stroke.last;
    if (age <= HOLD_MS) return 1;
    return Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
}

/** Drop the strokes that have faded away; whether any are left. */
export function pruneBoard(board: Board, now: number): boolean {
    for (const [key, stroke] of board) {
        if (strokeAlpha(stroke, now) <= 0) board.delete(key);
    }
    return board.size > 0;
}

/** Whether a stroke from `from` on `on`'s share is to be believed. */
export function mayDraw(from: string, on: string, annotators: readonly string[]): boolean {
    return from !== on && annotators.includes(from);
}

/** A fresh stroke id. Unique enough among one sender's strokes in a few seconds. */
export function strokeId(): string {
    return Math.random().toString(36).slice(2, 10) || "s";
}
