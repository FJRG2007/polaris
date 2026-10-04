/**
 * How a person is greeted and drawn when there is no photo of them.
 *
 * Here rather than beside the dashboard's avatar component because the browser
 * extension draws the same person and says the same hello, and two copies of
 * these rules would be two colours for one face the first time either changed.
 */

import { INK_LIGHT, READABLE_CONTRAST, contrastRatio } from "./contrast.js";

/** "Good morning" and the rest, by the reader's own clock. */
export function greetingFor(date: Date): string {
    const hour = date.getHours();
    if (hour < 6) return "Good night";
    if (hour < 12) return "Good morning";
    if (hour < 19) return "Good afternoon";
    return "Good evening";
}

/** The first word of a display name, which is what a greeting addresses. */
export function firstName(name: string): string {
    return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * The colour behind somebody's initials.
 *
 * The hue comes from the id - stable, so the same person is the same colour on
 * every screen, and spread, so two people in a list are tellable apart before
 * their initials are read. Saturation and lightness are fixed, and the letters
 * on it are drawn in `initialsInk` of it - white on most, black on the light
 * ones - so every tint reads at 4.5:1. White alone did not: on the yellows it
 * was 3.3:1.
 */
export function tintFor(id: string): string {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
        hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    }
    return `hsl(${hash % 360} 36% 42%)`;
}

/** Initials from a display name. Two words give two letters, one word gives two
 *  of its own, and something unnameable gives a question mark. */
export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    return (
        parts.length === 1 ? parts[0]!.slice(0, 2) : `${parts[0]![0]}${parts[1]![0]}`
    ).toUpperCase();
}

/**
 * The dark ink for initials: black.
 *
 * Not `INK_DARK`, the product's near-black for text on a coloured plate. At the
 * lightness `tintFor` uses there are hues where white is under 4.5:1 and that
 * near-black is too; only black clears the bar on every one of them.
 */
export const INITIALS_INK_DARK = "#000000";

/**
 * The colour to draw initials in on a tint: white where white reads at 4.5:1,
 * black where it does not, and whichever reads better on a fill where neither
 * does. A fill that cannot be read as a colour keeps white, as before.
 */
export function initialsInk(tint: string): string {
    const light = contrastRatio(INK_LIGHT, tint);
    if (light >= READABLE_CONTRAST) return INK_LIGHT;
    return contrastRatio(INITIALS_INK_DARK, tint) > light ? INITIALS_INK_DARK : INK_LIGHT;
}
