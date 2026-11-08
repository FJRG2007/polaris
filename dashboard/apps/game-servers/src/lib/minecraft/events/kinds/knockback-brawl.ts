/**
 * Knockback brawl: everybody on one platform in the sky with a stick that
 * pushes hard, and the last one left on it wins.
 *
 * The platform is an octagon of quartz round a gold heart with a red rim that
 * says where the edge is, sized for who joined. Every entrant is handed the
 * same stick, named and enchanted with Knockback at the event's level - up to
 * 255, which sends whoever it touches out of sight. Nobody is ever hurt badly
 * enough to die (`PLAY_EFFECTS`): only falling puts a player out, so whoever
 * pushed them off within the last few seconds is credited with a knock-off.
 *
 * Out is out, as in SkyWars and Pillars (`last-standing-service.ts`): under
 * the platform or past the play area, and up to the gallery over it. At the
 * time the ones still standing share the top and the knock-offs break the tie.
 *
 * Pure; the loop is `knockback-brawl-service.ts`.
 */

import { z } from "zod";
import * as arena from "./arena";
import type { Spot } from "./arena";
import * as decor from "./arena-decor";
import { asciiJson } from "../commands";
import type { Fill } from "./arena-game";
import type { Box, Marker } from "../state";

/** The layout's version, written into the run when it is built. */
export const DESIGN = 1;
/** How many can play on one platform. */
export const MOST = 24;
/** The platform's half width for the fewest and the most players. */
const LEAST_HALF = 7;
const MOST_HALF = 14;
/** How far the octagon's corners are cut. */
const CUT = 2;
/** How far over the ground the platform stands, at the least. */
export const HEIGHT = 30;
/** Room past the platform's edge that is still the play area, and under and
 *  over it. Under the platform by `BELOW` is out. */
const PAD = 4;
const BELOW = 3;
const ABOVE = 8;
/** Room past the play area to the box's wall (`sky-wars.MARGIN`). */
export const MARGIN = 12;
const GALLERY_LIFT = 3;
const GALLERY_HALF = 3;

const BARRIER = "minecraft:barrier";
/** Every block here is one every release since 1.13 knows. */
export const FLOOR = "minecraft:quartz_block";
export const RIM = "minecraft:red_concrete";
export const HEART = "minecraft:gold_block";

/** The stick and what it is enchanted with. */
export const STICK = "minecraft:stick";
export const KNOCKBACK = "minecraft:knockback";
export const KIT_IDS: readonly string[] = [STICK];

/** The level the editor offers by default, and the most the game reads. */
export const DEFAULT_KNOCKBACK = 5;
export const MOST_KNOCKBACK = 255;

/** Everybody in the game, standing or out. */
export const IN_TAG = "pe_kb_in";
/** Who is out carries this, so the quick look leaves them be. */
export const OUT_TAG = "pe_kb_out";
/** Who the quick look found past the play area, for the tick to put out. */
export const GONE_TAG = "pe_kb_gone";

/** Whoever is still standing. */
export const STANDING = `@a[tag=${IN_TAG},tag=!${OUT_TAG}]`;

/** Kept on everybody standing, every tick: a stick does one point a blow and
 *  this heals faster than anybody can strike, so a blow pushes and never
 *  kills. Hurt is still counted, which is how a knock-off is credited. */
export const PLAY_EFFECTS: readonly string[] = [
    `effect give ${STANDING} minecraft:regeneration 3 5 true`,
    `effect give ${STANDING} minecraft:saturation 3 0 true`
];

export const STOP_LINES: readonly string[] = [
    `tag @a remove ${IN_TAG}`,
    `tag @a remove ${OUT_TAG}`,
    `tag @a remove ${GONE_TAG}`
];

// ------------------------------------------------------------------ the stick

/** How a version writes an item's name (`boss.NameSpelling`): an SNBT text
 *  component from 1.21.5, JSON in a string from 1.20.5, a tag before. */
export type NameSpelling = "text" | "json" | "tag";

/** The spelling a server is written to: a tag wherever the kit is marked by
 *  one, whatever the version was read as. */
export function spellingFor(marker: Marker, spelling: NameSpelling): NameSpelling {
    if (marker === "tag") return "tag";
    return spelling === "text" ? "text" : "json";
}

/** The level asked for, kept to what the game reads. */
export function levelOf(level: number): number {
    return Math.max(1, Math.min(MOST_KNOCKBACK, Math.round(level)));
}

/**
 * The stick as the event hands it out: marked as the kit, named, and with
 * Knockback at `level` - with `levels` in components up to 1.21.4, as a plain
 * map from 1.21.5, an `Enchantments` tag before 1.20.5.
 */
export function stickItem(
    marker: Marker,
    spelling: NameSpelling,
    name: string,
    level: number
): string {
    const lvl = levelOf(level);
    const json = asciiJson(JSON.stringify({ text: name, color: "gold", italic: false }));
    const quoted = `'${json.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    const base = arena.marked(STICK, marker);
    const extra =
        spelling === "tag" || marker === "tag"
            ? `display:{Name:${quoted}},Enchantments:[{id:"${KNOCKBACK}",lvl:${lvl}s}]`
            : spelling === "text"
              ? `minecraft:custom_name={text:${asciiJson(JSON.stringify(name))},color:"gold",italic:0b},minecraft:enchantments={"${KNOCKBACK}":${lvl}}`
              : `minecraft:custom_name=${quoted},minecraft:enchantments={levels:{"${KNOCKBACK}":${lvl}}}`;
    return `${base.slice(0, -1)},${extra}${base.slice(-1)}`;
}

/** Whoever is standing and holds no stick of the event's. */
function without(marker: Marker): string {
    const held = `{id:"${STICK}",${arena.markedItem(marker).slice(1)}`;
    return `@a[tag=${IN_TAG},tag=!${OUT_TAG},nbt=!{Inventory:[${held}]}]`;
}

/**
 * The stick for everybody standing who has none, in one line for them all:
 * the version's own spelling, then the other component spelling for a version
 * read wrong - refused by the version that does not read it, and given to
 * nobody who already got the first. Sent at "Go!" and every tick after, so a
 * stick thrown away comes back.
 */
export function stickLines(
    marker: Marker,
    spelling: NameSpelling,
    name: string,
    level: number
): string[] {
    const own = spellingFor(marker, spelling);
    const lines = [`give ${without(marker)} ${stickItem(marker, own, name, level)} 1`];
    if (own !== "tag")
        lines.push(
            `give ${without(marker)} ${stickItem(marker, own === "text" ? "json" : "text", name, level)} 1`
        );
    return lines;
}

// ------------------------------------------------------------------ the platform

export interface Layout {
    /** Blocks from the middle to the rim, along an axis. */
    readonly half: number;
    /** Where each player starts, from the middle. */
    readonly starts: readonly { x: number; z: number }[];
}

export function layoutFor(players: number): Layout {
    const count = Math.max(2, Math.min(MOST, players));
    const half = Math.max(LEAST_HALF, Math.min(MOST_HALF, 5 + Math.ceil(count / 2)));
    const ring = half - 3;
    const starts = Array.from({ length: count }, (_, index) => {
        const angle = (2 * Math.PI * index) / count;
        return { x: Math.round(Math.sin(angle) * ring), z: Math.round(-Math.cos(angle) * ring) };
    });
    return { half, starts };
}

/** Where the platform stands: its middle, at its floor. */
export interface Placed {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** The platform's floor over the ground found. */
export function topOver(ground: number): number {
    return ground + Math.max(HEIGHT, BELOW + MARGIN + 2);
}

export function playArea(layout: Layout, at: Placed): Box {
    const reach = layout.half + PAD;
    return {
        x1: at.x - reach,
        y1: at.y - BELOW,
        z1: at.z - reach,
        x2: at.x + reach,
        y2: at.y + ABOVE,
        z2: at.z + reach
    };
}

export function galleryFloor(layout: Layout, at: Placed): Box {
    const y = playArea(layout, at).y2 + GALLERY_LIFT;
    return {
        x1: at.x - GALLERY_HALF,
        y1: y,
        z1: at.z - GALLERY_HALF,
        x2: at.x + GALLERY_HALF,
        y2: y,
        z2: at.z + GALLERY_HALF
    };
}

export function arenaBox(layout: Layout, at: Placed): Box {
    const play = playArea(layout, at);
    const gallery = galleryFloor(layout, at);
    return {
        x1: play.x1 - MARGIN,
        y1: play.y1 - MARGIN,
        z1: play.z1 - MARGIN,
        x2: play.x2 + MARGIN,
        y2: Math.max(play.y2 + MARGIN, gallery.y1 + 4),
        z2: play.z2 + MARGIN
    };
}

export function reachOf(layout: Layout): number {
    return layout.half + PAD + MARGIN;
}

/** An octagon at `y` as two crossed rectangles, `half` from the middle. */
function octagon(at: Placed, half: number, block: string): Fill[] {
    const cut = half - CUT;
    return [
        {
            box: {
                x1: at.x - half,
                y1: at.y,
                z1: at.z - cut,
                x2: at.x + half,
                y2: at.y,
                z2: at.z + cut
            },
            block
        },
        {
            box: {
                x1: at.x - cut,
                y1: at.y,
                z1: at.z - half,
                x2: at.x + cut,
                y2: at.y,
                z2: at.z + half
            },
            block
        }
    ];
}

/**
 * The barrier floor at the box's bottom, so whatever falls stays inside it and
 * comes down with the arena; the gallery; the gold heart, the quartz floor,
 * then the rim round it - each only into air, so the rim is what the floor
 * left. The rim's last piece starts on its edge, the block whose being there
 * proves the build went in (`arena-service.raise`).
 */
export function arenaFills(layout: Layout, at: Placed): Fill[] {
    const box = arenaBox(layout, at);
    return [
        { box: { ...box, y2: box.y1 }, block: BARRIER },
        { box: galleryFloor(layout, at), block: BARRIER },
        {
            box: { x1: at.x - 1, y1: at.y, z1: at.z - 1, x2: at.x + 1, y2: at.y, z2: at.z + 1 },
            block: HEART
        },
        ...octagon(at, layout.half - 1, FLOOR),
        ...octagon(at, layout.half, RIM)
    ];
}

/** Every block kind the box can hold while it stands, as bare ids. */
export const ARENA_BLOCKS: readonly string[] = [HEART, FLOOR, RIM, BARRIER];

/** Where a player starts: on the floor, facing the middle. */
export function startSpot(layout: Layout, at: Placed, index: number): Spot {
    const start = layout.starts[index % layout.starts.length]!;
    const yaw = Math.round((-Math.atan2(-start.x, -start.z) * 180) / Math.PI);
    return { x: at.x + start.x, y: at.y + 1, z: at.z + start.z, yaw };
}

export function gallerySpot(layout: Layout, at: Placed, index: number): Spot {
    const floor = galleryFloor(layout, at);
    const side = floor.x2 - floor.x1 + 1;
    return {
        x: floor.x1 + (index % side),
        y: floor.y1 + 1,
        z: floor.z1 + (Math.floor(index / side) % side),
        yaw: 0,
        pitch: 60
    };
}

export function decorSpots(layout: Layout, at: Placed): decor.Spot[] {
    const gallery = galleryFloor(layout, at);
    return decor
        .corners(gallery.x1 - 1, gallery.z1 - 1, gallery.x2 + 1, gallery.z2 + 1, gallery.y1 + 4)
        .map((one): decor.Spot => ({ ...one, kind: "stand" }));
}

/**
 * Between ticks, nothing read: whoever crossed the play area's edge - under
 * the platform, past a side, over the top - taken up to the gallery at once
 * and marked for the tick. First the tag taken from anybody who carries it and
 * is not playing (`names`): one who left, or was offline when the last game
 * ended, is never moved.
 */
export function quickLines(
    layout: Layout,
    at: Placed,
    box: Box,
    names: readonly string[]
): string[] {
    const play = playArea(layout, at);
    const who = `tag=${IN_TAG},tag=!${OUT_TAG}`;
    const far = 64;
    const volume = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) =>
        `x=${x1},y=${y1},z=${z1},dx=${x2 - x1},dy=${y2 - y1},dz=${z2 - z1}`;
    const outside = [
        volume(
            box.x1 - far,
            box.y1 - far * 2,
            box.z1 - far,
            box.x2 + far,
            play.y1 - 1,
            box.z2 + far
        ),
        volume(box.x1 - far, play.y1, box.z1 - far, play.x1 - 1, box.y2 + far, box.z2 + far),
        volume(play.x2 + 1, play.y1, box.z1 - far, box.x2 + far, box.y2 + far, box.z2 + far),
        volume(play.x1, play.y1, box.z1 - far, play.x2, box.y2 + far, play.z1 - 1),
        volume(play.x1, play.y1, play.z2 + 1, play.x2, box.y2 + far, box.z2 + far),
        volume(play.x1, play.y2 + 1, play.z1, play.x2, box.y2 + far, play.z2)
    ];
    const seat = gallerySpot(layout, at, 0);
    const others = names.map((name) => `,name=!${name}`).join("");
    return [
        `tag @a[tag=${IN_TAG}${others}] remove ${IN_TAG}`,
        ...outside.map(
            (one) => `execute in minecraft:overworld run tag @a[${who},${one}] add ${GONE_TAG}`
        ),
        `execute in minecraft:overworld run tp @a[${who},tag=${GONE_TAG}] ${seat.x + 0.5} ${seat.y} ${seat.z + 0.5}`
    ];
}

// ------------------------------------------------------------------ the state

const outSchema = z.object({
    name: z.string(),
    at: z.number(),
    why: z.enum(["fell", "left", "died", "gone"])
});

export const stateSchema = z.object({
    design: z.number().int().default(DESIGN),
    /** How this server writes an item's name, asked before it was built. */
    spelling: z.enum(["text", "json", "tag"]).default("json"),
    out: z.array(outSchema).default([]),
    /** Knock-offs, by whoever pushed. */
    kills: z.record(z.number().int()).default({})
});
export type BrawlState = z.infer<typeof stateSchema>;

export function stateOf(game: unknown): BrawlState {
    const parsed = stateSchema.safeParse(game ?? {});
    return parsed.success ? parsed.data : stateSchema.parse({});
}

/** Who is still standing, of everybody who entered. */
export function standing(state: BrawlState, names: readonly string[]): string[] {
    const out = new Set(state.out.map((one) => one.name.toLowerCase()));
    return names.filter((name) => !out.has(name.toLowerCase()));
}

/**
 * Who wins: the last one standing; at the time, of those still standing, the
 * one with the most knock-offs - nobody on a tie, which the podium settles.
 */
export function winnerOf(state: BrawlState, names: readonly string[]): string | null {
    const left = standing(state, names);
    if (left.length === 1) return left[0]!;
    if (left.length === 0) return null;
    const best = Math.max(...left.map((name) => state.kills[name] ?? 0));
    const top = left.filter((name) => (state.kills[name] ?? 0) === best);
    return top.length === 1 ? top[0]! : null;
}
