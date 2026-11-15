/**
 * The geometry of the thermostat dial: a 270° arc open at the bottom, the shape
 * of Home Assistant's `ha-control-circular-slider` and of the Nest and Google
 * Home thermostats. Angles are degrees clockwise from twelve o'clock, so the arc
 * runs from -135° (bottom left, the minimum) to 135° (bottom right, the maximum).
 *
 * Pure, so the value a finger lands on can be asserted without drawing.
 */

import { fractionOf, snapValue, type ValueRange } from "@polaris/ui";

/** The arc's sweep, and where it starts. */
export const DIAL_SWEEP = 270;
export const DIAL_START = -DIAL_SWEEP / 2;

/** Where on the arc a value sits. */
export function angleFromValue(value: number, range: ValueRange): number {
    return DIAL_START + fractionOf(value, range) * DIAL_SWEEP;
}

/** The value at an angle on the arc, held to the range and the step. */
export function valueFromAngle(angle: number, range: ValueRange): number {
    const fraction = (angle - DIAL_START) / DIAL_SWEEP;
    const clamped = Math.min(1, Math.max(0, fraction));
    return snapValue(range.min + clamped * (range.max - range.min), range);
}

/** The angle of a point given as offsets from the centre, x right and y down. */
export function angleFromPoint(dx: number, dy: number): number {
    return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/**
 * The value under a point. In the gap at the bottom it is the nearer end -
 * unless the drag was at the other end a moment ago: a finger that slides
 * through the gap from the maximum does not jump to the minimum.
 */
export function dialValueFromPoint(
    dx: number,
    dy: number,
    range: ValueRange,
    previous: number | null = null
): number {
    const angle = angleFromPoint(dx, dy);
    const inGap = Math.abs(angle) > DIAL_SWEEP / 2;
    if (!inGap) return valueFromAngle(angle, range);
    const end = angle > 0 ? snapValue(range.max, range) : range.min;
    if (previous !== null && Math.abs(fractionOf(end, range) - fractionOf(previous, range)) > 0.5)
        return previous;
    return end;
}

/** A point on a circle at an angle, for drawing. */
export function pointAt(cx: number, cy: number, r: number, angle: number) {
    const radians = (angle * Math.PI) / 180;
    return { x: cx + r * Math.sin(radians), y: cy - r * Math.cos(radians) };
}

/** An SVG path along the circle from one angle to another, clockwise. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
    const start = pointAt(cx, cy, r, from);
    const end = pointAt(cx, cy, r, to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const f = (n: number) => Number(n.toFixed(3));
    return `M ${f(start.x)} ${f(start.y)} A ${r} ${r} 0 ${large} 1 ${f(end.x)} ${f(end.y)}`;
}

export interface DualSetpoint {
    readonly low: number;
    readonly high: number;
}

/**
 * Both ends of a range after one of them moved, kept at least `gap` apart and
 * inside the device's range: the moved end stops at the other rather than
 * pushing it.
 */
export function moveSetpoint(
    current: DualSetpoint,
    handle: "low" | "high",
    to: number,
    range: ValueRange,
    gap = range.step
): DualSetpoint {
    const snapped = snapValue(to, range);
    if (handle === "low") return { ...current, low: Math.min(snapped, current.high - gap) };
    return { ...current, high: Math.max(snapped, current.low + gap) };
}

/** Which end a press picks up: the nearer one, the high end on a tie above it. */
export function nearerSetpoint(current: DualSetpoint, value: number): "low" | "high" {
    const toLow = Math.abs(value - current.low);
    const toHigh = Math.abs(value - current.high);
    if (toLow === toHigh) return value > current.high ? "high" : "low";
    return toLow < toHigh ? "low" : "high";
}
