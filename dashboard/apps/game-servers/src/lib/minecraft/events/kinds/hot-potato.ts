/**
 * Hot potato's platform and its rounds.
 *
 * A square platform in the air, sized to the crowd and walled in glass three
 * high so nobody is knocked off it, with cover on it to dodge round - hay
 * bales and lit posts, drawn from the run's id (`coverFor`) - and beside it - behind its north wall, a step up, roofed so
 * nobody can climb back in - the gallery whoever is out watches from. Nobody is
 * hurt: Resistance IV makes a punch a fifth of one, Regeneration mends it, and
 * the "explosion" is particles and a sound, never a block or an entity.
 *
 * Each round one player holds the potato - more than ten left, one more for
 * every ten (`potatoesFor`), never two on one head - drawn from the run's id
 * and the round, so a restart draws the same - and wears it: a marked TNT on their head
 * (only onto an empty one), glowing, told so on their screen. Everybody but
 * the holder is weakened past doing any harm, so a hit anybody takes from a
 * player is the holder's - read off the events data pack (`hits.ts`), which
 * sees every punch, and checked against who the game says hurt them where it
 * can (`hurtByHolder`); the one it was is the nearest of those hit
 * (`hitBy`), and the potato is theirs - not straight back: whoever was just
 * handed it cannot pass
 * it for `PASS_COOLDOWN_MS`, and a holder is never handed a second. When the
 * round's fuse runs out every holder is out and goes to the gallery; after a breath the next round starts with a new
 * holder. The last one left wins; everybody else is ranked by when they went
 * out.
 *
 * Pure; the loop is `hot-potato-service.ts`.
 */

import { z } from "zod";
import * as hits from "./hits";
import type { Box } from "../state";
import type { Spot } from "./arena";
import { seeded, shuffled } from "../trivia-bank";
import type { Fill } from "./arena-game";

/** How many can play. */
export const MOST = 24;

/** Players a potato is played among: past ten left, a second one, and so on. */
export const PER_POTATO = 10;

/** How many potatoes a round is played with, for `left` still in: one up to
 *  `PER_POTATO`, one more for every `PER_POTATO` past it - and always somebody
 *  without one to hand it to. */
export function potatoesFor(left: number): number {
    return Math.max(1, Math.min(left - 1, Math.ceil(left / PER_POTATO)));
}

/** The platform's half width: 6 (a 13 by 13 floor) up to six players, 8 up to
 *  twelve, 10 past. */
export function halfWidth(players: number): number {
    return players <= 6 ? 6 : players <= 12 ? 8 : 10;
}

/** How far from its center the ground under it is judged. */
export function reachOf(players: number): number {
    return halfWidth(players) + GALLERY_DEPTH + 2;
}

/** The gallery's depth, north of the platform's wall. */
const GALLERY_DEPTH = 3;
/** The walls' height over the floor: no jump, no knock clears it. */
const WALL = 3;

/** Seconds a player just handed the potato has before they can pass it on. */
export const PASS_COOLDOWN_MS = 2_000;
/** The breath between one round's bang and the next holder. */
export const ROUND_PAUSE_MS = 3_000;

/** The potato. */
export const POTATO = "minecraft:tnt";

/** What the game counts a hit by where the events data pack is not on: damage
 *  dealt, damage taken. */
export const DEALT = "pe_hpd";
export const TAKEN = "pe_hpt";
export const READ_DEALT = `execute as @a run scoreboard players get @s ${DEALT}`;
export const READ_TAKEN = `execute as @a run scoreboard players get @s ${TAKEN}`;

const BARRIER = "minecraft:barrier";
const GLASS = "minecraft:glass";
const RIM = "minecraft:polished_andesite";
const LIGHT = "minecraft:sea_lantern";
const STRIPES = ["minecraft:orange_terracotta", "minecraft:white_terracotta"] as const;
const GALLERY_FLOOR = "minecraft:spruce_planks";
/** Cover on the floor: a bale to hop on and duck behind, a lit post to circle. */
const BALE = "minecraft:hay_block";
const POST = "minecraft:stripped_spruce_log";
const POST_LIGHT = "minecraft:jack_o_lantern";

/** Every kind of block the platform is built of. */
export const PLATFORM_BLOCKS: readonly string[] = [
    BARRIER,
    GLASS,
    RIM,
    LIGHT,
    ...STRIPES,
    GALLERY_FLOOR,
    BALE,
    POST,
    POST_LIGHT
];

// ------------------------------------------------------------------ the run's own

const outSchema = z.object({
    name: z.string(),
    round: z.number().int(),
    /** When they went out: who went out at the same time ties. */
    at: z.number()
});

const holderSchema = z.object({
    name: z.string(),
    /** When it was handed to them: no passing straight back. */
    passedAt: z.number().default(0)
});
export type Holder = z.infer<typeof holderSchema>;

/** A run written while a round had only one potato: its `holder` and
 *  `passedAt`, read as the only holder. */
function legacyHolder(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const old = value as Record<string, unknown>;
    if (!("holder" in old) || "holders" in old) return value;
    const { holder, passedAt, ...rest } = old;
    return {
        ...rest,
        holders: typeof holder === "string" ? [{ name: holder, passedAt: passedAt ?? 0 }] : []
    };
}

export const stateSchema = z.preprocess(
    legacyHolder,
    z.object({
        round: z.number().int().default(1),
        /** Who holds a potato this round, one each. */
        holders: z.array(holderSchema).default([]),
        /** When this round's potatoes go off. */
        fuseEndsAt: z.number().nullable().default(null),
        /** Between rounds: the next one starts then. */
        pauseUntil: z.number().nullable().default(null),
        out: z.array(outSchema).default([])
    })
);
export type PotatoState = z.infer<typeof stateSchema>;

/** The run's rounds as written; null before the first one is. */
export function stateOf(game: unknown): PotatoState | null {
    if (game === null || game === undefined) return null;
    const parsed = stateSchema.safeParse(game);
    return parsed.success ? parsed.data : null;
}

// ------------------------------------------------------------------ the platform

export function platformBox(
    center: { x: number; z: number },
    floorY: number,
    players: number
): Box {
    const half = halfWidth(players);
    return {
        x1: center.x - half - 1,
        y1: floorY,
        z1: center.z - half - 2 - GALLERY_DEPTH,
        x2: center.x + half + 1,
        y2: floorY + WALL + 2,
        z2: center.z + half + 1
    };
}

/** The platform's middle, from its box. */
function middle(box: Box): { x: number; z: number } {
    return { x: (box.x1 + box.x2) / 2, z: box.z2 - 1 - (box.x2 - box.x1 - 2) / 2 };
}

/** The floor players stand on, without the walls. */
export function floorOf(box: Box): Box {
    const half = (box.x2 - box.x1 - 2) / 2;
    const center = middle(box);
    return {
        x1: center.x - half,
        y1: box.y1 + 1,
        z1: center.z - half,
        x2: center.x + half,
        y2: box.y1 + 1,
        z2: center.z + half
    };
}

/** The gallery's floor, a step over the platform's, behind its north wall. */
export function galleryOf(box: Box): Box {
    const floor = floorOf(box);
    return {
        x1: floor.x1,
        y1: box.y1 + 2,
        z1: box.z1 + 1,
        x2: floor.x2,
        y2: box.y1 + 2,
        z2: floor.z1 - 2
    };
}

/** One piece of cover, by its offset from the platform's middle. */
export interface Cover {
    readonly dx: number;
    readonly dz: number;
    readonly kind: "bale" | "post";
}

/** A cell and its three turns round the middle. */
function turned(cell: { dx: number; dz: number }): { dx: number; dz: number }[] {
    return [
        cell,
        { dx: -cell.dz, dz: cell.dx },
        { dx: -cell.dx, dz: -cell.dz },
        { dx: cell.dz, dz: -cell.dx }
    ];
}

/**
 * The cover on a platform, drawn from the run's id: a few cells in one
 * quarter, turned round the middle four ways so no side is better. Every
 * piece is well inside the ring players start on (`startSpot`) - never on a
 * start, never by a wall to climb out from - and no two touch, so there is
 * always a way round. The middle stays clear.
 */
export function coverFor(seed: string, half: number): Cover[] {
    const random = seeded(`${seed}-potato-cover`);
    const inside = half - 2.5;
    const cells: { dx: number; dz: number }[] = [];
    for (let dx = 1; dx <= half; dx += 1)
        for (let dz = 1; dz <= half; dz += 1)
            if (Math.hypot(dx, dz) >= 2 && Math.hypot(dx, dz) < inside) cells.push({ dx, dz });
    const want = Math.max(1, Math.floor(half / 2) - 1);
    const chosen: { dx: number; dz: number }[] = [];
    for (const cell of shuffled(cells, random)) {
        if (chosen.length >= want) break;
        const mine = turned(cell);
        const touches = chosen
            .flatMap(turned)
            .some((other) =>
                mine.some(
                    (one) => Math.abs(one.dx - other.dx) <= 1 && Math.abs(one.dz - other.dz) <= 1
                )
            );
        if (!touches) chosen.push(cell);
    }
    return chosen.flatMap((cell) => {
        const kind = random() < 0.5 ? "bale" : "post";
        return turned(cell).map((one) => ({ ...one, kind }) as const);
    });
}

/** Whether the floor is laid in rings round the middle rather than in stripes. */
function ringedFloor(seed: string): boolean {
    return seeded(`${seed}-potato-floor`)() < 0.5;
}

/**
 * What it is built of, each only into air: lights at the corners of the walls
 * and the rim at the floor's height (which the glass then fills round), the
 * barrier under all of it, the glass walls, the gallery's floor and its
 * barrier roof, the cover drawn from the run's id (`coverFor`), and the floor
 * - in stripes, or in rings round the middle - last, its first corner the
 * proof that the blocks stayed. Without a seed: stripes and no cover.
 */
export function platformFills(box: Box, seed?: string): Fill[] {
    const floor = floorOf(box);
    const gallery = galleryOf(box);
    const y = box.y1 + 1;
    const fills: Fill[] = [];
    for (const [x, z] of [
        [box.x1, floor.z1 - 1],
        [box.x2, floor.z1 - 1],
        [box.x1, box.z2],
        [box.x2, box.z2],
        [box.x1, box.z1],
        [box.x2, box.z1]
    ] as const)
        fills.push({ box: { x1: x, z1: z, x2: x, z2: z, y1: y, y2: y + WALL }, block: LIGHT });
    const ring = (
        x1: number,
        z1: number,
        x2: number,
        z2: number,
        block: string,
        y1 = y,
        y2 = y
    ): Fill => ({
        box: { x1, y1, z1, x2, y2, z2 },
        block
    });
    fills.push(
        ring(box.x1, floor.z1 - 1, box.x2, floor.z1 - 1, RIM),
        ring(box.x1, box.z2, box.x2, box.z2, RIM),
        ring(box.x1, box.z1, box.x1, box.z2, RIM),
        ring(box.x2, box.z1, box.x2, box.z2, RIM),
        ring(box.x1, box.z1, box.x2, box.z1, RIM),
        { box: { ...box, y2: box.y1 }, block: BARRIER },
        // The walls: round the platform and the gallery, and between them.
        ring(box.x1, box.z1, box.x2, box.z1, GLASS, y + 1, y + WALL),
        ring(box.x1, box.z2, box.x2, box.z2, GLASS, y + 1, y + WALL),
        ring(box.x1, box.z1, box.x1, box.z2, GLASS, y + 1, y + WALL),
        ring(box.x2, box.z1, box.x2, box.z2, GLASS, y + 1, y + WALL),
        ring(box.x1, floor.z1 - 1, box.x2, floor.z1 - 1, GLASS, y + 1, y + WALL),
        // The gallery: a step up, and a roof nobody climbs over.
        ring(gallery.x1, gallery.z1, gallery.x2, gallery.z2, GALLERY_FLOOR, y, y + 1),
        ring(box.x1, box.z1, box.x2, floor.z1 - 1, BARRIER, box.y2, box.y2)
    );
    const center = middle(box);
    const half = (floor.x2 - floor.x1) / 2;
    if (seed !== undefined)
        for (const piece of coverFor(seed, half)) {
            const x = center.x + piece.dx;
            const z = center.z + piece.dz;
            if (piece.kind === "bale") fills.push(ring(x, z, x, z, BALE, y + 1, y + 1));
            else
                fills.push(
                    ring(x, z, x, z, POST, y + 1, y + 1),
                    ring(x, z, x, z, POST_LIGHT, y + 2, y + 2)
                );
        }
    if (seed !== undefined && ringedFloor(seed)) {
        // Each square only into air, from the middle out, so each leaves a
        // ring round the last; the outermost - its corner the proof - last.
        for (let k = 0; k <= half; k += 1)
            fills.push(
                ring(
                    center.x - k,
                    center.z - k,
                    center.x + k,
                    center.z + k,
                    STRIPES[(half - k) % 2]!
                )
            );
        return fills;
    }
    for (let z = floor.z1; z <= floor.z2; z += 1)
        fills.push(ring(floor.x1, z, floor.x2, z, STRIPES[(z - floor.z1) % 2]!));
    // The first stripe last, as the proof.
    const first = fills.findIndex((one) => one.block === STRIPES[0]);
    fills.push(...fills.splice(first, 1));
    return fills;
}

/** The way to face from `from` to look at `to`: 0 is south, 90 west, in this game. */
function yawTowards(from: { x: number; z: number }, to: { x: number; z: number }): number {
    return Math.round((-Math.atan2(to.x - from.x, to.z - from.z) * 1800) / Math.PI) / 10;
}

/** Where each player starts: evenly round the middle, facing it. */
export function startSpot(box: Box, index: number, count: number): Spot {
    const floor = floorOf(box);
    const center = middle(box);
    const radius = (floor.x2 - floor.x1) / 2 - 1;
    const angle = (index / Math.max(1, count)) * Math.PI * 2;
    const x = Math.round(center.x + Math.cos(angle) * radius);
    const z = Math.round(center.z + Math.sin(angle) * radius);
    return { x, y: floor.y1 + 1, z, yaw: yawTowards({ x, z }, center) };
}

/** Where whoever is out watches from: along the gallery, facing the platform. */
export function gallerySpot(box: Box, index: number): Spot {
    const gallery = galleryOf(box);
    const width = gallery.x2 - gallery.x1 + 1;
    return {
        x: gallery.x1 + (index % width),
        y: gallery.y1 + 1,
        z: gallery.z1 + 1 + (Math.floor(index / width) % (gallery.z2 - gallery.z1 + 1)),
        yaw: 0,
        pitch: 25
    };
}

/** Whether somebody stands over the platform's floor. */
export function onPlatform(box: Box, at: { x: number; y: number; z: number }): boolean {
    const floor = floorOf(box);
    return (
        at.x >= floor.x1 &&
        at.x < floor.x2 + 1 &&
        at.z >= floor.z1 &&
        at.z < floor.z2 + 1 &&
        at.y >= floor.y1 &&
        at.y < box.y2
    );
}

// ------------------------------------------------------------------ the rounds

/** This round's holder: drawn from the run's id and the round among who is
 *  left, in the order of their names, so a restart draws the same. */
export function holderFor(seed: string, round: number, left: readonly string[]): string | null {
    if (left.length === 0) return null;
    const names = [...left].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return names[Math.floor(seeded(`${seed}-potato-${round}`)() * names.length)]!;
}

/** This round's `count` holders, each a different player: the first as
 *  `holderFor` draws it, the rest drawn the same way among the others. */
export function holdersFor(
    seed: string,
    round: number,
    left: readonly string[],
    count: number
): string[] {
    const first = holderFor(seed, round, left);
    if (first === null) return [];
    const chosen = [first];
    const rest = [...left]
        .filter((one) => one.toLowerCase() !== first.toLowerCase())
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    for (let index = 1; index < count && rest.length > 0; index += 1) {
        const at = Math.floor(seeded(`${seed}-potato-${round}-${index}`)() * rest.length);
        chosen.push(...rest.splice(at, 1));
    }
    return chosen;
}

/** Whoever holds a potato, by name. */
export function holderNamed(state: PotatoState, name: string): Holder | null {
    return state.holders.find((one) => one.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Whom the holder hit, of those the game says were hurt since the last look:
 * the nearest to the holder. Nobody else can hurt anybody - everybody but the
 * holder is weakened past it - so any of them was hit by the holder.
 */
export function hitBy(
    holder: { x: number; z: number },
    hurt: readonly { name: string; x: number; z: number }[]
): string | null {
    let best: string | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const one of hurt) {
        const away = Math.hypot(one.x - holder.x, one.z - holder.z);
        if (away < nearest) {
            nearest = away;
            best = one.name;
        }
    }
    return best;
}

/** Whether somebody hurt was hurt by the holder: the game's word where it was
 *  asked (`hits-service.attackers`, from 1.19.4; null when nothing hurt them),
 *  anybody hurt where it was not. */
export function hurtByHolder(attacker: string | null | undefined, holder: string): boolean {
    if (attacker === undefined) return true;
    return attacker !== null && attacker.toLowerCase() === holder.toLowerCase();
}

/** Whether `name`'s potato can change hands now: they hold one, and not
 *  straight back. */
export function canPass(state: PotatoState, name: string, now: number): boolean {
    const holder = holderNamed(state, name);
    return holder !== null && now >= holder.passedAt + PASS_COOLDOWN_MS;
}

/** The scores: who went out first has one, each after one more, and whoever is
 *  left one more than everybody out. Out at the same moment, the same. */
export function scoresOf(state: PotatoState | null, names: readonly string[]): Map<string, number> {
    const out = state?.out ?? [];
    const scores = new Map<string, number>();
    for (const name of names) {
        const went = out.find((one) => one.name.toLowerCase() === name.toLowerCase());
        scores.set(name, went ? 1 + out.filter((one) => one.at < went.at).length : out.length + 1);
    }
    return scores;
}

// ------------------------------------------------------------------ the commands

/** The counts a hit is read by, from nothing. */
export function setupLines(): string[] {
    return [DEALT, TAKEN].flatMap((objective, index) => [
        `scoreboard objectives remove ${objective}`,
        `scoreboard objectives add ${objective} minecraft.custom:minecraft.damage_${index === 0 ? "dealt" : "taken"}`
    ]);
}

export const TEARDOWN = [
    ...[DEALT, TAKEN].map((objective) => `scoreboard objectives remove ${objective}`),
    ...hits.TAGS_OFF
];

/** Nobody hurt, whoever they are: a punch a fifth of one, mended at once. */
export function unhurtLines(name: string): string[] {
    return [
        `effect give ${name} minecraft:resistance 3 3 true`,
        `effect give ${name} minecraft:regeneration 3 2 true`,
        `effect give ${name} minecraft:saturation 3 0 true`
    ];
}

/** Unable to hurt anybody: whoever does not hold the potato, or has only just
 *  been handed it. */
export function weakLine(name: string): string {
    return `effect give ${name} minecraft:weakness 3 100 true`;
}

/** The holder, able to pass it, and seen by all. */
export function holderLines(name: string): string[] {
    return [
        `effect clear ${name} minecraft:weakness`,
        `effect give ${name} minecraft:glowing 3 0 true`
    ];
}

/** No longer holding it: the glow off. */
export function unheldLines(name: string): string[] {
    return [`effect clear ${name} minecraft:glowing`];
}

/** The bang where the holder stands: particles and a sound, nothing else. */
export function boomLines(at: { x: number; y: number; z: number }): string[] {
    const where = `${at.x.toFixed(1)} ${(at.y + 1).toFixed(1)} ${at.z.toFixed(1)}`;
    return [
        `execute in minecraft:overworld run particle minecraft:explosion_emitter ${where} 0 0 0 0 1 force`,
        `execute in minecraft:overworld run playsound minecraft:entity.generic.explode master @a ${where} 4 1`
    ];
}

/** The fuse ticking under the holder, faster as it runs out. */
export function fuseLine(name: string, secondsLeft: number): string | null {
    if (secondsLeft > 5) return null;
    return `execute as ${name} at @s run playsound minecraft:entity.tnt.primed master @a ~ ~ ~ 1 ${(1 + (5 - secondsLeft) / 5).toFixed(1)}`;
}
