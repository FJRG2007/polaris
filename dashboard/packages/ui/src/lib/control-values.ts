/**
 * The arithmetic behind a dragged control: where a value sits on a track, which
 * value a point on the track is, and where a key moves it. Pure, so a slider, a
 * dial and a tile all agree, and so it can be asserted without drawing anything.
 *
 * Every value that leaves here is on the device's own step, counted from its
 * minimum, and inside its range - the same rule the device checks - so a drag
 * can never produce a number the device would refuse.
 */

export interface ValueRange {
    readonly min: number;
    readonly max: number;
    readonly step: number;
}

/** The decimal places a step has, so 21.5 + 0.5 comes out as 22, not 21.999. */
export function stepPlaces(step: number): number {
    const text = String(step);
    const exponent = /e-(\d+)$/.exec(text);
    if (exponent) return Number(exponent[1]);
    return text.split(".")[1]?.length ?? 0;
}

/** A value held to the range and moved to the nearest step from its minimum. */
export function snapValue(value: number, range: ValueRange): number {
    const { min, max, step } = range;
    if (!Number.isFinite(value)) return min;
    const clamped = Math.min(max, Math.max(min, value));
    const steps = step > 0 ? Math.round((clamped - min) / step) : 0;
    const places = stepPlaces(step);
    let snapped = Number((min + steps * step).toFixed(Math.max(places, stepPlaces(min))));
    // A range whose span is not a whole number of steps: the last step past
    // the maximum goes back one rather than out of range.
    if (snapped > max) snapped = Number((snapped - step).toFixed(places));
    return snapped;
}

/** Where a value sits along the track, from 0 at the minimum to 1 at the maximum. */
export function fractionOf(value: number, range: ValueRange): number {
    const span = range.max - range.min;
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, (value - range.min) / span));
}

/** The value at a point along the track, snapped to the step. */
export function valueAt(fraction: number, range: ValueRange): number {
    const clamped = Math.min(1, Math.max(0, fraction));
    return snapValue(range.min + clamped * (range.max - range.min), range);
}

/** How far a big step (Page Up, Shift+arrow) goes: a tenth of the range, at
 *  least one step, and always a whole number of steps. */
export function bigStep(range: ValueRange): number {
    const steps = Math.max(1, Math.round((range.max - range.min) / 10 / range.step));
    return steps * range.step;
}

/**
 * The value after a key, or null for a key the control does not take. Up and
 * Right raise, Down and Left lower, Page Up/Down and Shift take a big step, and
 * Home/End reach the ends - the WAI-ARIA slider pattern.
 */
export function keyedValue(
    value: number | null,
    key: string,
    range: ValueRange,
    big = false
): number | null {
    const from = value ?? range.min;
    const by = big ? bigStep(range) : range.step;
    switch (key) {
        case "ArrowUp":
        case "ArrowRight":
            return snapValue(from + by, range);
        case "ArrowDown":
        case "ArrowLeft":
            return snapValue(from - by, range);
        case "PageUp":
            return snapValue(from + bigStep(range), range);
        case "PageDown":
            return snapValue(from - bigStep(range), range);
        case "Home":
            return range.min;
        case "End":
            return snapValue(range.max, range);
        default:
            return null;
    }
}
