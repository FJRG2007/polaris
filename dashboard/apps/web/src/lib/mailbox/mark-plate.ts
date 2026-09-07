/**
 * Whether a sender's mark needs something behind it to be seen at all.
 *
 * Almost every mark a site publishes is drawn for one background - its own -
 * and a great many of them are near-black on transparency. Put one of those in
 * front of a reader in the dark theme and there is nothing there: a hole where a
 * logo should be, in the column whose entire job is to be scannable.
 *
 * The answer is the same one this product already uses for a name on somebody's
 * profile plate: measure it. The WCAG relative-luminance formula in
 * `@polaris/core` decides whether a colour can be seen against another, and the
 * mark is put on a plate exactly when it cannot be seen against a surface it will
 * actually land on. One decision has to serve both themes, so both are checked
 * and the plate is whichever of near-white and near-black the mark reads best
 * against - a dark mark gets white, a white mark gets ink, and a mark that is
 * legible on both is left alone rather than given a badge it does not need.
 *
 * Pure: the component measures the pixels and this decides, so the decision can
 * be checked without a browser.
 */

import { INK_DARK, INK_LIGHT, contrastRatio, inkFor, READABLE_CONTRAST_LARGE } from "@polaris/core";

/** How opaque a pixel has to be before it counts towards the mark's colour.
 *  Anti-aliased edges are half a pixel of the logo and half a pixel of nothing,
 *  and letting them in drags every measurement towards the middle. */
const SOLID_ENOUGH = 128;

/** How much of an image has to be there at all. A mark that is almost entirely
 *  transparent is a wide file with a small logo in it, and averaging the whole
 *  thing would describe the emptiness rather than the logo. */
const MIN_SOLID_FRACTION = 0.02;

/**
 * The average colour of what is actually drawn in an image, as hex.
 *
 * Transparent pixels are not a colour and are left out entirely - averaging them
 * as black is what makes every mark on a transparent background look dark. Null
 * when there was effectively nothing solid to measure.
 */
export function markColor(pixels: Uint8ClampedArray): string | null {
    let red = 0;
    let green = 0;
    let blue = 0;
    let solid = 0;
    for (let index = 0; index + 3 < pixels.length; index += 4) {
        if ((pixels[index + 3] ?? 0) < SOLID_ENOUGH) continue;
        red += pixels[index] ?? 0;
        green += pixels[index + 1] ?? 0;
        blue += pixels[index + 2] ?? 0;
        solid += 1;
    }
    const total = Math.floor(pixels.length / 4);
    if (total === 0 || solid / total < MIN_SOLID_FRACTION) return null;

    const hex = (value: number): string =>
        Math.round(value / solid)
            .toString(16)
            .padStart(2, "0");
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

/**
 * The colour to put behind a mark, or null to leave it as it is.
 *
 * Non-text contrast is the 3:1 floor rather than the 4.5:1 one for body text:
 * this is a shape being told apart from what is behind it, not a sentence being
 * read, and holding a logo to the standard of paragraph text would put a plate
 * behind almost all of them.
 */
export function plateFor(mark: string | null): string | null {
    if (!mark) return null;
    const surfaces = [INK_LIGHT, INK_DARK];
    const legibleEverywhere = surfaces.every(
        (surface) => contrastRatio(mark, surface) >= READABLE_CONTRAST_LARGE
    );
    if (legibleEverywhere) return null;
    return inkFor(mark);
}
