/**
 * A parkour course, laid out from the run's id so every tick (and a Polaris that
 * restarted halfway) works out the same course without storing it.
 *
 * It snakes back and forth in rows, each row two blocks higher than the last, so
 * the whole of it fits over a small patch of ground - and so no row can be
 * jumped to from the one before: two blocks up is more than anybody jumps. A
 * glass net a few blocks under the lowest row catches every fall, and a fall is
 * undone by sending the player back to their last checkpoint.
 *
 * Past the easy course, some jumps are traps: a slime pad that throws whoever
 * lands on it up again, so the next jump starts in the air; orange platforms
 * that vanish for two seconds in every six; and magenta ones that move - two
 * places a step apart, one there and the other gone, swapping every three
 * seconds (`blinkLines`). Wait for them, or be on them when they go. Some jumps
 * are a climb instead: three blocks up a ladder or a vine on a column. Never
 * two of these in a row, never the start, a checkpoint or the finish, and
 * every fall is still only back to a checkpoint.
 *
 * Each course has a theme - classic concrete, frost (packed ice: slippery),
 * jungle (planks, logs, vines), nether - drawn for the run unless one is chosen.
 */

import { seeded } from "../trivia-bank";
import { PARKOUR_THEMES, type EventOptions } from "../catalog";
import { shuffled } from "../trivia-bank";
import { IN_ARENA, type Box, type Spot, type Volume } from "./stage";

export type Role = "start" | "jump" | "checkpoint" | "finish";

/** A jump that is more than a jump. */
export type Trap = "slime" | "vanish" | "shift";

export type Theme = (typeof PARKOUR_THEMES)[number];

/** One platform: its lowest corner, how wide it is each way, what it is for. */
export interface Platform {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly size: number;
    readonly role: Role;
    readonly trap?: Trap;
    /** Reached by climbing from the platform before: +1 or -1, the way the row runs. */
    readonly climb?: 1 | -1;
}

export interface Course {
    readonly platforms: readonly Platform[];
    /** The indexes of the checkpoints, in order - the finish is the last one. */
    readonly checkpoints: readonly number[];
    /** What is built, in order: the net, the platforms, the finish plate. */
    readonly boxes: readonly Box[];
    /** The platforms that vanish and come back (`blinkLines`). */
    readonly vanishing: readonly Box[];
    /** The moving platforms: each its two places, swapped (`blinkLines`). */
    readonly shifting: readonly { readonly a: Box; readonly b: Box }[];
    readonly theme: Theme;
    /** Everything it takes up, net to headroom: all of it must be air. */
    readonly volume: Volume;
    /** The lowest a player standing on it can be; below this they fell. */
    readonly floor: number;
    /** How far from its middle the farthest part of it is, in blocks. */
    readonly reach: number;
}

/** How far a row runs before it turns. */
const ROW = 22;
/** Every so many platforms, a checkpoint. */
export const CHECK_EVERY = 6;
/** How far under the lowest platform the net is. */
const NET_DROP = 4;
/** Room above the highest platform for a jump. */
const HEADROOM = 4;
/** A finish is scored above this, so any finish beats any progress. */
export const FINISH_BASE = 100_000;

const STEPS: Readonly<
    Record<
        EventOptions<"parkour">["difficulty"],
        { size: number; gaps: readonly number[]; shift: number; slime: number; vanish: number }
    >
> = {
    easy: { size: 2, gaps: [1, 2], shift: 0, slime: 0.1, vanish: 0 },
    medium: { size: 1, gaps: [1, 2], shift: 1, slime: 0.15, vanish: 0.2 },
    hard: { size: 1, gaps: [2, 3], shift: 1, slime: 0.2, vanish: 0.3 }
};

/** How often a plain jump is a climb, and how often a moving platform. */
const CLIMB_CHANCE = 0.15;
const SHIFT_CHANCE: Readonly<Record<EventOptions<"parkour">["difficulty"], number>> = {
    easy: 0,
    medium: 0.12,
    hard: 0.18
};
/** How far a moving platform moves, across the row. */
export const SHIFT_STEP = 2;

const TRAP_BLOCKS: Readonly<Record<Trap, Box["block"]>> = {
    slime: "minecraft:slime_block",
    vanish: "minecraft:orange_concrete",
    shift: "minecraft:magenta_concrete"
};

/**
 * What each theme is built of. Checkpoints stay lime and the finish yellow in
 * every theme, so they read the same whatever the course looks like. Every
 * block has been in the game since 1.13.
 */
const THEMES: Readonly<
    Record<
        Theme,
        {
            start: Box["block"];
            jump: Box["block"];
            column: Box["block"];
            light: Box["block"];
            climb: "ladder" | "vine";
        }
    >
> = {
    classic: {
        start: "minecraft:white_concrete",
        jump: "minecraft:light_blue_concrete",
        column: "minecraft:quartz_block",
        light: "minecraft:sea_lantern",
        climb: "ladder"
    },
    frost: {
        start: "minecraft:blue_ice",
        jump: "minecraft:packed_ice",
        column: "minecraft:blue_ice",
        light: "minecraft:sea_lantern",
        climb: "ladder"
    },
    jungle: {
        start: "minecraft:mossy_stone_bricks",
        jump: "minecraft:jungle_planks",
        column: "minecraft:jungle_log",
        light: "minecraft:glowstone",
        climb: "vine"
    },
    nether: {
        start: "minecraft:red_nether_bricks",
        jump: "minecraft:nether_bricks",
        column: "minecraft:red_nether_bricks",
        light: "minecraft:glowstone",
        climb: "ladder"
    }
};

const ROLE_BLOCKS: Readonly<Record<"checkpoint" | "finish", Box["block"]>> = {
    checkpoint: "minecraft:lime_concrete",
    finish: "minecraft:yellow_concrete"
};

/** A run's theme: the one chosen, or drawn from its id. */
export function themeFor(options: EventOptions<"parkour">, seed: string): Theme {
    const chosen = options.theme ?? "random";
    if (chosen !== "random") return chosen;
    return shuffled(PARKOUR_THEMES, seeded(`parkour-theme-${seed}`))[0] as Theme;
}

/** The climbing block on the side of a column facing back along the row. */
function climbBlock(kind: "ladder" | "vine", direction: 1 | -1): Box["block"] {
    if (kind === "ladder")
        return direction > 0 ? "minecraft:ladder[facing=west]" : "minecraft:ladder[facing=east]";
    return direction > 0 ? "minecraft:vine[east=true]" : "minecraft:vine[west=true]";
}

const NET: Box["block"] = "minecraft:white_stained_glass";

/** The course laid out around 0 0 0, the rows running between x 0 and `ROW`. */
function laidOut(options: EventOptions<"parkour">, seed: string): Platform[] {
    const random = seeded(`parkour-${seed}`);
    const step = STEPS[options.difficulty];
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const sizeFor = (index: number, total: number): { size: number; role: Role } => {
        if (index === total) return { size: 3, role: "finish" };
        if (index % CHECK_EVERY === 0) return { size: 3, role: "checkpoint" };
        return { size: step.size, role: "jump" };
    };

    // The start sits before the rows begin, so no row ever passes over it.
    const platforms: Platform[] = [{ x: -6, y: 0, z: 0, size: 5, role: "start" }];
    let direction = 1;
    let track = 2;
    const total = options.jumps;
    let turning = 0;
    for (let index = 1; index <= total; index += 1) {
        const current = platforms[platforms.length - 1]!;
        const { size, role } = sizeFor(index, total);
        if (turning > 0) {
            // A turn: two steps along +z, one block up each, lined up with the
            // end of the row - then the next row runs back the other way.
            platforms.push({
                x: direction > 0 ? current.x + current.size - size : current.x,
                y: current.y + 1,
                z: current.z + current.size + 1,
                size,
                role
            });
            turning -= 1;
            if (turning === 0) {
                direction = -direction;
                track = platforms[platforms.length - 1]!.z + Math.floor(size / 2);
            }
            continue;
        }
        // A climb now and then: a column a block away, three up, its ladder or
        // vine on the near side - never right after another special jump.
        const plain = role === "jump" && index >= 2 && !current.trap && !current.climb;
        const climbing = plain && random() < CLIMB_CHANCE;
        const gap = climbing ? 1 : pick(step.gaps);
        // A sideways step only onto a small platform, and only where the jump
        // is not already a long one: a checkpoint stays on the row's line.
        const shift =
            !climbing && role === "jump" && step.shift > 0 && gap < 3 ? pick([-1, 0, 1]) : 0;
        const x = direction > 0 ? current.x + current.size + gap : current.x - gap - size;
        if (x < 0 || x + size - 1 > ROW) {
            turning = 2;
            index -= 1;
            continue;
        }
        if (climbing) {
            platforms.push({
                x,
                y: current.y + 3,
                z: track - Math.floor(size / 2),
                size,
                role,
                climb: direction > 0 ? 1 : -1
            });
            continue;
        }
        // A trap now and then, on a plain jump only, never two in a row.
        const roll = random();
        const shifting = SHIFT_CHANCE[options.difficulty];
        const trap: Trap | undefined = !plain
            ? undefined
            : roll < step.vanish
              ? "vanish"
              : roll < step.vanish + step.slime
                ? "slime"
                : roll < step.vanish + step.slime + shifting
                  ? "shift"
                  : undefined;
        platforms.push({
            x,
            y: current.y,
            z: track - Math.floor(size / 2) + (trap === "shift" ? 0 : shift),
            size,
            role,
            ...(trap ? { trap } : {})
        });
    }
    return platforms;
}

/**
 * The course over a site: its middle over the column, its start at `y`. The
 * same options and run id give the same course, wherever it is put.
 */
export function course(
    options: EventOptions<"parkour">,
    seed: string,
    site: { x: number; z: number },
    y: number
): Course {
    const raw = laidOut(options, seed);
    const theme = themeFor(options, seed);
    const look = THEMES[theme];
    const minX = Math.min(...raw.map((one) => one.x)) - 2;
    const maxX = Math.max(...raw.map((one) => one.x + one.size - 1)) + 2;
    const minZ = Math.min(...raw.map((one) => one.z)) - 2;
    const maxZ = Math.max(...raw.map((one) => one.z + one.size - 1)) + 2;
    const top = Math.max(...raw.map((one) => one.y));
    const dx = site.x - Math.round((minX + maxX) / 2);
    const dz = site.z - Math.round((minZ + maxZ) / 2);
    const platforms = raw.map((one) => ({ ...one, x: one.x + dx, y: one.y + y, z: one.z + dz }));
    const net: Box = {
        x1: minX + dx,
        y1: y - NET_DROP,
        z1: minZ + dz,
        x2: maxX + dx,
        y2: y - NET_DROP,
        z2: maxZ + dz,
        block: NET
    };
    const finish = platforms[platforms.length - 1]!;
    const plate: Box = {
        x1: finish.x + 1,
        y1: finish.y + 1,
        z1: finish.z + 1,
        x2: finish.x + 1,
        y2: finish.y + 1,
        z2: finish.z + 1,
        block: "minecraft:light_weighted_pressure_plate"
    };
    const blockOf = (one: Platform): Box["block"] =>
        one.trap
            ? TRAP_BLOCKS[one.trap]
            : one.role === "checkpoint" || one.role === "finish"
              ? ROLE_BLOCKS[one.role]
              : look[one.role];
    const boxOf = (one: Platform): Box => ({
        x1: one.x,
        y1: one.y,
        z1: one.z,
        x2: one.x + one.size - 1,
        y2: one.y,
        z2: one.z + one.size - 1,
        block: blockOf(one)
    });
    // A moving platform's other place: a step across the row.
    const otherPlace = (one: Platform): Box => ({
        ...boxOf(one),
        z1: one.z + SHIFT_STEP,
        z2: one.z + one.size - 1 + SHIFT_STEP
    });
    // Each climb: the column under the platform, then - after it, so it has
    // something to hang on - the ladder or vine on its near side.
    const columns: Box[] = [];
    const climbs: Box[] = [];
    for (const one of platforms) {
        if (!one.climb) continue;
        columns.push({
            x1: one.x,
            y1: one.y - 2,
            z1: one.z,
            x2: one.x + one.size - 1,
            y2: one.y - 1,
            z2: one.z + one.size - 1,
            block: look.column
        });
        const at = one.climb > 0 ? one.x - 1 : one.x + one.size;
        climbs.push({
            x1: at,
            y1: one.y - 2,
            z1: one.z,
            x2: at,
            y2: one.y,
            z2: one.z + one.size - 1,
            block: climbBlock(look.climb, one.climb)
        });
    }
    // A light under every checkpoint, so it shows from below and far off.
    const lights: Box[] = platforms
        .filter((one) => one.role === "checkpoint" || one.role === "finish")
        .map((one) => {
            const cx = one.x + Math.floor(one.size / 2);
            const cz = one.z + Math.floor(one.size / 2);
            return { x1: cx, y1: one.y - 1, z1: cz, x2: cx, y2: one.y - 1, z2: cz, block: look.light };
        })
        // Never where a climb's column already stands.
        .filter((light) => !columns.some((col) => inside(light, col)));
    const shifts = platforms.filter((one) => one.trap === "shift");
    // Built in this order and taken out the other way: the climbs come off
    // their columns before the columns go, so a ladder never drops as an item.
    const boxes: Box[] = [
        net,
        ...platforms.map(boxOf),
        ...shifts.map(otherPlace),
        ...lights,
        ...columns,
        ...climbs,
        plate
    ];
    return {
        platforms,
        theme,
        shifting: shifts.map((one) => ({ a: boxOf(one), b: otherPlace(one) })),
        vanishing: platforms.filter((one) => one.trap === "vanish").map(boxOf),
        checkpoints: platforms.flatMap((one, index) =>
            one.role === "checkpoint" || one.role === "finish" ? [index] : []
        ),
        boxes,
        volume: {
            x1: net.x1,
            y1: net.y1,
            z1: net.z1,
            x2: net.x2,
            y2: y + top + HEADROOM,
            z2: net.z2
        },
        floor: y,
        reach: Math.ceil(Math.hypot(maxX - minX, maxZ - minZ) / 2)
    };
}

/** How long a vanishing platform's cycle is, and how much of it it is gone for. */
export const BLINK_MS = 6_000;
export const GONE_MS = 2_000;

/**
 * The vanishing platforms as they should be now: gone for the last `GONE_MS`
 * of every `BLINK_MS`, there the rest of the time. Taken out only where they
 * are still theirs, and put back only into air.
 */
export function blinkLines(course: Course, now: number): string[] {
    const gone = now % BLINK_MS >= BLINK_MS - GONE_MS;
    // A moving platform is in its first place for one half of the swap, in the
    // other for the other half: the place it leaves is taken out first.
    const first = Math.floor(now / SHIFT_MS) % 2 === 0;
    return [
        ...course.vanishing.map((box) => (gone ? removeBox(box) : buildBox(box))),
        ...(course.shifting ?? []).flatMap(({ a, b }) =>
            first ? [removeBox(b), buildBox(a)] : [removeBox(a), buildBox(b)]
        )
    ];
}

/** How long a moving platform stays in each of its places. */
export const SHIFT_MS = 3_000;

function inside(box: Box, outer: Box): boolean {
    return (
        box.x1 >= outer.x1 &&
        box.x2 <= outer.x2 &&
        box.y1 >= outer.y1 &&
        box.y2 <= outer.y2 &&
        box.z1 >= outer.z1 &&
        box.z2 <= outer.z2
    );
}

function buildBox(box: Box): string {
    return `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} ${box.block} keep`;
}

function removeBox(box: Box): string {
    return `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace ${box.block}`;
}

/** Standing on a platform: over it, within a little of its edges, feet on its top. */
export function platformUnder(
    course: Course,
    at: { x: number; y: number; z: number }
): number | null {
    let found: number | null = null;
    course.platforms.forEach((one, index) => {
        const over =
            at.x >= one.x - 0.3 &&
            at.x <= one.x + one.size + 0.3 &&
            at.z >= one.z - 0.3 &&
            at.z <= one.z + one.size + 0.3;
        const on = at.y >= one.y + 0.9 && at.y <= one.y + 1.6;
        if (over && on) found = index;
    });
    return found;
}

/** The middle of a platform, facing the way the course goes on from it. */
export function spotOn(course: Course, index: number): Spot {
    const one = course.platforms[index] ?? course.platforms[0]!;
    const next = course.platforms[index + 1];
    const yaw = next
        ? Math.round((Math.atan2(-(next.x - one.x), next.z - one.z) * 180) / Math.PI)
        : 0;
    return { x: one.x + one.size / 2, y: one.y + 1, z: one.z + one.size / 2, yaw };
}

/** How many checkpoints lie at or before a platform - the finish counted as the last. */
export function checkpointsBy(course: Course, index: number): number {
    return course.checkpoints.filter((at) => at <= index).length;
}

/** A finish scored so the fastest ranks first, and above every unfinished run. */
export function finishScore(seconds: number): number {
    return FINISH_BASE - Math.max(1, Math.round(seconds));
}

export function isFinish(score: number): boolean {
    return score > FINISH_BASE / 2;
}

// ------------------------------------------------------------------ the quick look

/**
 * Each racer's checkpoint - the platform a fall sends them back to - kept in the
 * game as well as in Polaris, so the quick look (`quickSelectors`) can send a
 * fallen racer back and mark a checkpoint reached with selectors alone, never
 * a read per player.
 */
export const CHECKPOINT_SCORE = "pe_cp";
/** The game tick a racer stepped onto the finish, for their time to the tick. */
export const FINISH_TICK = "pe_done";

export const SCORES_ADDED = [
    `scoreboard objectives add ${CHECKPOINT_SCORE} dummy`,
    `scoreboard objectives add ${FINISH_TICK} dummy`
];

export const SCORES_REMOVED = [
    `scoreboard objectives remove ${CHECKPOINT_SCORE}`,
    `scoreboard objectives remove ${FINISH_TICK}`
];

/** A racer coming in: at their checkpoint, and not finished. */
export function racerScores(name: string, checkpoint: number): string[] {
    return [
        `scoreboard players set ${name} ${CHECKPOINT_SCORE} ${checkpoint}`,
        `scoreboard players reset ${name} ${FINISH_TICK}`
    ];
}

/** Every racer's checkpoint, as the game has it. */
export const READ_CHECKPOINTS = `execute as @a[tag=${IN_ARENA},scores={${CHECKPOINT_SCORE}=0..}] run scoreboard players get @s ${CHECKPOINT_SCORE}`;
/** The tick each racer who reached the finish reached it at. */
export const READ_FINISH_TICKS = `execute as @a[tag=${IN_ARENA},scores={${FINISH_TICK}=1..}] run scoreboard players get @s ${FINISH_TICK}`;
/** The game's own tick count now: `The time is 123456`. */
export const READ_GAME_TIME = "time query gametime";

/** How far to each side of the course a fall is still caught. */
const FALL_SIDE = 4;
/** How far under the net a fall is still caught. */
const FALL_DEPTH = 64;

/**
 * The selectors the quick look uses, all of them only for racers inside
 * (`IN_ARENA`):
 * - `fell`: one per checkpoint a racer can be sent back to (the start and every
 *   checkpoint but the finish) - whoever with that checkpoint is under the
 *   lowest platform's top, with where they go;
 * - `reached`: one per checkpoint and the finish - whoever with an earlier one
 *   is standing over it (or in the block above it).
 * A racer standing on the lowest platforms has their feet a block over `floor`;
 * a box whose top is `floor` catches them only once they are under that.
 */
export function quickSelectors(course: Course): {
    fell: { checkpoint: number; selector: string; spot: Spot }[];
    reached: { checkpoint: number; selector: string; finish: boolean }[];
} {
    const volume = course.volume;
    const x = Math.min(volume.x1, volume.x2) - FALL_SIDE;
    const z = Math.min(volume.z1, volume.z2) - FALL_SIDE;
    const y = Math.min(volume.y1, volume.y2) - FALL_DEPTH;
    const dx = Math.abs(volume.x2 - volume.x1) + 2 * FALL_SIDE;
    const dz = Math.abs(volume.z2 - volume.z1) + 2 * FALL_SIDE;
    const dy = course.floor - y - 1;
    const below = `x=${x},y=${y},z=${z},dx=${dx},dy=${dy},dz=${dz}`;
    const finish = course.platforms.length - 1;
    const backTo = [0, ...course.checkpoints.filter((index) => index !== finish && index !== 0)];
    return {
        fell: backTo.map((checkpoint) => ({
            checkpoint,
            selector: `@a[tag=${IN_ARENA},scores={${CHECKPOINT_SCORE}=${checkpoint}},${below}]`,
            spot: spotOn(course, checkpoint)
        })),
        reached: course.checkpoints.map((checkpoint) => {
            const one = course.platforms[checkpoint]!;
            return {
                checkpoint,
                selector: `@a[tag=${IN_ARENA},scores={${CHECKPOINT_SCORE}=..${checkpoint - 1}},x=${one.x},y=${one.y + 1},z=${one.z},dx=${one.size - 1},dy=0,dz=${one.size - 1}]`,
                finish: checkpoint === finish
            };
        })
    };
}
