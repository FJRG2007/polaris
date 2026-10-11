/**
 * A king of the hill's commands: the platform it floats on - `LIFT` over the
 * highest thing under it, built only into air proven empty and taken away
 * again, only that block, only inside its own box - and how the players brought
 * to it are kept from harm.
 *
 * With "fists only" players join, their things are kept (`stash`) and they
 * come in empty-handed, in adventure mode. Off the circle the hill wears them
 * down (Poison, down to three hearts); in it, it mends them (Regeneration).
 * Whoever is knocked off falls slowly and is brought back to the edge, the
 * fire and the water cannot hurt them, and a fist's knockback is left whole:
 * pushing is how the circle is won. keepInventory is held for all of it.
 *
 * Pure; the loop is `hill-service.ts`.
 */

import { seeded } from "../trivia-bank";
import type { Box, Point } from "../state";
import { IN_ARENA, type Spot } from "./arena";
import { HILL_HEALTH, HILL_INSIDE, SCORE } from "../commands";

/** The platform's block: plain, cheap, and nothing the sea has. */
export const PLATFORM_BLOCK = "minecraft:smooth_stone";
/** The platform's edge, its corners, and the circle drawn on it. */
export const EDGE_BLOCK = "minecraft:polished_andesite";
export const CORNER_BLOCK = "minecraft:sea_lantern";
export const RING_BLOCK = "minecraft:yellow_concrete";
/** Every block the platform is built of, for taking it down. */
export const PLATFORM_BLOCKS = [PLATFORM_BLOCK, EDGE_BLOCK, CORNER_BLOCK, RING_BLOCK] as const;

/**
 * What a platform is built of: its floor, its edge, its corners, the ring
 * drawn on it, and what stands over the floor - on the corners, and in the
 * middle of each side. The ring is only ever drawn onto the floor's block and
 * rubbed out back to it (`redrawLines`), so the floor inside the edge is one
 * block whatever the look.
 */
export interface Look {
    readonly floor: string;
    readonly edge: string;
    readonly corner: string;
    readonly ring: string;
    /** Over each corner; null for nothing. */
    readonly top: string | null;
    /** Over the middle of each side, turned to look in; null for nothing. */
    readonly middle: string | null;
}

/** The plain platform: a king of the hill walked to, or a server before 1.19. */
export const PLAIN: Look = {
    floor: PLATFORM_BLOCK,
    edge: EDGE_BLOCK,
    corner: CORNER_BLOCK,
    ring: RING_BLOCK,
    top: null,
    middle: null
};

/**
 * The king of the ring's own (fists only, from 1.19): a floor of deepslate
 * tiles edged in sculk, a block of the deep's own stone at each corner with a
 * soul campfire burning on it, a wither skeleton's skull in the middle of each
 * side looking in, and the ring a line of froglight - under the soul sand
 * valley's sky (`DEATH_BIOME`), with souls and ash drifting over it
 * (`ambientLines`). The edge is a block past where the ring can ever drift,
 * so the sculk is never painted over.
 */
export const DEATH_SINCE = [1, 19] as const;
export const DEATH: Look = {
    floor: "minecraft:deepslate_tiles",
    edge: "minecraft:sculk",
    corner: "minecraft:reinforced_deepslate",
    ring: "minecraft:ochre_froglight",
    top: "minecraft:soul_campfire",
    middle: "minecraft:wither_skeleton_skull"
};

/**
 * The king of the ring's court (fists only, from 1.19), the look every new
 * ring is built in: the same fighting floor - one block inside a clear border,
 * the ring drawn on it in froglight - raised on a tapered underside of
 * blackstone with a gilded core, and round it, out of reach of anybody knocked
 * off (`royalPieces`), a court in blackstone, crimson and gold: stands down
 * two sides, an entrance arch with a red carpet, a throne under a jewelled
 * crown, four tall pillars, red banners, soul lanterns, and a golden crown
 * floating high over the middle of the ring. Lit all round, so nothing
 * hostile spawns on any of it.
 *
 * Only blocks with no collision (banners, unseen light) and low markers (a
 * lantern on each corner) stand on or over the floor; everything else keeps out of the
 * air a knocked-off player falls through before they are brought back
 * (`strayed`), so who falls and who stays is exactly as on a plain platform.
 */
export const ROYAL_SINCE = DEATH_SINCE;
export const ROYAL: Look = {
    floor: "minecraft:polished_blackstone",
    edge: "minecraft:red_nether_bricks",
    corner: "minecraft:chiseled_polished_blackstone",
    ring: "minecraft:ochre_froglight",
    top: "minecraft:soul_lantern",
    middle: "minecraft:red_banner"
};

/**
 * Every block of the court, in the order it is taken down: whatever hangs on,
 * stands on or lies on something first, so nothing it holds up is ever
 * dropped as an item when what held it goes.
 */
const ROYAL_BLOCKS = [
    "minecraft:red_wall_banner",
    "minecraft:red_banner",
    "minecraft:soul_lantern",
    "minecraft:end_rod",
    "minecraft:red_carpet",
    "minecraft:light",
    "minecraft:soul_campfire",
    "minecraft:chain",
    "minecraft:polished_blackstone_brick_stairs",
    "minecraft:polished_blackstone_stairs",
    "minecraft:polished_blackstone_brick_wall",
    "minecraft:gold_block",
    "minecraft:shroomlight",
    ROYAL.ring,
    ROYAL.edge,
    ROYAL.corner,
    ROYAL.floor,
    "minecraft:polished_blackstone_bricks",
    "minecraft:gilded_blackstone",
    "minecraft:blackstone"
] as const;

/** The look a platform was built in, from the blocks its arena lists - the
 *  same after a restart, and plain for one built before there were looks. */
export function lookOf(blocks: readonly string[]): Look {
    if (blocks.includes(ROYAL.floor)) return ROYAL;
    return blocks.includes(DEATH.floor) ? DEATH : PLAIN;
}

/** Every block of a look, for its arena's list and so for taking it down. */
export function lookBlocks(look: Look): string[] {
    if (look === ROYAL) return [...ROYAL_BLOCKS];
    return [look.floor, look.edge, look.corner, look.ring, look.top, look.middle].filter(
        (one): one is string => one !== null
    );
}

/** How far apart, and how high over the floor, its unseen lights hang. */
const LIGHT_EVERY = 8;
const LIGHT_OVER = 6;

/** How far the court reaches past the floor's edge, all round. */
const COURT = 10;
/** How far under the floor its underside hangs, and how far over it the
 *  crown floats - the top of the court. */
const UNDERSIDE = 4;
const COURT_TOP = 12;

/**
 * Where the court starts, past the floor's edge: the first block a knocked-off
 * player could only reach already brought back (`strayed`, from the middle of
 * the block they would stand on).
 */
function courtStart(): number {
    return STRAY + 1;
}

/**
 * The court round a platform, in the order it is built - what holds a block
 * up always before it. `place` is the platform's floor; the floor itself is
 * filled round all this afterwards (`platformDecor`).
 */
function royalPieces(place: Point, radius: number): { box: Box; block: string }[] {
    const half = radius + MARGIN;
    const { x, y, z } = place;
    const out: { box: Box; block: string }[] = [];
    const fill = (
        x1: number,
        y1: number,
        z1: number,
        x2: number,
        y2: number,
        z2: number,
        block: string
    ) =>
        out.push({
            box: {
                x1: Math.min(x1, x2),
                y1: Math.min(y1, y2),
                z1: Math.min(z1, z2),
                x2: Math.max(x1, x2),
                y2: Math.max(y1, y2),
                z2: Math.max(z1, z2)
            },
            block
        });
    const one = (bx: number, by: number, bz: number, block: string) =>
        fill(bx, by, bz, bx, by, bz, block);
    const square = (by: number, size: number, block: string) => {
        if (size >= 0) fill(x - size, by, z - size, x + size, by, z + size, block);
    };

    // Raised: a tapered underside, blackstone round a gilded core.
    square(y - 1, half, "minecraft:polished_blackstone_bricks");
    square(y - 2, half - 1, "minecraft:blackstone");
    square(y - 3, half - 3, "minecraft:blackstone");
    square(y - 4, half - 6, "minecraft:gilded_blackstone");

    // The border: crimson brick, a shroomlight every fourth block to light the
    // floor all round, chiseled blackstone on the corners. Never the floor's
    // block or the ring's, so the ring's redraw never touches it.
    for (let t = -half + 1; t <= half - 1; t += 1) {
        if (t % 4 !== 0) continue;
        one(x + t, y, z - half, "minecraft:shroomlight");
        one(x + t, y, z + half, "minecraft:shroomlight");
        one(x - half, y, z + t, "minecraft:shroomlight");
        one(x + half, y, z + t, "minecraft:shroomlight");
    }
    const corners = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1]
    ] as const;
    for (const [sx, sz] of corners) one(x + sx * half, y, z + sz * half, ROYAL.corner);
    fill(x - half + 1, y, z - half, x + half - 1, y, z - half, ROYAL.edge);
    fill(x - half + 1, y, z + half, x + half - 1, y, z + half, ROYAL.edge);
    fill(x - half, y, z - half + 1, x - half, y, z + half - 1, ROYAL.edge);
    fill(x + half, y, z - half + 1, x + half, y, z + half - 1, ROYAL.edge);

    // The ring, on the floor's own layer.
    for (let dx = -radius; dx <= radius; dx += 1)
        for (let dz = -radius; dz <= radius; dz += 1)
            if (Math.abs(Math.hypot(dx, dz) - radius) <= 0.5) one(x + dx, y, z + dz, ROYAL.ring);

    const start = half + courtStart();

    // Stands down the east and west sides: three tiers of seats looking in,
    // a wall behind them.
    for (const side of [1, -1] as const) {
        const facing = side === 1 ? "east" : "west";
        for (let tier = 0; tier < 3; tier += 1) {
            const sx = x + side * (start + tier);
            if (tier > 0)
                fill(
                    sx,
                    y - 1,
                    z - half,
                    sx,
                    y - 1 + tier - 1,
                    z + half,
                    "minecraft:polished_blackstone_bricks"
                );
            fill(
                sx,
                y - 1 + tier,
                z - half,
                sx,
                y - 1 + tier,
                z + half,
                `minecraft:polished_blackstone_brick_stairs[facing=${facing}]`
            );
        }
        const back = x + side * (start + 3);
        fill(back, y - 1, z - half, back, y + 3, z + half, "minecraft:polished_blackstone_bricks");
        fill(
            back,
            y + 4,
            z - half,
            back,
            y + 4,
            z + half,
            "minecraft:polished_blackstone_brick_wall"
        );
    }

    // Four tall pillars where the stands' corners meet the court's.
    const far = start + 1;
    for (const [sx, sz] of corners) {
        const px = x + sx * far;
        const pz = z + sz * far;
        fill(px, y - 2, pz, px, y + 6, pz, "minecraft:polished_blackstone_bricks");
        one(px, y + 7, pz, "minecraft:gilded_blackstone");
    }

    // The entrance, north: a landing with a red carpet under an arch.
    const gate = z - start - 1;
    fill(x - 3, y - 1, gate - 1, x + 3, y - 1, gate + 1, "minecraft:polished_blackstone_bricks");
    for (const sx of [-3, 3])
        fill(x + sx, y, gate, x + sx, y + 4, gate, "minecraft:polished_blackstone_bricks");
    fill(x - 3, y + 5, gate, x + 3, y + 5, gate, "minecraft:polished_blackstone_bricks");
    one(x - 2, y + 4, gate, "minecraft:polished_blackstone_brick_stairs[facing=west,half=top]");
    one(x + 2, y + 4, gate, "minecraft:polished_blackstone_brick_stairs[facing=east,half=top]");
    fill(x - 3, y + 6, gate, x - 1, y + 6, gate, "minecraft:polished_blackstone_brick_wall");
    fill(x + 1, y + 6, gate, x + 3, y + 6, gate, "minecraft:polished_blackstone_brick_wall");
    one(x, y + 6, gate, "minecraft:gold_block");
    one(x, y + 7, gate, ROYAL.ring);

    // The throne, south: on a crimson dais, looking in, a jewel on its back.
    const dais = z + start + 1;
    fill(x - 3, y - 1, dais - 1, x + 3, y - 1, dais + 2, "minecraft:polished_blackstone_bricks");
    fill(x - 2, y, dais, x + 2, y, dais + 2, ROYAL.edge);
    one(x, y + 1, dais + 1, "minecraft:polished_blackstone_stairs[facing=south]");
    one(x - 1, y + 1, dais + 1, ROYAL.corner);
    one(x + 1, y + 1, dais + 1, ROYAL.corner);
    fill(x, y + 1, dais + 2, x, y + 3, dais + 2, "minecraft:gold_block");
    fill(x - 1, y + 1, dais + 2, x - 1, y + 2, dais + 2, ROYAL.edge);
    fill(x + 1, y + 1, dais + 2, x + 1, y + 2, dais + 2, ROYAL.edge);
    one(x - 1, y + 3, dais + 2, "minecraft:gold_block");
    one(x + 1, y + 3, dais + 2, "minecraft:gold_block");
    one(x, y + 4, dais + 2, ROYAL.ring);
    one(x - 3, y, dais, "minecraft:soul_campfire");
    one(x + 3, y, dais, "minecraft:soul_campfire");

    // The crown, floating over the middle of the ring well out of reach: a
    // band of gold set with froglight, eight points, a lantern on a chain.
    const band = y + 10;
    for (let dx = -2; dx <= 2; dx += 1)
        for (let dz = -2; dz <= 2; dz += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
            const jewel = Math.abs(dx) === 2 && Math.abs(dz) === 2;
            one(x + dx, band, z + dz, jewel ? ROYAL.ring : "minecraft:gold_block");
            if (dx === 0 || dz === 0 || jewel)
                one(x + dx, band + 1, z + dz, "minecraft:gold_block");
        }
    one(x, band, z, "minecraft:gold_block");
    one(x, band - 1, z, "minecraft:chain");

    // What hangs on, stands on or lies on all that: last.
    for (const [sx, sz] of corners) one(x + sx * half, y + 1, z + sz * half, ROYAL.top!);
    one(x, y + 1, z - half, `${ROYAL.middle}[rotation=0]`);
    one(x, y + 1, z + half, `${ROYAL.middle}[rotation=8]`);
    one(x - half, y + 1, z, `${ROYAL.middle}[rotation=12]`);
    one(x + half, y + 1, z, `${ROYAL.middle}[rotation=4]`);
    for (const side of [1, -1] as const) {
        const back = x + side * (start + 3);
        const facing = side === 1 ? "west" : "east";
        for (let t = -half + 2; t <= half - 2; t += 4) {
            one(back, y + 5, z + t, ROYAL.top!);
            one(back - side, y + 3, z + t, `minecraft:red_wall_banner[facing=${facing}]`);
        }
    }
    for (const [sx, sz] of corners) {
        const px = x + sx * far;
        const pz = z + sz * far;
        one(px, y + 8, pz, ROYAL.top!);
        one(px + sx, y + 4, pz, `minecraft:red_wall_banner[facing=${sx === 1 ? "east" : "west"}]`);
        one(
            px,
            y + 4,
            pz + sz,
            `minecraft:red_wall_banner[facing=${sz === 1 ? "south" : "north"}]`
        );
    }
    fill(x - 2, y, gate - 1, x + 2, y, gate + 1, "minecraft:red_carpet");
    one(x - 1, y + 4, gate, `${ROYAL.top}[hanging=true]`);
    one(x + 1, y + 4, gate, `${ROYAL.top}[hanging=true]`);
    for (const sx of [-3, 3]) {
        one(x + sx, y + 3, gate - 1, "minecraft:red_wall_banner[facing=north]");
        one(x + sx, y + 3, gate + 1, "minecraft:red_wall_banner[facing=south]");
    }
    one(x - 2, y + 1, dais + 2, `${ROYAL.middle}[rotation=8]`);
    one(x + 2, y + 1, dais + 2, `${ROYAL.middle}[rotation=8]`);
    for (const [sx, sz] of corners)
        one(x + sx * 2, band + 2, z + sz * 2, "minecraft:end_rod[facing=up]");
    one(x, band - 2, z, `${ROYAL.top}[hanging=true]`);
    // Light nobody sees or bumps into, over the floor: however the ring
    // shrinks and its froglight goes back to floor, no block of it is dark.
    for (let dx = 0; dx <= half - 1; dx += LIGHT_EVERY)
        for (let dz = 0; dz <= half - 1; dz += LIGHT_EVERY)
            for (const [sx, sz] of corners) {
                if ((dx === 0 && sx === -1) || (dz === 0 && sz === -1)) continue;
                one(x + sx * dx, y + LIGHT_OVER, z + sz * dz, "minecraft:light[level=15]");
            }
    return out;
}
/** What a bolt of the storm (`strikeLine`) can leave on the platform. */
export const FIRE = "minecraft:fire";
/** The layers over the floor the platform's box takes in, for that fire. */
export const OVER_FLOOR = 2;

/**
 * The platform's look, put in before its floor fills round it: its edge with
 * something at each corner, and the circle drawn a block wide where it ends,
 * on the floor's own layer - and what the look stands over its corners and
 * the middle of its sides, on the layer over it.
 */
export function platformDecor(
    place: Point,
    radius: number,
    look: Look = PLAIN
): { box: Box; block: string }[] {
    if (look === ROYAL) return royalPieces(place, radius);
    const half = radius + MARGIN;
    const { x, y, z } = place;
    const one = (bx: number, bz: number, block: string, by = y) => ({
        box: { x1: bx, y1: by, z1: bz, x2: bx, y2: by, z2: bz },
        block
    });
    const corners = [
        [x - half, z - half],
        [x + half, z - half],
        [x - half, z + half],
        [x + half, z + half]
    ] as const;
    const out: { box: Box; block: string }[] = [
        ...corners.map(([cx, cz]) => one(cx, cz, look.corner)),
        {
            box: { x1: x - half + 1, y1: y, z1: z - half, x2: x + half - 1, y2: y, z2: z - half },
            block: look.edge
        },
        {
            box: { x1: x - half + 1, y1: y, z1: z + half, x2: x + half - 1, y2: y, z2: z + half },
            block: look.edge
        },
        {
            box: { x1: x - half, y1: y, z1: z - half + 1, x2: x - half, y2: y, z2: z + half - 1 },
            block: look.edge
        },
        {
            box: { x1: x + half, y1: y, z1: z - half + 1, x2: x + half, y2: y, z2: z + half - 1 },
            block: look.edge
        }
    ];
    if (look.top) for (const [cx, cz] of corners) out.push(one(cx, cz, look.top, y + 1));
    // Looking in: 0 south, 4 west, 8 north, 12 east.
    if (look.middle)
        out.push(
            one(x, z - half, `${look.middle}[rotation=0]`, y + 1),
            one(x, z + half, `${look.middle}[rotation=8]`, y + 1),
            one(x - half, z, `${look.middle}[rotation=12]`, y + 1),
            one(x + half, z, `${look.middle}[rotation=4]`, y + 1)
        );
    // The ring: every block whose middle is within half a block of the circle.
    for (let dx = -radius; dx <= radius; dx += 1)
        for (let dz = -radius; dz <= radius; dz += 1) {
            const away = Math.hypot(dx, dz);
            if (Math.abs(away - radius) <= 0.5) out.push(one(x + dx, z + dz, look.ring));
        }
    return out;
}

/**
 * What hangs in the air over a platform in the king of the ring's own look,
 * each look: souls rising off the floor and ash drifting down - and, through
 * the end of a round that counts double, a heartbeat everybody on it hears.
 * `place` is the platform's floor.
 */
export function ambientLines(
    place: Point,
    radius: number,
    sprint: boolean,
    look: Look = DEATH
): string[] {
    const half = radius + MARGIN;
    const at = `${place.x + 0.5} ${place.y + 1.5} ${place.z + 0.5}`;
    const run = "execute in minecraft:overworld run";
    const lines = [
        `${run} particle minecraft:sculk_soul ${at} ${half / 2} 0.4 ${half / 2} 0.03 10 normal`,
        `${run} particle minecraft:ash ${place.x + 0.5} ${place.y + 5} ${place.z + 0.5} ${half} 2 ${half} 0 60 normal`
    ];
    // The court's crown and throne glitter.
    if (look === ROYAL) {
        const throne = place.z + half + courtStart() + 3;
        lines.push(
            `${run} particle minecraft:end_rod ${place.x + 0.5} ${place.y + 11} ${place.z + 0.5} 1.6 0.6 1.6 0.01 8 normal`,
            `${run} particle minecraft:wax_on ${place.x + 0.5} ${place.y + 3} ${throne + 0.5} 0.8 1 0.4 0 6 normal`
        );
    }
    if (sprint)
        lines.push(
            `${run} playsound minecraft:entity.warden.heartbeat ambient @a[tag=${IN_ARENA}] ${at} 2 1`
        );
    return lines;
}

/** Floor beyond the circle's edge, all round: room to be pushed out onto. */
export const MARGIN = 3;

/** Air over the platform proven empty before a block of it goes in. */
const HEADROOM = 4;

/** How far from the players its place is looked for. */
export const DISTANCE = 32;

/** How far over the highest thing under it the platform floats. */
export const LIFT = 20;

/** How many can play: as many as fit round the circle. */
export const MOST = 16;

/** How far past the floor somebody may be before they are brought back. */
const STRAY = 6;

/** How far under the circle somebody may fall before they are brought back. */
const DROP = 5;

/** A platform's one layer: a square round the circle, `MARGIN` past its edge. */
export function platformBox(place: Point, radius: number): Box {
    const half = radius + MARGIN;
    return {
        x1: place.x - half,
        y1: place.y,
        z1: place.z - half,
        x2: place.x + half,
        y2: place.y,
        z2: place.z + half
    };
}

/** The platform's layer and the air over it, proven empty before it is built. */
export function proofBox(place: Point, radius: number, look: Look = PLAIN): Box {
    if (look !== ROYAL) return { ...platformBox(place, radius), y2: place.y + HEADROOM };
    const reach = footprint(radius, look);
    return {
        x1: place.x - reach,
        y1: place.y - UNDERSIDE,
        z1: place.z - reach,
        x2: place.x + reach,
        y2: place.y + COURT_TOP,
        z2: place.z + reach
    };
}

/** How far from the middle a look's blocks reach, every way: the room the
 *  place for it is looked for in. */
export function footprint(radius: number, look: Look = PLAIN): number {
    return radius + MARGIN + (look === ROYAL ? COURT : 0);
}

/**
 * The room the hill is played in, on the ground or on its platform: the circle,
 * its margin and the air a few blocks over and under it. Nothing hostile comes
 * into it, and what is dropped there stays its thrower's.
 */
export function bounds(place: Point, radius: number): Box {
    const half = radius + MARGIN;
    return {
        x1: place.x - half,
        y1: place.y - DROP,
        z1: place.z - half,
        x2: place.x + half,
        y2: place.y + 8,
        z2: place.z + half
    };
}

/** The way to face from `from` to look at `to`: 0 is south, 90 west, in this game. */
function yawTowards(from: { x: number; z: number }, to: { x: number; z: number }): number {
    const degrees = (-Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
    return Math.round(degrees * 10) / 10;
}

/**
 * Where each player comes in: evenly round the circle, a block outside its edge,
 * facing the middle - everybody starts as far from it as everybody else.
 */
export function entrySpots(place: Point, radius: number, count: number): Spot[] {
    const ring = radius + 1;
    return Array.from({ length: Math.max(1, count) }, (_unused, index) => {
        const angle = (index / Math.max(1, count)) * Math.PI * 2;
        const x = place.x + Math.round(Math.cos(angle) * ring);
        const z = place.z + Math.round(Math.sin(angle) * ring);
        return { x, y: place.y, z, yaw: yawTowards({ x, z }, place) };
    });
}

/** How far inside the ring's edge everybody starts. */
export const START_MARGIN = 2;

/**
 * Where each player starts a round, "Go!" included: evenly round a circle
 * `START_MARGIN` inside the ring that is in force then - whole, in the middle -
 * facing the middle. Inside it, never on its edge: nobody starts a round out
 * of the ring, or one step from being out of it.
 */
export function startSpots(place: Point, radius: number, count: number): Spot[] {
    const ring = Math.max(0, radius - START_MARGIN);
    return Array.from({ length: Math.max(1, count) }, (_unused, index) => {
        const angle = (index / Math.max(1, count)) * Math.PI * 2;
        const x = place.x + Math.round(Math.cos(angle) * ring);
        const z = place.z + Math.round(Math.sin(angle) * ring);
        return { x, y: place.y, z, yaw: ring === 0 ? 0 : yawTowards({ x, z }, place) };
    });
}

/**
 * Into the hill at a spot: on the ground under the air over it where the server
 * can say where that is (1.19.4 and later), and at the circle's own height
 * otherwise. Tagged first, in adventure mode after.
 */
export function enterLines(name: string, spot: Spot, overGround: boolean): string[] {
    const tp = overGround
        ? `execute in minecraft:overworld positioned ${spot.x + 0.5} ${spot.y + 6} ${spot.z + 0.5} positioned over motion_blocking_no_leaves run tp ${name} ~ ~ ~ ${spot.yaw} 0`
        : `execute in minecraft:overworld run tp ${name} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} ${spot.yaw} 0`;
    return [`tag ${name} add ${IN_ARENA}`, tp, `gamemode adventure ${name}`];
}

/**
 * Whether somebody stands on the platform: over its floor, at the circle's own
 * height - a jump allowed - rather than still on the way in, or under it.
 */
export function onPlatform(
    at: { x: number; y: number; z: number },
    place: Point,
    radius: number
): boolean {
    const half = radius + MARGIN;
    return (
        at.y >= place.y - 0.5 &&
        at.y <= place.y + 1.5 &&
        at.x >= place.x - half &&
        at.x < place.x + half + 1 &&
        at.z >= place.z - half &&
        at.z < place.z + half + 1
    );
}

/** Who of `names` is not on the platform yet - not on, or not there. */
export function notArrived(
    names: readonly string[],
    where: readonly { name: string; x: number; y: number; z: number }[],
    place: Point,
    radius: number
): string[] {
    const here = new Map(where.map((one) => [one.name.toLowerCase(), one]));
    return names.filter((name) => {
        const at = here.get(name.toLowerCase());
        return !at || !onPlatform(at, place, radius);
    });
}

/** Knocked right off - into the sea, down a slope, far out: time to come back. */
export function strayed(
    at: { x: number; y: number; z: number },
    place: Point,
    radius: number
): boolean {
    const reach = radius + MARGIN + STRAY;
    return (
        at.y < place.y - DROP ||
        at.y > place.y + 40 ||
        Math.abs(at.x - (place.x + 0.5)) > reach ||
        Math.abs(at.z - (place.z + 0.5)) > reach
    );
}

/** Each entrant's health, kept by the game as it changes (`health` criterion). */
export const HEALTH_SCORE = HILL_HEALTH;

/** Health under which the hill stops wearing anybody down: three hearts. */
const DRAIN_FLOOR = 6;

/**
 * The hill wears down whoever is off it and mends whoever holds it, for a
 * moment past each look - and nobody can die of it:
 * - off the circle, Poison, and only while they have more than three hearts;
 * - in it, the Poison taken off again and Regeneration instead;
 * - Resistance IV, so a punch is a fifth of one and keeps its knockback;
 * - whoever is under the platform - knocked off - takes nothing from the drop
 *   (`catchLine`), and is brought back to the edge;
 * - the fire and the water kept off.
 */
export function protectLines(
    point?: { x: number; y: number; z: number },
    radius?: number
): string[] {
    const who = `@a[tag=${IN_ARENA}]`;
    const lines = [
        `effect give ${who} minecraft:resistance 10 3 true`,
        `effect give ${who} minecraft:fire_resistance 10 0 true`,
        `effect give ${who} minecraft:water_breathing 10 0 true`
    ];
    if (!point || radius === undefined) return lines;
    const inside = `execute in minecraft:overworld positioned ${point.x + 0.5} ${point.y} ${point.z + 0.5} as @a[tag=${IN_ARENA},distance=..${radius}]`;
    return [
        ...lines,
        `scoreboard objectives add ${HEALTH_SCORE} health`,
        `effect give @a[tag=${IN_ARENA},scores={${HEALTH_SCORE}=${DRAIN_FLOOR + 1}..}] minecraft:poison 3 1 true`,
        `${inside} run effect clear @s minecraft:poison`,
        `${inside} run effect give @s minecraft:regeneration 3 1 true`,
        catchLine(point, radius)
    ];
}

/**
 * Whoever has fallen under the platform lands unhurt: Resistance V while they
 * are under it. Never Slow Falling, which kept them in the air long enough for
 * the server's floating check to kick them (`stage.fallProof`).
 */
export function catchLine(point: { x: number; y: number; z: number }, radius: number): string {
    const reach = radius + MARGIN + 64;
    const under = `x=${point.x - reach},y=${point.y - 128},z=${point.z - reach},dx=${2 * reach},dy=127,dz=${2 * reach}`;
    return `execute in minecraft:overworld run effect give @a[tag=${IN_ARENA},${under}] minecraft:resistance 3 4 true`;
}
// ------------------------------------------------------------------ the ring

/**
 * With fists only the circle is a ring that does not stand still. Each round
 * starts with it whole and in the middle; then it shrinks a block at a time
 * and drifts over the platform, so nobody can hold it by standing in one spot,
 * and the end of every round (`SPRINT_SECONDS`) counts double. Between rounds
 * everybody is put back on their own spot round it and nothing counts for
 * `RING_PAUSE_SECONDS`.
 *
 * Where it is and how big is worked out from the run's id and the time since
 * "Go!" alone (`ringAt`): the same after a restart, and the same for whoever
 * asks.
 */

/** The smallest a ring ever gets, whoever plays: two blocks round the middle. */
export const LEAST_RADIUS = 2;

/** Ground each player is given in the smallest ring, in blocks. */
const ROOM_EACH = 3;

/** How often the ring takes a step, in seconds. */
export const MOVE_SECONDS = 4;

/** How far past its first edge the ring may drift: never off the platform's
 *  floor, which reaches `MARGIN` past it. */
const DRIFT = MARGIN - 1;

/** The end of every round that counts double, at most a third of it. */
export const SPRINT_SECONDS = 20;

/** The breath between rounds, everybody back on their spot. */
export const RING_PAUSE_SECONDS = 6;

/**
 * After "Go!" - and after each round's pause - the ring stays whole and still
 * this long before it first shrinks or moves: time to find your feet, never a
 * ring that closes as the round starts.
 */
export const GRACE_SECONDS = 5;

export const ROUNDS = { least: 1, most: 5 } as const;

/**
 * How small the ring may get for this many players: enough ground for each of
 * them (`ROOM_EACH` blocks), never under `LEAST_RADIUS`, never over the ring it
 * starts as. Two players fight over a ring of two; sixteen over one of four.
 */
export function leastRadius(radius: number, players: number): number {
    const room = Math.ceil(Math.sqrt((Math.max(1, players) * ROOM_EACH) / Math.PI));
    return Math.min(radius, Math.max(LEAST_RADIUS, room));
}

export interface RingSettings {
    /** The run's id, which draws where the ring goes. */
    readonly seed: string;
    /** The ring every round starts as. */
    readonly radius: number;
    /** Who was brought in: how small it may get. */
    readonly players: number;
    readonly rounds: number;
    readonly shrinks: boolean;
    readonly moves: boolean;
}

export interface Ring {
    /** From 1. */
    readonly round: number;
    /** Everybody back on their spot, nothing counted. */
    readonly pause: boolean;
    /** Counting double. */
    readonly sprint: boolean;
    /** Where its middle is, from the platform's middle. */
    readonly dx: number;
    readonly dz: number;
    readonly radius: number;
}

/** How long each round lasts, the pause before it included. */
export function roundMs(totalMs: number, rounds: number): number {
    return totalMs / Math.max(1, rounds);
}

/** The ring `elapsedMs` after "Go!", in a game `totalMs` long. */
export function ringAt(settings: RingSettings, totalMs: number, elapsedMs: number): Ring {
    const rounds = Math.max(1, settings.rounds);
    const length = roundMs(totalMs, rounds);
    const round = Math.min(rounds, Math.floor(Math.max(0, elapsedMs) / length) + 1);
    const into = Math.max(0, elapsedMs - (round - 1) * length);
    const pauseMs = round > 1 ? RING_PAUSE_SECONDS * 1000 : 0;
    const playMs = Math.max(1, length - pauseMs);
    const played = Math.max(0, into - pauseMs);
    const sprintMs = Math.min(SPRINT_SECONDS * 1000, playMs / 3);
    // Whole and still for the grace first; it then shrinks to its least by
    // the time the sprint starts, as it always did.
    const graceMs = Math.min(GRACE_SECONDS * 1000, (playMs - sprintMs) / 2);
    const shrinkMs = Math.max(1, playMs - sprintMs - graceMs);
    const moving = Math.max(0, played - graceMs);
    const least = settings.shrinks
        ? leastRadius(settings.radius, settings.players)
        : settings.radius;
    const steps = settings.radius - least;
    // A block at a time, the last one taken as the sprint starts.
    const radiusAt = (ms: number) =>
        steps <= 0
            ? settings.radius
            : settings.radius - Math.min(steps, Math.floor((ms * steps) / shrinkMs));
    const pause = into < pauseMs;
    let dx = 0;
    let dz = 0;
    if (settings.moves && !pause) {
        const random = seeded(`${settings.seed}-ring-${round}`);
        let target: { x: number; z: number } | null = null;
        const moves = Math.floor(moving / (MOVE_SECONDS * 1000));
        for (let step = 1; step <= moves; step += 1) {
            // The room to drift grows as the ring shrinks; it never shrinks.
            const room = settings.radius - radiusAt(step * MOVE_SECONDS * 1000) + DRIFT;
            if (
                !target ||
                (target.x === dx && target.z === dz) ||
                Math.hypot(target.x, target.z) > room
            )
                target = pointWithin(random, room);
            const ax = target.x - dx;
            const az = target.z - dz;
            if (ax !== 0 && Math.abs(ax) >= Math.abs(az)) dx += Math.sign(ax);
            else if (az !== 0) dz += Math.sign(az);
        }
    }
    return {
        round,
        pause,
        sprint: !pause && played >= graceMs + shrinkMs,
        dx,
        dz,
        radius: radiusAt(moving)
    };
}

/** A whole-block point no farther than `room` from the middle. */
function pointWithin(random: () => number, room: number): { x: number; z: number } {
    const angle = random() * Math.PI * 2;
    const far = random() * room;
    let x = Math.round(Math.cos(angle) * far);
    let z = Math.round(Math.sin(angle) * far);
    while (Math.hypot(x, z) > room) {
        if (Math.abs(x) >= Math.abs(z)) x -= Math.sign(x);
        else z -= Math.sign(z);
    }
    return { x, z };
}

/** The ring's middle: the platform's, moved by the ring's offset. */
export function ringCenter(place: Point, ring: Pick<Ring, "dx" | "dz">): Point {
    return { x: place.x + ring.dx, y: place.y, z: place.z + ring.dz };
}

/** Kept by the game: how many stand in the ring this look. */
export const INSIDE_SCORE = HILL_INSIDE;
const INSIDE_HOLDER = "#inside";

/** How many times the time counts for somebody alone in the ring. */
export const ALONE_TIMES = 3;

/**
 * Time in the ring, for everybody in it - and `ALONE_TIMES` as much for
 * somebody in it alone, so pushing the others out still pays. Counted inside
 * the game, in the same tick it is seen, in the same three lines however many
 * play. `seconds` is already doubled in a sprint.
 */
export function scoreLines(center: Point, radius: number, seconds: number): string[] {
    const inRing = `@a[tag=${IN_ARENA},distance=..${radius},gamemode=!spectator]`;
    const at = `in minecraft:overworld positioned ${center.x + 0.5} ${center.y} ${center.z + 0.5}`;
    return [
        `scoreboard objectives add ${INSIDE_SCORE} dummy`,
        `execute ${at} store result score ${INSIDE_HOLDER} ${INSIDE_SCORE} if entity ${inRing}`,
        `execute ${at} as ${inRing} run scoreboard players add @s ${SCORE} ${seconds}`,
        `execute if score ${INSIDE_HOLDER} ${INSIDE_SCORE} matches 1 ${at} as ${inRing} run scoreboard players add @s ${SCORE} ${seconds * (ALONE_TIMES - 1)}`
    ];
}

/** Every block of the drawn ring: those whose middle is within half a block of its edge. */
export function ringBlocks(center: Point, radius: number): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    for (let dx = -radius; dx <= radius; dx += 1)
        for (let dz = -radius; dz <= radius; dz += 1)
            if (Math.abs(Math.hypot(dx, dz) - radius) <= 0.5)
                out.push({ x: center.x + dx, z: center.z + dz });
    return out;
}

/**
 * The ring drawn again on the platform's floor where it is now: the old one
 * painted over in the floor's own block, the new one painted only onto that
 * block - nothing but the platform's own floor is ever touched. `floor` is
 * the platform's own layer, `radius` the ring it was built round.
 */
export function redrawLines(
    floor: Point,
    radius: number,
    center: Point,
    ringRadius: number,
    look: Look = PLAIN
): string[] {
    const box = platformBox(floor, radius);
    const area = `${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2}`;
    return [
        `execute in minecraft:overworld run fill ${area} ${look.floor} replace ${look.ring}`,
        ...ringBlocks(center, ringRadius).map(
            (one) =>
                `execute in minecraft:overworld run fill ${one.x} ${floor.y} ${one.z} ${one.x} ${floor.y} ${one.z} ${look.ring} replace ${look.floor}`
        )
    ];
}

/** The crown the one ahead wears, marked as the event's so it is taken back. */
export const CROWN = "minecraft:golden_helmet";

/** Who is ahead: the most time, alone at the top; nobody on a tie or at nothing. */
export function leaderOf(points: Readonly<Record<string, number>>): string | null {
    let best: string | null = null;
    let most = 0;
    let tied = false;
    for (const [name, score] of Object.entries(points)) {
        if (score > most) {
            best = name;
            most = score;
            tied = false;
        } else if (score === most && score > 0) tied = true;
    }
    return tied ? null : best;
}

// ------------------------------------------------------------------ the blows

/**
 * The more blows somebody has taken, the further the next one throws them -
 * the fighting games' damage percent. Every fighter hits harder than a bare
 * fist (`ATTACK_KNOCKBACK`), and every fighter starts heavy
 * (`FRESH_RESISTANCE`), so a first punch lands about as a plain one does; each
 * blow taken takes some of that weight away, all of it by `MOST_HITS`, when a
 * punch throws nearly three times as far. Thrown off the platform, or a new
 * round, and they start heavy again.
 *
 * The game's own attributes, set as bases: knockback resistance on whoever is
 * hit, attack knockback on whoever hits - which counts for a player's punch
 * only from 1.21 (`KNOCKBACK_SINCE`); before it the ring plays as it always
 * did. Both names of each, because 1.21.2 dropped the `generic.` prefix; the
 * one a release does not know only answers with an error. A player's base of
 * both is 0, which is what they are set back to on the way home.
 */
export const KNOCKBACK_SINCE = [1, 21] as const;
export const ATTACK_KNOCKBACK = 1.5;
export const FRESH_RESISTANCE = 0.6;
export const MOST_HITS = 10;

const RESISTANCE = ["minecraft:knockback_resistance", "minecraft:generic.knockback_resistance"];
const ATTACK = ["minecraft:attack_knockback", "minecraft:generic.attack_knockback"];

const baseSet = (name: string, attributes: readonly string[], value: number) =>
    attributes.map((attribute) => `attribute ${name} ${attribute} base set ${value}`);

/** How heavy somebody is after this many blows: from `FRESH_RESISTANCE` down to none. */
export function resistanceAfter(hits: number): number {
    const taken = Math.min(MOST_HITS, Math.max(0, Math.floor(hits)));
    return Math.round(FRESH_RESISTANCE * (1 - taken / MOST_HITS) * 1000) / 1000;
}

/** How much further than the first a blow throws them now, in percent. */
export function knockbackPercent(hits: number): number {
    return Math.round(((1 - resistanceAfter(hits)) / (1 - FRESH_RESISTANCE) - 1) * 100);
}

/** Their weight for the blows they have taken. */
export function knockbackLines(name: string, hits: number): string[] {
    return baseSet(name, RESISTANCE, resistanceAfter(hits));
}

/** Into the fight: a harder punch, and the weight of somebody not hit yet. */
export function fighterLines(name: string): string[] {
    return [...baseSet(name, ATTACK, ATTACK_KNOCKBACK), ...knockbackLines(name, 0)];
}

/** On the way home: both back to a player's own. */
export function knockbackOff(name: string): string[] {
    return [...baseSet(name, ATTACK, 0), ...baseSet(name, RESISTANCE, 0)];
}

// ------------------------------------------------------------------ the storm

/**
 * Lightning hunts whoever is outside the ring: now and then a bolt comes down
 * on one of them, picked by the game itself. Only on somebody with four hearts
 * or more (`STRIKE_FLOOR`): under Resistance IV a bolt takes half a heart, the
 * fire it lights cannot burn them, and nobody is ever struck down. Never during
 * the pause between rounds.
 */
export const STRIKE_CHANCE = 0.35;
const STRIKE_FLOOR = DRAIN_FLOOR + 2;

export function strikeLine(
    place: Point,
    radius: number,
    center: Point,
    ringRadius: number
): string {
    const outside = `@a[tag=${IN_ARENA},distance=${ringRadius + 1.5}..,scores={${HEALTH_SCORE}=${STRIKE_FLOOR}..},sort=random,limit=1]`;
    const box = platformBox(place, radius);
    const over = `@s[x=${box.x1},y=${place.y},z=${box.z1},dx=${box.x2 - box.x1},dy=${OVER_FLOOR},dz=${box.z2 - box.z1}]`;
    return `execute in minecraft:overworld positioned ${center.x + 0.5} ${center.y} ${center.z + 0.5} as ${outside} at @s if entity ${over} run summon minecraft:lightning_bolt ~ ~ ~`;
}

/**
 * What the lightning lit on the platform put out: only fire, only in the two
 * layers over the floor. Each look, and again with the platform at the end.
 */
export function fireOut(floor: Point, radius: number): string {
    const box = platformBox(floor, radius);
    return `execute in minecraft:overworld run fill ${box.x1} ${box.y1 + 1} ${box.z1} ${box.x2} ${box.y1 + OVER_FLOOR} ${box.z2} minecraft:air replace ${FIRE}`;
}

/**
 * The ring's own sky: the air round the platform turned into a soul sand
 * valley - its blue fog, its drifting ash, no rain - from 1.19.4, where the
 * game sends a biome changed by `fillbiome` to whoever is there.
 *
 * Only cells of the one biome found at the platform are changed, and the
 * arena records it before they are, so its teardown changes exactly those
 * back (`arena.teardown`). A biome this list does not know - a mod's - is
 * left alone, and the ring plays in its own sky.
 */
export const BIOME_SINCE = [1, 19, 4] as const;
export const DEATH_BIOME = "minecraft:soul_sand_valley";

export const OVERWORLD_BIOMES = [
    "ocean",
    "deep_ocean",
    "warm_ocean",
    "lukewarm_ocean",
    "deep_lukewarm_ocean",
    "cold_ocean",
    "deep_cold_ocean",
    "frozen_ocean",
    "deep_frozen_ocean",
    "plains",
    "sunflower_plains",
    "snowy_plains",
    "ice_spikes",
    "desert",
    "swamp",
    "mangrove_swamp",
    "forest",
    "flower_forest",
    "birch_forest",
    "dark_forest",
    "old_growth_birch_forest",
    "old_growth_pine_taiga",
    "old_growth_spruce_taiga",
    "taiga",
    "snowy_taiga",
    "savanna",
    "savanna_plateau",
    "windswept_hills",
    "windswept_gravelly_hills",
    "windswept_forest",
    "windswept_savanna",
    "jungle",
    "sparse_jungle",
    "bamboo_jungle",
    "badlands",
    "eroded_badlands",
    "wooded_badlands",
    "meadow",
    "cherry_grove",
    "grove",
    "snowy_slopes",
    "frozen_peaks",
    "jagged_peaks",
    "stony_peaks",
    "river",
    "frozen_river",
    "beach",
    "snowy_beach",
    "stony_shore",
    "mushroom_fields",
    "pale_garden"
].map((name) => `minecraft:${name}`);

/** Whether the platform's air is in this biome. */
export function biomeTest(place: Point, biome: string): string {
    return `execute in minecraft:overworld if biome ${place.x} ${place.y + 2} ${place.z} ${biome}`;
}
