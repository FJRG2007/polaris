/**
 * A build battle's commands: the plots, the kit, the theme and the vote.
 *
 * The plots are cells of one platform in the air, side by side: a barrier floor
 * under a glass one, barrier walls between them and a barrier roof over them,
 * so each builder reaches their own plot and nothing else.
 *
 * What guarantees nothing of anybody's is used, lost or left behind is the kit
 * and adventure mode together. A builder plays in adventure mode, where no block
 * can be placed unless the item says what it may be placed on, and none broken
 * unless the tool says what it may break. The kit's glass may be placed only on
 * the plot's floor and on the kit's own glass; the kit's brush may break only
 * the kit's glass. A player's own blocks say nothing of the kind, so they cannot
 * be put down at all - there is nothing of theirs on a plot to lose when it is
 * taken down. And glass broken by hand drops nothing, so the kit cannot leave
 * the plot as loose blocks either.
 *
 * Pure; the loop is `arena-service.ts`.
 */

import * as speech from "../../speech";
import type { Box } from "../state";
import type { Marker } from "../state";
import { giveMarked, type Spot } from "./arena";
import { seeded, shuffled } from "../trivia-bank";
import type { EventOptions, Language } from "../catalog";

/** The floor of every plot. Not in the kit, so it cannot be broken. */
export const FLOOR = "minecraft:white_stained_glass";

const COLOURS = [
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black"
];

/**
 * What there is to build with: one material per round, drawn from these, each
 * in every color it comes in. Every id has been in the game since 1.13, which
 * every version events run on is past (`quartz_bricks` since 1.16, which the
 * quartz set carries as one block among several, so an older server loses
 * that one only).
 */
export const PALETTES = {
    glass: {
        name: { en: "Glass", es: "Cristal" },
        blocks: ["minecraft:glass", ...COLOURS.map((color) => `minecraft:${color}_stained_glass`)]
    },
    wool: {
        name: { en: "Wool", es: "Lana" },
        blocks: ["white", ...COLOURS].map((color) => `minecraft:${color}_wool`)
    },
    concrete: {
        name: { en: "Concrete", es: "Hormigón" },
        blocks: ["white", ...COLOURS].map((color) => `minecraft:${color}_concrete`)
    },
    terracotta: {
        name: { en: "Terracotta", es: "Terracota" },
        blocks: [
            "minecraft:terracotta",
            ...["white", ...COLOURS].map((color) => `minecraft:${color}_terracotta`)
        ]
    },
    quartz: {
        name: { en: "Quartz and glass", es: "Cuarzo y cristal" },
        blocks: [
            "minecraft:quartz_block",
            "minecraft:chiseled_quartz_block",
            "minecraft:quartz_pillar",
            "minecraft:smooth_quartz",
            "minecraft:quartz_bricks",
            "minecraft:quartz_stairs",
            "minecraft:quartz_slab",
            "minecraft:glass",
            "minecraft:glass_pane",
            "minecraft:sea_lantern",
            ...COLOURS.slice(0, 8).map((color) => `minecraft:${color}_stained_glass`)
        ]
    }
} as const satisfies Record<
    string,
    { name: Readonly<Record<Language, string>>; blocks: readonly string[] }
>;

export type Palette = keyof typeof PALETTES;

/** The material of one run - the same for the same run, so a restart does not
 *  change it. */
export function paletteFor(runId: string): Palette {
    const names = Object.keys(PALETTES) as Palette[];
    return shuffled(names, seeded(`${runId}-palette`))[0] as Palette;
}

/** The glass set: what a run from before materials were drawn built with. */
export const KIT_BLOCKS: readonly string[] = PALETTES.glass.blocks;

/** Every block any material has, for what is taken back and cleared. */
const ALL_KIT_BLOCKS = [...new Set(Object.values(PALETTES).flatMap((one) => one.blocks))];

/** The brush: breaks the kit's blocks, and only them. */
export const TOOL = "minecraft:stick";

/** Every item a kit can be, for taking it back. */
export const KIT_IDS = [...ALL_KIT_BLOCKS, TOOL];

/** The frame round the plots: no material's kit has either, so no brush breaks them. */
const CURB = "minecraft:polished_andesite";
const LIGHT = "minecraft:glowstone";

/** Every kind of block that is ever on the platform. */
export const PLATFORM_BLOCKS = ["minecraft:barrier", FLOOR, CURB, LIGHT, ...ALL_KIT_BLOCKS];

/** How many plots one platform has at most. */
export const MAX_PLOTS = 12;

/** How many of each block a builder gets. */
const STACK = 64;

/** Plots in rows, as square as it goes. */
export function grid(count: number): { cols: number; rows: number } {
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    return { cols, rows: Math.max(1, Math.ceil(count / cols)) };
}

/** From one plot's wall to the next. */
const pitch = (size: number) => size + 1;

export function platformBox(
    center: { x: number; z: number },
    floorY: number,
    count: number,
    size: number
): Box {
    const { cols, rows } = grid(count);
    const width = cols * pitch(size) + 1;
    const depth = rows * pitch(size) + 1;
    const x1 = center.x - Math.floor(width / 2);
    const z1 = center.z - Math.floor(depth / 2);
    return {
        x1,
        y1: floorY,
        z1,
        x2: x1 + width - 1,
        // Barrier, glass, `size` of air to build in, and the roof.
        y2: floorY + size + 2,
        z2: z1 + depth - 1
    };
}

/** How far from its center the ground under a platform is judged. */
export function platformReach(count: number, size: number): number {
    const { cols, rows } = grid(count);
    return Math.ceil((Math.max(cols, rows) * pitch(size) + 1) / 2);
}

/** A plot's floor, the glass layer it is built on. */
function plotFloorIn(box: Box, index: number, size: number, cols: number): Box {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x1 = box.x1 + col * pitch(size) + 1;
    const z1 = box.z1 + row * pitch(size) + 1;
    return { x1, y1: box.y1 + 1, z1, x2: x1 + size - 1, y2: box.y1 + 1, z2: z1 + size - 1 };
}

/**
 * What it is built with, each only into air: the barrier floor and roof, every
 * wall between plots, then the glass floor of each plot.
 */
export function platformFills(
    box: Box,
    count: number,
    size: number
): { box: Box; block: string }[] {
    const barrier = "minecraft:barrier";
    const { cols, rows } = grid(count);
    // Put in before the barrier, which then fills round them: at the plots'
    // floor level, a stone curb along every line between plots and a light
    // where two lines meet - what was an invisible wall reads as a frame.
    const lines = (z: boolean) =>
        Array.from({ length: (z ? rows : cols) + 1 }, (_, index) =>
            (z ? box.z1 : box.x1) + index * pitch(size)
        );
    const decor: { box: Box; block: string }[] = [];
    for (const x of lines(false))
        for (const z of lines(true))
            decor.push({ box: { x1: x, x2: x, z1: z, z2: z, y1: box.y1 + 1, y2: box.y1 + 1 }, block: LIGHT });
    for (const x of lines(false))
        decor.push({ box: { ...box, x1: x, x2: x, y1: box.y1 + 1, y2: box.y1 + 1 }, block: CURB });
    for (const z of lines(true))
        decor.push({ box: { ...box, z1: z, z2: z, y1: box.y1 + 1, y2: box.y1 + 1 }, block: CURB });
    const fills: { box: Box; block: string }[] = [
        ...decor,
        { box: { ...box, y2: box.y1 }, block: barrier },
        { box: { ...box, y1: box.y2 }, block: barrier }
    ];
    for (let col = 0; col <= cols; col += 1) {
        const x = box.x1 + col * pitch(size);
        fills.push({ box: { ...box, x1: x, x2: x }, block: barrier });
    }
    for (let row = 0; row <= rows; row += 1) {
        const z = box.z1 + row * pitch(size);
        fills.push({ box: { ...box, z1: z, z2: z }, block: barrier });
    }
    for (let index = 0; index < count; index += 1) {
        fills.push({ box: plotFloorIn(box, index, size, cols), block: FLOOR });
    }
    return fills;
}

/** Where a builder stands on their own plot: its middle. */
export function plotSpot(box: Box, index: number, size: number, count: number): Spot {
    const floor = plotFloorIn(box, index, size, grid(count).cols);
    return {
        x: floor.x1 + Math.floor(size / 2),
        y: floor.y1 + 1,
        z: floor.z1 + Math.floor(size / 2),
        yaw: 0
    };
}

/**
 * Where everybody can stand to look at a plot on the tour, best first: on the
 * platform's barrier roof - which nothing is built through, and which they see
 * through - over the wall beside the plot, looking down into it. Never on the
 * plot itself: a plot built solid to its roof had the tour spawn them inside it.
 */
export function plotViews(box: Box, index: number, size: number, count: number): Spot[] {
    const floor = plotFloorIn(box, index, size, grid(count).cols);
    const y = box.y2 + 1;
    const midX = floor.x1 + Math.floor(size / 2);
    const midZ = floor.z1 + Math.floor(size / 2);
    const pitch = 55;
    return [
        // North of it looking south, south looking north, west looking east, east looking west.
        { x: midX, y, z: floor.z1 - 1, yaw: 0, pitch },
        { x: midX, y, z: floor.z2 + 1, yaw: 180, pitch },
        { x: floor.x1 - 1, y, z: midZ, yaw: -90, pitch },
        { x: floor.x2 + 1, y, z: midZ, yaw: 90, pitch }
    ];
}

/** The platform with the room over its roof that the tour stands in. */
export function tourBounds(box: Box): Box {
    return { ...box, y2: box.y2 + 3 };
}

/** Whether a block is empty air: two of these, feet and head, clear a spot. */
export function airAt(spot: { x: number; y: number; z: number }, above = 0): string {
    return `execute in minecraft:overworld if block ${spot.x} ${spot.y + above} ${spot.z} minecraft:air`;
}

/** The kit for one builder: the brush that breaks only the kit's glass, then the
 *  glass, placeable only on the plot and on itself. The brush first, so it lands
 *  in the first free slot of the hotbar - handed out last, it went to the bag
 *  behind sixteen stacks of glass, or at the feet of anybody whose bag was full. */
export function kitCommands(name: string, marker: Marker, palette: Palette = "glass"): string[] {
    const blocks = PALETTES[palette].blocks;
    const placeOn = [FLOOR, ...blocks];
    return [
        giveMarked(name, TOOL, 1, marker, { breaks: blocks }),
        ...blocks.map((id) => giveMarked(name, id, STACK, marker, { placeOn }))
    ];
}

// ------------------------------------------------------------------ done early

/** How far into the building the [Done] button is offered: a minute, or a third
 *  of the building time when that is shorter. */
export function doneOfferAfter(buildMs: number): number {
    return Math.min(60_000, Math.floor(buildMs / 3));
}

/** A builder saying they are done, or taking it back - pressed or typed. */
export function readDone(said: string): "done" | "undo" | null {
    const word = said.trim().toLowerCase();
    if (word === "done" || word === "terminado") return "done";
    if (word === "undo" || word === "seguir") return "undo";
    return null;
}

/** Everybody still here is done: every builder on the server is in the list,
 *  and there is at least one. A builder who left does not hold it up. */
export function everybodyDone(
    builders: readonly string[],
    here: ReadonlySet<string>,
    done: readonly string[]
): boolean {
    const present = builders.filter((name) => here.has(name.toLowerCase()));
    const marked = new Set(done.map((name) => name.toLowerCase()));
    return present.length > 0 && present.every((name) => marked.has(name.toLowerCase()));
}

// ------------------------------------------------------------------ the vote

/** A plot's number, alone on the line: `3` or `#3`. */
export function readVote(said: string): number | null {
    const match = /^#?\s*(\d{1,2})$/.exec(said.trim());
    return match ? Number(match[1]) : null;
}

/** Votes counted by whose plot they went to. */
export function countVotes(votes: Readonly<Record<string, string>>): Map<string, number> {
    const counted = new Map<string, number>();
    for (const owner of Object.values(votes)) counted.set(owner, (counted.get(owner) ?? 0) + 1);
    return counted;
}

export type VoteOutcome = "counted" | "own" | "again" | "none";

/**
 * One vote read: for a plot that has a builder, not the voter's own, and only
 * the first from each voter. Votes are kept by the voter's name in lower case.
 */
export function castVote(
    votes: Readonly<Record<string, string>>,
    voter: string,
    plot: number,
    owners: ReadonlyMap<number, string>
): { outcome: VoteOutcome; votes: Record<string, string> } {
    const owner = owners.get(plot);
    const key = voter.toLowerCase();
    if (!owner) return { outcome: "none", votes: { ...votes } };
    if (owner.toLowerCase() === key) return { outcome: "own", votes: { ...votes } };
    if (votes[key] !== undefined) return { outcome: "again", votes: { ...votes } };
    return { outcome: "counted", votes: { ...votes, [key]: owner } };
}

/** How long everybody stands at each plot on the tour. */
export function tourStep(voteSeconds: number, plots: number): number {
    return Math.max(5, Math.floor(voteSeconds / Math.max(1, plots)));
}

// ------------------------------------------------------------------ the theme

/** Things that can be built in glass in a few minutes, in both languages. */
export const THEMES: readonly Readonly<Record<Language, string>>[] = [
    { en: "Castle", es: "Castillo" },
    { en: "Lighthouse", es: "Faro" },
    { en: "Tree house", es: "Casa del árbol" },
    { en: "Dragon", es: "Dragón" },
    { en: "Rocket", es: "Cohete" },
    { en: "Windmill", es: "Molino" },
    { en: "Pirate ship", es: "Barco pirata" },
    { en: "Volcano", es: "Volcán" },
    { en: "Robot", es: "Robot" },
    { en: "Giant flower", es: "Flor gigante" },
    { en: "Snowman", es: "Muñeco de nieve" },
    { en: "Fountain", es: "Fuente" },
    { en: "Rainbow", es: "Arcoíris" },
    { en: "Ice cream", es: "Helado" },
    { en: "Mushroom house", es: "Casa seta" },
    { en: "Bridge", es: "Puente" },
    { en: "Train", es: "Tren" },
    { en: "Hot air balloon", es: "Globo aerostático" },
    { en: "Aquarium", es: "Acuario" },
    { en: "Crown", es: "Corona" },
    { en: "Space station", es: "Estación espacial" },
    { en: "Butterfly", es: "Mariposa" },
    { en: "Birthday cake", es: "Tarta de cumpleaños" },
    { en: "Pyramid", es: "Pirámide" },
    { en: "Skyscraper", es: "Rascacielos" },
    { en: "Ghost", es: "Fantasma" },
    { en: "Sword in the stone", es: "Espada en la piedra" },
    { en: "Creeper", es: "Creeper" },
    { en: "Island", es: "Isla" },
    { en: "Clock tower", es: "Torre del reloj" }
];

/** The theme of one run: the operator's own, or one of the built-in ones -
 *  the same for the same run, so a restart does not change it. */
export function themeFor(
    options: EventOptions<"build-battle">,
    runId: string,
    language: speech.Speech
): string {
    const random = seeded(`${runId}-theme`);
    if (options.themeMode === "mine" && options.themes.length > 0) {
        return shuffled(options.themes, random)[0] as string;
    }
    return speech.pickIn(
        shuffled(THEMES, random)[0] as Readonly<Record<Language, string>>,
        language
    );
}
