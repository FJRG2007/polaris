/**
 * The Polaris mark, and what it wears in each season.
 *
 * The way Discord and Amazon dress their app icon for a holiday: the mark
 * itself never changes - the violet square and the four-point star - and the
 * season adds one accessory on top of it. Everything is plain path data on the
 * mark's 32-unit grid, so the same shapes are drawn into an SVG (the tab icon,
 * the generated PNGs), onto a canvas (the badged tab icon, the desktop app's
 * window icon) and into the phone apps' launcher icons, and cannot drift apart.
 *
 * Hats lean to the left and the lantern hangs on the left: the top-right corner
 * is where the unread badge is drawn, and it must not cover the accessory.
 */

import type { Season } from "./seasons.js";

/** The unit box the mark is drawn in. */
export const MARK_SIZE = 32;

/** Violet, matching the interface's primary. */
export const MARK_BACKGROUND = "#7632EC";

export const MARK_CORNER = 7;

/** A four-point star - Polaris is the one that does not move. */
export const MARK_STAR = "M16 3Q17.6 12.6 29 16Q17.6 19.4 16 29Q14.4 19.4 3 16Q14.4 12.6 16 3Z";

export const MARK_FOREGROUND = "#FFFFFF";

/** One filled shape of an accessory, in the mark's 32-unit grid. */
export interface MarkShape {
    readonly d: string;
    readonly fill: string;
}

/** A circle as path data, so every shape is one `d` string. */
function circle(x: number, y: number, r: number): string {
    return `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
}

const RED = "#E1474C";
const RED_DARK = "#B8323A";
const SNOW = "#FFFFFF";
const GOLD = "#FBBF24";
const ORANGE = "#F59E0B";
const NIGHT = "#1E1430";
const NIGHT_EDGE = "#3A2560";
const PINK = "#F472B6";
const SKY = "#38BDF8";
const MINT = "#34D399";

/**
 * What the mark wears, season by season, painted in order. Each sits on the
 * star's top point, leaving its other three points and the square untouched,
 * so the mark stays recognisable at 16 px.
 */
export const SEASON_MARK_ACCESSORIES: Readonly<Record<Season, readonly MarkShape[]>> = {
    // A witch's hat, crooked tip to the left, with an orange band.
    halloween: [
        { d: "M6.2 11.6Q16 7.6 25.8 11.6Q16 14.4 6.2 11.6Z", fill: NIGHT },
        { d: "M10.4 10.6Q12.2 6.4 12.6 3.8Q11.2 2.2 7.8 2Q13.6 0.2 17.2 2.6Q18.6 6 21.6 10.6Q16 9.2 10.4 10.6Z", fill: NIGHT },
        { d: "M10.1 10.3Q16 8.8 21.9 10.3L21 8.6Q16 7.4 10.9 8.6Z", fill: ORANGE },
        { d: "M6.2 11.6Q16 7.6 25.8 11.6Q16 10.2 6.2 11.6Z", fill: NIGHT_EDGE }
    ],
    // A Santa hat flopping to the left, white fur brim and bobble.
    winter: [
        { d: "M10.2 9.4Q10.4 4.6 13.6 2.6Q17.2 0.8 20 3.2Q22 5.2 22.2 9.4Z", fill: RED },
        { d: "M13.6 2.6Q9.6 2.6 7.4 6.2Q10.4 4.4 12.4 5.4Z", fill: RED_DARK },
        { d: "M13.6 2.6Q9.6 2.6 7.4 6.2Q9.6 3.6 13.6 2.6Z", fill: RED },
        // A sliver of the square around the fur, so white brim and white star
        // stay two shapes at 16 px.
        { d: "M8.2 9.2Q8.2 6.6 10.8 6.6H21.2Q23.8 6.6 23.8 9.2V10Q23.8 12.6 21.2 12.6H10.8Q8.2 12.6 8.2 10Z", fill: MARK_BACKGROUND },
        { d: "M9.2 9.2Q9.2 7.6 10.8 7.6H21.2Q22.8 7.6 22.8 9.2V10Q22.8 11.6 21.2 11.6H10.8Q9.2 11.6 9.2 10Z", fill: SNOW },
        { d: circle(7.2, 6.6, 2.2), fill: SNOW }
    ],
    // A striped party hat, a bobble on its tip, and confetti in the corners.
    newYear: [
        { d: "M11.2 11.2L13.4 1.8L20.6 11.2Q16 12.4 11.2 11.2Z", fill: GOLD },
        { d: "M12.4 6.2L14.6 3.4L16.8 6.2Q14.6 7 12.4 6.2Z", fill: PINK },
        { d: "M11.6 9.4L12 7.8Q15 8.8 18.4 8.2L19.6 9.8Q15.4 10.6 11.6 9.4Z", fill: SKY },
        { d: circle(13.4, 2, 1.7), fill: PINK },
        { d: "M4 4.2l1.6-.6.6 1.6-1.6.6Z", fill: GOLD },
        { d: "M25.6 25l1.4-.9.9 1.4-1.4.9Z", fill: SKY },
        { d: circle(5.4, 26.4, 0.9), fill: MINT },
        { d: circle(26.8, 5.8, 0.8), fill: PINK }
    ],
    // A red paper lantern hanging in the top-left corner, gold caps and tassel.
    lunarNewYear: [
        { d: "M7.6 1.2H8.4V3H7.6Z", fill: GOLD },
        { d: "M5.6 3H10.4V4.2H5.6Z", fill: GOLD },
        { d: "M8 3.8Q12.6 3.8 12.6 8Q12.6 12.2 8 12.2Q3.4 12.2 3.4 8Q3.4 3.8 8 3.8Z", fill: RED },
        { d: "M8 3.8Q9.6 3.8 9.6 8Q9.6 12.2 8 12.2Q6.4 12.2 6.4 8Q6.4 3.8 8 3.8Z", fill: RED_DARK },
        { d: "M5.6 11.8H10.4V13H5.6Z", fill: GOLD },
        { d: "M7.5 13H8.5V16.4H7.5Z", fill: GOLD }
    ]
};

/**
 * The mark as an SVG document, wearing `season`'s accessory when there is one.
 * With no season it is the plain mark, identical to the app's `icon.svg`.
 */
export function seasonMarkSvg(season: Season | null, size = MARK_SIZE): string {
    const shapes = season ? SEASON_MARK_ACCESSORIES[season] : [];
    const extra = shapes.map((shape) => `<path d="${shape.d}" fill="${shape.fill}"/>`).join("");
    const box = `0 0 ${MARK_SIZE} ${MARK_SIZE}`;
    const square = `<rect width="${MARK_SIZE}" height="${MARK_SIZE}" rx="${MARK_CORNER}" fill="${MARK_BACKGROUND}"/>`;
    const star = `<path d="${MARK_STAR}" fill="${MARK_FOREGROUND}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${box}">${square}${star}${extra}</svg>`;
}
