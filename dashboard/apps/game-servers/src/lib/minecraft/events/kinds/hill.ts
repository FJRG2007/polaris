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
/** What a bolt of the storm (`strikeLine`) can leave on the platform. */
export const FIRE = "minecraft:fire";
/** The layers over the floor the platform's box takes in, for that fire. */
export const OVER_FLOOR = 2;

/**
 * The platform's look, put in before its plain floor fills round it: its
 * edge in polished stone with a light at each corner, and the circle drawn
 * in yellow, a block wide, where it ends. Only on the floor's own layer.
 */
export function platformDecor(place: Point, radius: number): { box: Box; block: string }[] {
    const half = radius + MARGIN;
    const { x, y, z } = place;
    const one = (bx: number, bz: number, block: string) => ({
        box: { x1: bx, y1: y, z1: bz, x2: bx, y2: y, z2: bz },
        block
    });
    const out: { box: Box; block: string }[] = [
        one(x - half, z - half, CORNER_BLOCK),
        one(x + half, z - half, CORNER_BLOCK),
        one(x - half, z + half, CORNER_BLOCK),
        one(x + half, z + half, CORNER_BLOCK),
        {
            box: { x1: x - half + 1, y1: y, z1: z - half, x2: x + half - 1, y2: y, z2: z - half },
            block: EDGE_BLOCK
        },
        {
            box: { x1: x - half + 1, y1: y, z1: z + half, x2: x + half - 1, y2: y, z2: z + half },
            block: EDGE_BLOCK
        },
        {
            box: { x1: x - half, y1: y, z1: z - half + 1, x2: x - half, y2: y, z2: z + half - 1 },
            block: EDGE_BLOCK
        },
        {
            box: { x1: x + half, y1: y, z1: z - half + 1, x2: x + half, y2: y, z2: z + half - 1 },
            block: EDGE_BLOCK
        }
    ];
    // The ring: every block whose middle is within half a block of the circle.
    for (let dx = -radius; dx <= radius; dx += 1)
        for (let dz = -radius; dz <= radius; dz += 1) {
            const away = Math.hypot(dx, dz);
            if (Math.abs(away - radius) <= 0.5) out.push(one(x + dx, z + dz, RING_BLOCK));
        }
    return out;
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
export function proofBox(place: Point, radius: number): Box {
    return { ...platformBox(place, radius), y2: place.y + HEADROOM };
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
    ringRadius: number
): string[] {
    const box = platformBox(floor, radius);
    const area = `${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2}`;
    return [
        `execute in minecraft:overworld run fill ${area} ${PLATFORM_BLOCK} replace ${RING_BLOCK}`,
        ...ringBlocks(center, ringRadius).map(
            (one) =>
                `execute in minecraft:overworld run fill ${one.x} ${floor.y} ${one.z} ${one.x} ${floor.y} ${one.z} ${RING_BLOCK} replace ${PLATFORM_BLOCK}`
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
