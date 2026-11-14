/**
 * Strokes drawn on a shared screen, as the dashboard hands them to this app to
 * show over the shared display (see `main/annotate-overlay`).
 *
 * The dashboard has already believed the stroke - only a seat the sharer let
 * draw gets this far - but the page is still a web page, so its shape is
 * checked here the same way as any other input. Points are fractions of the
 * shared picture, which on a screen share is the whole display.
 */

// The tree-shaken build of zod: the drawing overlay's page reads this, and the
// full one would be nearly all of what that window loads.
import * as z from "zod/mini";

// A number in zod 4 is always finite.
const unit = z.number().check(z.gte(0), z.lte(1));

export const strokeSchema = z.strictObject({
    key: z.string().check(z.regex(/^[^\s\p{Cc}]{1,160}$/u)),
    color: z.string().check(z.regex(/^#[0-9a-f]{6}$/i)),
    points: z.array(z.tuple([unit, unit])).check(z.maxLength(64)),
    end: z.boolean()
});

export type StrokeInput = z.infer<typeof strokeSchema>;

/** How long a stroke stays after its last point, and how long it fades. The
 *  same as the call's, so the sharer sees what the room sees. */
export const HOLD_MS = 3_000;
export const FADE_MS = 1_000;

const POINTS_PER_STROKE = 2_048;
const STROKES_MAX = 200;

export interface ShownStroke {
    readonly color: string;
    readonly points: (readonly [number, number])[];
    last: number;
}

/** Add a stroke's points to what is shown, starting it if it is new. */
export function addShown(board: Map<string, ShownStroke>, stroke: StrokeInput, now: number): void {
    const held = board.get(stroke.key);
    if (held) {
        held.points.push(...stroke.points.slice(0, POINTS_PER_STROKE - held.points.length));
        held.last = now;
        return;
    }
    board.set(stroke.key, { color: stroke.color, points: [...stroke.points], last: now });
    while (board.size > STROKES_MAX) {
        const oldest = board.keys().next().value;
        if (oldest === undefined) break;
        board.delete(oldest);
    }
}

/** How visible a stroke is now: whole while held, then fading to none. */
export function shownAlpha(stroke: ShownStroke, now: number): number {
    const age = now - stroke.last;
    return age <= HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
}
