/**
 * Whether text can actually be read on the colour behind it.
 *
 * Somebody choosing how their name looks is choosing it against a preview, on
 * one screen, in one theme, at one moment. It is then drawn on a plate they did
 * not choose, under a status line whose colour is the product's rather than
 * theirs, in a light theme and a dark one - and the failure is not subtle: a
 * mid-grey status on a mid-grey gradient is a line nobody can read at all.
 *
 * So the readable colour is worked out rather than declared. This is the
 * WCAG 2 relative-luminance formula, which is the same one every browser's
 * accessibility panel reports: the numbers here are the numbers a reader would
 * see there, which matters because it is the only way an argument about "is that
 * legible" ever ends.
 *
 * Pure and free of the DOM, so the picker that offers a colour and the component
 * that paints it reach the same answer instead of two.
 */

/** The floor for ordinary text, from WCAG 2 AA. Under this it is not a matter of
 *  taste: at 4.5:1 a normal weight at a normal size is legible to somebody with
 *  20/40 vision, and below it, it is not. */
export const READABLE_CONTRAST = 4.5;

/** The floor for text that is large or heavy, which needs less. A name on a
 *  plate is drawn at fourteen pixels or so and does not qualify; a heading
 *  does. */
export const READABLE_CONTRAST_LARGE = 3;

/** One colour, as the fractions the formula wants. Accepts `#rgb`, `#rrggbb`
 *  and anything else is treated as black, which is the safe direction: an
 *  unreadable answer is better than a confident wrong one. */
function channelsOf(color: string): [number, number, number] {
    const hex = color.trim().replace(/^#/, "");
    const full =
        hex.length === 3
            ? hex
                  .split("")
                  .map((digit) => digit + digit)
                  .join("")
            : hex;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];
    return [
        Number.parseInt(full.slice(0, 2), 16) / 255,
        Number.parseInt(full.slice(2, 4), 16) / 255,
        Number.parseInt(full.slice(4, 6), 16) / 255
    ];
}

/** Undo the display's gamma, which is what makes this a measure of light rather
 *  than of the number in the file. */
function linear(value: number): number {
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** How much light comes off a colour, from 0 for black to 1 for white. */
export function luminanceOf(color: string): number {
    const [red, green, blue] = channelsOf(color);
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/**
 * The contrast between two colours, from 1 (identical) to 21 (black on white).
 *
 * Symmetric, because legibility is: dark text on a light plate and light text on
 * a dark one are the same problem read from opposite ends.
 */
export function contrastRatio(one: string, other: string): number {
    const first = luminanceOf(one);
    const second = luminanceOf(other);
    const lighter = Math.max(first, second);
    const darker = Math.min(first, second);
    return (lighter + 0.05) / (darker + 0.05);
}

/** Whether text of this colour can be read on that background. */
export function isReadableOn(
    text: string,
    background: string,
    floor: number = READABLE_CONTRAST
): boolean {
    return contrastRatio(text, background) >= floor;
}

/** Near-black and near-white, which is what text on a coloured surface is drawn
 *  in everywhere in this product. Not pure black: a plate is a soft thing and
 *  ink at #000 on it reads as a hole. */
export const INK_DARK = "#1c1917";
export const INK_LIGHT = "#ffffff";

/**
 * The ink to write on a surface with.
 *
 * Whichever of the two has more contrast against the WORST of the backgrounds
 * given - a gradient is two colours and the letters land on both, so a choice
 * made against one stop is a choice that fails at the other end of the plate.
 */
export function inkFor(...backgrounds: readonly string[]): string {
    const worst = (ink: string) =>
        backgrounds.length === 0
            ? 21
            : Math.min(...backgrounds.map((background) => contrastRatio(ink, background)));
    return worst(INK_LIGHT) >= worst(INK_DARK) ? INK_LIGHT : INK_DARK;
}

/**
 * How legible the best available ink is on a surface, as the ratio itself.
 *
 * For the picker, which has to say more than yes or no: somebody who has just
 * chosen a colour is owed the number and the reason, not a silent refusal.
 */
export function bestContrastOn(...backgrounds: readonly string[]): number {
    const ink = inkFor(...backgrounds);
    return backgrounds.length === 0
        ? 21
        : Math.min(...backgrounds.map((background) => contrastRatio(ink, background)));
}
