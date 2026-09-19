/**
 * A microphone's level as a row of bars, the way every call client draws it.
 *
 * The level is the one `voice-level` reads - 0 to 100 of full scale, already
 * stretched so a voice sits in the middle of it - so the bars agree with the
 * threshold a voice-activity microphone is set against.
 *
 * The colour belongs to the bar, not to the reading: the first bars are green
 * however they are reached, the ones near the top are yellow, and the last are
 * red. A voice at an ordinary distance lights the green; shouting, or a
 * microphone too close, reaches the red - which is the thing somebody needs to
 * see to move it away.
 */

/** How many bars the meter draws. */
export const METER_BARS = 16;

/** Below this a reading is the noise floor of a quiet room, not sound. */
const FLOOR = 3;

/** Where the colours change, as a share of the row. */
const MID_FROM = 0.6;
const HIGH_FROM = 0.85;

export type BarTone = "low" | "mid" | "high";

/** How many bars a level lights, counting from the left. */
export function litBars(level: number, count: number = METER_BARS): number {
    if (!Number.isFinite(level) || level < FLOOR) return 0;
    return Math.min(count, Math.ceil((Math.min(level, 100) / 100) * count));
}

/** The colour of one bar, by where it sits in the row. */
export function barTone(index: number, count: number = METER_BARS): BarTone {
    const at = index / count;
    if (at >= HIGH_FROM) return "high";
    if (at >= MID_FROM) return "mid";
    return "low";
}
