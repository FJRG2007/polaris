/**
 * Deciding that something in the picture moved.
 *
 * The cheap version of this - compare a frame with the one before it and count
 * the pixels that changed - is what Places has been doing, and it is wrong in
 * two ways that both show up as alerts at three in the morning. It has no memory
 * beyond one frame, so a camera swaying in the wind reports movement forever;
 * and it answers with a single percentage, so there is nothing to say *where* it
 * moved, which means an area drawn on the picture cannot be applied to it.
 *
 * This is the version the field settled on, and it is four ideas:
 *
 *   - Compare against a slowly-updated average of the scene rather than the last
 *     frame. A tree that sways is part of the average within a minute; a person
 *     who walks in is not.
 *   - Stretch the contrast first, using a rolling estimate rather than this
 *     frame's own extremes. At night most of the picture is sensor noise inside
 *     a narrow band of grey, and without this the threshold has to be set so
 *     high that a person in the dark is invisible too.
 *   - Blur before comparing, so single-pixel noise cannot survive.
 *   - Answer with the outlines of what changed, not a number. That is what makes
 *     an ignore area possible at all, and it is what tells the detector where in
 *     the frame to look.
 *
 * Everything here works on a plain grey frame - one byte per pixel, no image
 * library - and returns boxes as fractions of the frame. It is pure: the state
 * goes in and comes back out, so a whole windy afternoon can be played through
 * it in a test.
 */

import { pointInPolygon } from "./camera-zones.js";
import type { RelativeBox, Zone } from "./camera-zones.js";

export interface MotionOptions {
    readonly width: number;
    readonly height: number;
    /** How different a pixel has to be from the scene's average to count. */
    readonly threshold?: number;
    /** The smallest patch worth calling movement, in pixels of the small frame.
     *  At the size this runs on, ten pixels is a bird at the end of a garden. */
    readonly minArea?: number;
    /** Pixels the camera was told never to look at: 1 to ignore. */
    readonly mask?: Uint8Array | null;
    /** How fast the scene's average follows the picture. Slow on purpose: this
     *  is the number that decides whether a parked car becomes part of the
     *  street or stays an event forever. */
    readonly frameAlpha?: number;
    /** Above this share of the frame changing, the whole picture changed -
     *  headlights, a light switch, the camera flipping to night mode - and
     *  nothing in it is worth reporting. The scene is relearned instead. */
    readonly lightningThreshold?: number;
    readonly improveContrast?: boolean;
}

export interface MotionState {
    /** The scene as it has been lately, one float per pixel. */
    readonly average: Float32Array;
    /** Frames running that something has been moving. The average only follows
     *  the picture once movement has persisted, so somebody standing still for a
     *  moment does not get absorbed into the background. */
    readonly motionFrames: number;
    /** Still learning what the scene looks like: after a start, and after
     *  anything that changed the whole picture. While it is, the average
     *  follows fast and nothing is reported. */
    readonly calibrating: boolean;
    /** The last few frames' dark and light points, so the contrast stretch does
     *  not jump when a car's headlights cross the view. */
    readonly contrast: readonly (readonly [number, number])[];
}

export interface MotionResult {
    readonly state: MotionState;
    /** Where it moved, as fractions of the frame. Empty while calibrating. */
    readonly boxes: readonly RelativeBox[];
    /** How much of the frame changed, 0 to 1. */
    readonly fraction: number;
}

/** How many frames of dark and light points the stretch is averaged over. */
const CONTRAST_HISTORY = 50;

/** How fast the average follows while the scene is still being learnt. */
const CALIBRATING_ALPHA = 0.2;

/** Frames of movement before the average is allowed to follow the picture. */
const SETTLE_FRAMES = 10;

export function newMotionState(width: number, height: number): MotionState {
    return {
        average: new Float32Array(width * height),
        motionFrames: 0,
        calibrating: true,
        contrast: []
    };
}

/**
 * The pixels an ignore area covers, as a bitmap the size of the small frame.
 *
 * Built once when a camera's areas change rather than per frame: it is the same
 * answer every time and it is the only part of this that touches a polygon.
 * Each pixel is tested at its own centre, which is what stops a boundary drawn
 * along a wall from either leaking a row of pixels or eating one.
 */
export function buildMotionMask(
    zones: readonly Zone[],
    width: number,
    height: number
): Uint8Array | null {
    const ignored = zones.filter(
        (zone) => zone.kind === "ignore" && zone.enabled && zone.points.length >= 3
    );
    if (ignored.length === 0) return null;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        const centreY = (y + 0.5) / height;
        for (let x = 0; x < width; x += 1) {
            const point = { x: (x + 0.5) / width, y: centreY };
            if (ignored.some((zone) => pointInPolygon(point, zone.points))) mask[y * width + x] = 1;
        }
    }
    return mask;
}

/** The value below which a given share of the picture sits, from a histogram
 *  rather than a sort: at this frame size a sort is the most expensive thing in
 *  the whole pipeline and a histogram gives the same answer in one pass. */
function percentile(frame: Uint8Array, share: number): number {
    const counts = new Uint32Array(256);
    for (let index = 0; index < frame.length; index += 1) counts[frame[index]!]! += 1;
    const target = Math.max(1, Math.floor(frame.length * share));
    let seen = 0;
    for (let value = 0; value < 256; value += 1) {
        seen += counts[value]!;
        if (seen >= target) return value;
    }
    return 255;
}

/** A three-by-three average, run once across and once down. Cheaper than the
 *  same thing in two dimensions and, at this radius, the same picture. */
function blur(frame: Uint8Array, width: number, height: number): Uint8Array {
    const across = new Uint8Array(frame.length);
    for (let y = 0; y < height; y += 1) {
        const row = y * width;
        for (let x = 0; x < width; x += 1) {
            const left = frame[row + Math.max(0, x - 1)]!;
            const middle = frame[row + x]!;
            const right = frame[row + Math.min(width - 1, x + 1)]!;
            across[row + x] = (left + middle + right) / 3;
        }
    }
    const down = new Uint8Array(frame.length);
    for (let y = 0; y < height; y += 1) {
        const above = Math.max(0, y - 1) * width;
        const row = y * width;
        const below = Math.min(height - 1, y + 1) * width;
        for (let x = 0; x < width; x += 1) {
            down[row + x] = (across[above + x]! + across[row + x]! + across[below + x]!) / 3;
        }
    }
    return down;
}

/**
 * Group the changed pixels into patches, and give each one a box.
 *
 * A flood fill from every changed pixel that has not been claimed, four ways
 * rather than eight so a diagonal thread of noise does not join two unrelated
 * patches. The stack is an array of indexes rather than recursion: a patch can
 * be the whole frame, and the whole frame is deeper than a call stack.
 */
function patches(
    changed: Uint8Array,
    width: number,
    height: number,
    minArea: number
): { boxes: RelativeBox[]; total: number } {
    const seen = new Uint8Array(changed.length);
    const boxes: RelativeBox[] = [];
    let total = 0;
    const stack: number[] = [];

    for (let start = 0; start < changed.length; start += 1) {
        if (changed[start] === 0 || seen[start] === 1) continue;
        seen[start] = 1;
        stack.length = 0;
        stack.push(start);
        let minX = width;
        let maxX = -1;
        let minY = height;
        let maxY = -1;
        let area = 0;

        while (stack.length > 0) {
            const index = stack.pop()!;
            const x = index % width;
            const y = (index - x) / width;
            area += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            if (x > 0 && changed[index - 1] === 1 && seen[index - 1] === 0) {
                seen[index - 1] = 1;
                stack.push(index - 1);
            }
            if (x < width - 1 && changed[index + 1] === 1 && seen[index + 1] === 0) {
                seen[index + 1] = 1;
                stack.push(index + 1);
            }
            if (y > 0 && changed[index - width] === 1 && seen[index - width] === 0) {
                seen[index - width] = 1;
                stack.push(index - width);
            }
            if (y < height - 1 && changed[index + width] === 1 && seen[index + width] === 0) {
                seen[index + width] = 1;
                stack.push(index + width);
            }
        }

        total += area;
        if (area < minArea) continue;
        boxes.push({
            x1: minX / width,
            y1: minY / height,
            // The far edge of the last pixel, not its near edge, so a patch one
            // pixel wide is one pixel wide rather than nothing.
            x2: (maxX + 1) / width,
            y2: (maxY + 1) / height
        });
    }

    return { boxes, total };
}

/** Grow the changed pixels by one, so a patch broken up by noise closes into
 *  one thing rather than a scatter of small ones that each fail the area test. */
function grow(changed: Uint8Array, width: number, height: number): Uint8Array {
    const grown = new Uint8Array(changed.length);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (changed[index] === 1) {
                grown[index] = 1;
                continue;
            }
            const left = x > 0 && changed[index - 1] === 1;
            const right = x < width - 1 && changed[index + 1] === 1;
            const above = y > 0 && changed[index - width] === 1;
            const below = y < height - 1 && changed[index + width] === 1;
            if (left || right || above || below) grown[index] = 1;
        }
    }
    return grown;
}

/**
 * One frame through the whole thing.
 *
 * The order matters and is the order the comments give: contrast, then the
 * mask, then the blur, then the comparison. Masking after the stretch is
 * deliberate - an ignored area full of moving headlights would otherwise drag
 * the stretch around and change what counts as movement everywhere else.
 */
export function detectMotion(
    state: MotionState,
    frame: Uint8Array,
    options: MotionOptions
): MotionResult {
    const { width, height } = options;
    const threshold = options.threshold ?? 30;
    const minArea = options.minArea ?? 10;
    const frameAlpha = options.frameAlpha ?? 0.01;
    const lightningThreshold = options.lightningThreshold ?? 0.8;
    const pixels = width * height;

    let working = frame;
    let contrast = state.contrast;

    if (options.improveContrast !== false) {
        const dark = percentile(frame, 0.04);
        const light = percentile(frame, 0.96);
        // A frame that is all one shade has no contrast to stretch, and
        // stretching it would turn its noise into the whole range.
        if (dark < light) {
            contrast = [...state.contrast, [dark, light] as const].slice(-CONTRAST_HISTORY);
            let sumDark = 0;
            let sumLight = 0;
            for (const [low, high] of contrast) {
                sumDark += low;
                sumLight += high;
            }
            const averageDark = sumDark / contrast.length;
            const averageLight = sumLight / contrast.length;
            const span = averageLight - averageDark;
            if (span > 0) {
                const stretched = new Uint8Array(pixels);
                for (let index = 0; index < pixels; index += 1) {
                    const clipped = Math.min(averageLight, Math.max(averageDark, frame[index]!));
                    stretched[index] = ((clipped - averageDark) / span) * 255;
                }
                working = stretched;
            }
        }
    }

    if (options.mask) {
        // Copied rather than written through: `working` may still be the
        // caller's frame, and a mask is not something to leave behind in it.
        const masked = new Uint8Array(working);
        for (let index = 0; index < pixels; index += 1) {
            if (options.mask[index] === 1) masked[index] = 0;
        }
        working = masked;
    }

    const blurred = blur(working, width, height);

    const changed = new Uint8Array(pixels);
    for (let index = 0; index < pixels; index += 1) {
        if (Math.abs(blurred[index]! - state.average[index]!) > threshold) changed[index] = 1;
    }

    const found = patches(grow(changed, width, height), width, height, minArea);
    const fraction = found.total / pixels;

    // The whole picture changed, so nothing in it is a thing that happened.
    // Relearn the scene from here instead of reporting a frame of nonsense.
    let calibrating = state.calibrating;
    if (fraction > lightningThreshold) calibrating = true;
    else if (fraction < 0.05 && found.boxes.length <= 4) calibrating = false;

    const moving = found.boxes.length > 0;
    const motionFrames = moving ? state.motionFrames + 1 : 0;
    const average = new Float32Array(state.average);
    // While something is moving, the average is held still until the movement
    // has persisted - otherwise somebody standing at a door is quietly absorbed
    // into the background and the camera stops seeing them.
    if (!moving || motionFrames >= SETTLE_FRAMES) {
        const alpha = calibrating ? CALIBRATING_ALPHA : frameAlpha;
        for (let index = 0; index < pixels; index += 1) {
            average[index] = average[index]! * (1 - alpha) + blurred[index]! * alpha;
        }
    }

    return {
        state: { average, motionFrames, calibrating, contrast },
        boxes: calibrating ? [] : found.boxes,
        fraction
    };
}
