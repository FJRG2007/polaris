/**
 * The colour a link card wears, when the site it points at declares one.
 *
 * A video from YouTube should read as YouTube before a word of it is read, the
 * same way it does everywhere else links are shown. The colour is not invented
 * here and is not a table of brands: the server stores what the site itself
 * publishes - the `theme_color` in its web app manifest, or its `theme-color`
 * meta tag - and this decides whether that answer can actually be drawn.
 *
 * Two are refused. Anything that is not a plain hex colour, because this ends up
 * in a style attribute and `rgba(...)`, a named colour or a stray `;` are all
 * things a site could put there. And anything so close to white or to black that
 * the bar would vanish into the card in one of the two themes - a site saying it
 * is white is saying nothing useful about itself.
 *
 * Pure, so the same answer is reached on the server and in the browser.
 */

/** `#rgb` or `#rrggbb`, and nothing else. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Past this the bar is lost against a light surface. */
const TOO_PALE = 0.82;

/** Below it, against a dark one. */
const TOO_DARK = 0.04;

/** The colour to draw, or null to leave the card on Polaris' own accent. */
export function usableAccent(color: string | null | undefined): string | null {
    if (!color || !HEX.test(color.trim())) return null;
    const hex = color.trim().toLowerCase();
    const light = luminance(hex);
    return light > TOO_PALE || light < TOO_DARK ? null : hex;
}

/** Relative luminance, the sRGB one, so "would this disappear" is answered the
 *  way an eye answers it rather than by averaging three numbers. */
function luminance(hex: string): number {
    const full =
        hex.length === 4
            ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
            : hex;
    const channel = (at: number): number => {
        const value = Number.parseInt(full.slice(at, at + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
