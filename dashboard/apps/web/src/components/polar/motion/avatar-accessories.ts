/**
 * What Polar wears in each season: a witch's hat for Halloween, a Santa hat in
 * winter, a party hat at New Year and a paper lantern for the Lunar New Year.
 *
 * Drawn in the avatar's 100-unit body space with the front cap's transform, so
 * the hat turns, hops, squashes and nods with the head, at every size the
 * avatar is drawn at, and adds nothing to the layout box. Hats lean left: the
 * North Star hangs at the top right and stays visible.
 */

import type { Season } from "@polaris/core";

interface Shape {
    readonly d: string;
    readonly fill: string;
}

function circle(x: number, y: number, r: number): string {
    return `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
}

const RED = "#E1474C";
const RED_DARK = "#B8323A";
const SNOW = "#FFFFFF";
const SNOW_SHADE = "#DCE1EC";
const GOLD = "#FBBF24";
const ORANGE = "#F59E0B";
const NIGHT = "#2A1B47";
const NIGHT_EDGE = "#4A3378";
const PINK = "#F472B6";
const SKY = "#38BDF8";

/* The head's crown sits at about y 27 between the ears (x 23 and 77). */
const ACCESSORIES: Readonly<Record<Season, readonly Shape[]>> = {
    halloween: [
        { d: "M14 24Q50 12 86 24Q50 32 14 24Z", fill: NIGHT },
        { d: "M33 21Q38 6 38 -6Q35 -14 22 -14Q42 -22 52 -10Q58 2 67 21Q50 17 33 21Z", fill: NIGHT },
        { d: "M33 21Q50 17 67 21L64 14Q50 11 36 14Z", fill: ORANGE },
        { d: "M14 24Q50 12 86 24Q50 19 14 24Z", fill: NIGHT_EDGE }
    ],
    winter: [
        { d: "M30 20Q31 2 46 -4Q60 -8 66 4Q70 12 70 20Z", fill: RED },
        { d: "M46 -4Q30 -6 18 6Q30 0 38 4Z", fill: RED_DARK },
        { d: "M46 -4Q30 -6 18 6Q28 -2 46 -4Z", fill: RED },
        { d: "M27 19Q27 13 33 13H67Q73 13 73 19V21Q73 27 67 27H33Q27 27 27 21Z", fill: SNOW },
        { d: "M27 22Q50 25 73 22V21Q73 27 67 27H33Q27 27 27 21Z", fill: SNOW_SHADE },
        { d: circle(16, 7, 7), fill: SNOW }
    ],
    newYear: [
        { d: "M36 24L46 -12L64 24Q50 28 36 24Z", fill: GOLD },
        { d: "M41 6L46 -12L52 6Q46 8 41 6Z", fill: PINK },
        { d: "M38 17L39.6 12Q50 15 58.6 12L61 17Q50 20 38 17Z", fill: SKY },
        { d: circle(46, -13, 5), fill: PINK }
    ],
    lunarNewYear: [
        { d: "M15 -6H17V0H15Z", fill: GOLD },
        { d: "M9 0H23V3H9Z", fill: GOLD },
        { d: "M16 2Q28 2 28 11Q28 20 16 20Q4 20 4 11Q4 2 16 2Z", fill: RED },
        { d: "M16 2Q20 2 20 11Q20 20 16 20Q12 20 12 11Q12 2 16 2Z", fill: RED_DARK },
        { d: "M9 19H23V22H9Z", fill: GOLD },
        { d: "M14.8 22H17.2V30H14.8Z", fill: GOLD }
    ]
};

let paths: Map<Season, readonly { path: Path2D; fill: string }[]> | null = null;

/** Paint `season`'s accessory in the current transform (the front cap's). */
export function drawAccessory(ctx: CanvasRenderingContext2D, season: Season): void {
    paths ??= new Map();
    let shapes = paths.get(season);
    if (!shapes) {
        shapes = ACCESSORIES[season].map((shape) => ({
            path: new Path2D(shape.d),
            fill: shape.fill
        }));
        paths.set(season, shapes);
    }
    for (const shape of shapes) {
        ctx.fillStyle = shape.fill;
        ctx.fill(shape.path);
    }
}
