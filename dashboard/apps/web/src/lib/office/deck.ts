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
