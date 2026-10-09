/**
 * What makes a snowball break the spleef floor it hits.
 *
 * In the game a snowball never breaks a block, and a check over RCON cannot see
 * one land: even the quickest look comes round every eight game ticks, and a
 * snowball thrown at the floor is gone in two or three. So the check runs inside
 * the game, every tick, as a small data pack Polaris writes into the world:
 * vanilla commands only, so it works the same on Vanilla, Paper, Fabric, Forge
 * and NeoForge, and is taken in without a restart.
 *
 * Each tick, for every snowball in the overworld close round the arena, it
 * takes the stretch the snowball is about to fly - its position plus its
 * motion, gravity included, and a quarter further so a ball that only grazes
 * the snow is not missed - and the first point of it that is the arena's snow
 * inside the arena's box is broken, and the snowball with it, as if it had hit
 * there. The game pulls a snowball down before it moves it, so a stretch along
 * the stored motion alone stopped short of a floor it was about to hit. The box and an
 * on/off switch are scores Polaris sets over RCON when the game starts
 * (`armLines`) and clears when it ends (`stopLines`); with the switch off the
 * pack does one score check a tick and nothing else. Outside the box nothing is
 * ever touched, and inside it only `snow_block`, which in there is only ever the
 * arena's own floor.
 *
 * The decay game is played here too, for the same reason: a look over RCON
 * comes round every two seconds, so snow taken on a look stayed under a player
 * for two to four - long enough to stand about on. In the pack, the snow a
 * player stands on turns red at once and is gone `DECAY_TICKS` later, as a TNT
 * run's floor goes (`tnt-run.ts`): each red block carries a fuse, an invisible
 * marker with a count, and only red snow is ever taken. A second switch picks
 * the decay game, so a snowball game never decays and a decay game is never
 * hit by snowballs it does not have.
 *
 * Pure: the files and the lines are functions of what they are given.
 */

import * as hits from "./hits";
import type { Box } from "./stage";
import * as tntRun from "./tnt-run";
import * as dropper from "./dropper";
import * as doors from "./secret-doors";
import * as boatRace from "./boat-race";
import { FLOOR, WARN, type Arena } from "./spleef";

/** The pack's folder under the world's `datapacks`, and its id in `/datapack`. */
export const PACK_DIR = "polaris-events";
export const PACK_ID = `file/${PACK_DIR}`;
/** Where its scores are kept. At most 16 characters, for the oldest releases. */
export const OBJECTIVE = "polaris_spleef";
/** The invisible stand moved to each point that is tried, to test the block there. */
export const PROBE_TAG = "polaris_spleef_probe";
/** Positions are kept as 64ths of a block: fine enough, and the world's edge at
 *  thirty million blocks still fits in a score. */
const SCALE = 64;
/** A tick's flight is tried in eighths: at most a block and a half, so a point
 *  every fifth of a block. */
const STEPS = 8;
/** And on past it by a quarter: ten eighths. */
const POINTS = 10;
/** What the game takes off a snowball's upward speed each tick, in 64ths. */
const GRAVITY = Math.round(0.03 * SCALE);
/** How far round the box a snowball is followed at all, in blocks. */
const NEAR = 3;
/** The marker on red snow about to go in the decay game, and the one just put down. */
export const DECAY_TAG = "polaris_spleef_fuse";
const DECAY_NEW_TAG = "polaris_spleef_new";
/**
 * Ticks between a player stepping on snow and the snow going in the decay game:
 * half a second. A little longer than a TNT run's eight, since the red is the
 * warning here; running, a player is well past the block by then, and standing
 * still or jumping on the spot, they are not.
 */
export const DECAY_TICKS = 10;
/** How far each corner of a player's feet is from their middle: half of the
 *  0.6 a player is wide, so a block a player only just overhangs is not missed. */
const HALF_WIDTH = 0.3;
/** How far over the top floor a player's feet still count as on the arena. */
const FEET_ROOM = 3;

const PROBE = `@e[type=minecraft:armor_stand,tag=${PROBE_TAG},limit=1]`;
const DECAY_FUSE = `@e[type=minecraft:armor_stand,tag=${DECAY_TAG}]`;

function score(name: string): string {
    return `#${name} ${OBJECTIVE}`;
}

/** The `if score` tests that a point (`#cx`, `#cy`, `#cz` for "c") lies inside
 *  a box (`#x1`..`#z2` for "", `#nx1`..`#nz2` for "n"). */
function within(point: string, box: string): string {
    return ["x", "y", "z"]
        .map(
            (axis) =>
                `if score ${score(`${point}${axis}`)} >= ${score(`${box}${axis}1`)} if score ${score(`${point}${axis}`)} <= ${score(`${box}${axis}2`)}`
        )
        .join(" ");
}

const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [
        `execute if score ${score("on")} matches 1 in minecraft:overworld as @e[type=minecraft:snowball,distance=0..] run function polaris:spleef/ball`,
        `execute if score ${score("on")} matches 1 if score ${score("decay")} matches 1 run function polaris:spleef/decay`
    ],
    // Only a snowball close round the box is followed any further.
    ball: [
        ...["x", "y", "z"].map(
            (axis, index) =>
                `execute store result score ${score(`p${axis}`)} run data get entity @s Pos[${index}] ${SCALE}`
        ),
        `execute ${within("p", "n")} run function polaris:spleef/near`
    ],
    near: [
        ...["x", "y", "z"].map(
            (axis, index) =>
                `execute store result score ${score(`m${axis}`)} run data get entity @s Motion[${index}] ${SCALE}`
        ),
        `scoreboard players remove ${score("my")} ${GRAVITY}`,
        `scoreboard players set ${score("hit")} 0`,
        ...Array.from({ length: POINTS }, (_, index) => [
            `scoreboard players set ${score("k")} ${index + 1}`,
            `execute if score ${score("hit")} matches 0 run function polaris:spleef/step`
        ]).flat()
    ],
    // One point along the stretch: position + motion * k / STEPS, tested only
    // when it is inside the arena's box.
    step: [
        ...["x", "y", "z"].flatMap((axis) => [
            `scoreboard players operation ${score(`c${axis}`)} = ${score(`m${axis}`)}`,
            `scoreboard players operation ${score(`c${axis}`)} *= ${score("k")}`,
            `scoreboard players operation ${score(`c${axis}`)} /= ${score("steps")}`,
            `scoreboard players operation ${score(`c${axis}`)} += ${score(`p${axis}`)}`
        ]),
        `execute ${within("c", "")} run function polaris:spleef/probe`
    ],
    probe: [
        ...[0, 1, 2].map(
            (index) =>
                `execute store result entity ${PROBE} Pos[${index}] double ${1 / SCALE} run scoreboard players get ${score(`c${"xyz"[index]}`)}`
        ),
        `execute at ${PROBE} if block ~ ~ ~ ${FLOOR} run function polaris:spleef/hit`
    ],
    // Run as the snowball, at the block it is about to hit.
    hit: [
        "setblock ~ ~ ~ minecraft:air",
        "playsound minecraft:block.snow.break block @a ~ ~ ~ 1 1",
        `scoreboard players set ${score("hit")} 1`,
        "kill @s"
    ],
    // The decay game: the fuses first, so a fuse lit this tick burns its full
    // count, then the snow under every player inside.
    decay: [
        `scoreboard players remove ${DECAY_FUSE} ${OBJECTIVE} 1`,
        `execute as @e[type=minecraft:armor_stand,tag=${DECAY_TAG},scores={${OBJECTIVE}=..0}] at @s run function polaris:spleef/gone`,
        "execute in minecraft:overworld as @a[tag=pe_in,distance=0..] run function polaris:spleef/feet"
    ],
    // As a fuse whose count ran out, at the middle of its block: the block gone
    // only if it is still the arena's red snow, and the fuse with it.
    gone: [
        `fill ~ ~ ~ ~ ~ ~ minecraft:air replace ${WARN}`,
        "particle minecraft:poof ~ ~0.5 ~ 0.25 0.1 0.25 0.02 3",
        "kill @s"
    ],
    // As a player: only over the arena's own floors is anything lit.
    feet: [
        ...["x", "y", "z"].map(
            (axis, index) =>
                `execute store result score ${score(`p${axis}`)} run data get entity @s Pos[${index}] ${SCALE}`
        ),
        `execute ${within("p", "f")} at @s run function polaris:spleef/under`
    ],
    // At a player's feet: each corner's block, if it is still white snow, gets
    // a fuse and turns red - so the next corner on the same block finds it red
    // and lights no second one. Then every fuse just lit is given its count.
    under: [
        ...[
            [HALF_WIDTH, HALF_WIDTH],
            [HALF_WIDTH, -HALF_WIDTH],
            [-HALF_WIDTH, HALF_WIDTH],
            [-HALF_WIDTH, -HALF_WIDTH]
        ].flatMap(([dx, dz]) => {
            const at = `execute positioned ~${dx} ~-0.5 ~${dz} align xyz positioned ~0.5 ~0.5 ~0.5 if block ~ ~ ~ ${FLOOR} run`;
            return [
                `${at} summon minecraft:armor_stand ~ ~ ~ {Tags:["${DECAY_TAG}","${DECAY_NEW_TAG}"],Marker:1b,Invisible:1b,NoGravity:1b,Invulnerable:1b}`,
                `${at} setblock ~ ~ ~ ${WARN}`
            ];
        }),
        `scoreboard players set @e[type=minecraft:armor_stand,tag=${DECAY_NEW_TAG}] ${OBJECTIVE} ${DECAY_TICKS}`,
        `tag @e[type=minecraft:armor_stand,tag=${DECAY_NEW_TAG}] remove ${DECAY_NEW_TAG}`
    ]
};

/**
 * Every game the pack plays, by its folder under `polaris:`: the snowballs that
 * break a spleef floor, the floor a TNT run takes from under its players
 * (`tnt-run.ts`), a dropper's landings (`dropper.ts`) and a boat race's gates
 * (`boat-race.ts`), and hide and seek's secret doors (`secret-doors.ts`). Each has a `tick`
 * function, which the game runs every tick and which does nothing while that
 * game's own switch is off. And the arenas' hits (`hits.ts`), which have no
 * tick: their functions are the rewards of the advancements under `hit/`.
 */
const GAMES: readonly (readonly [string, Readonly<Record<string, readonly string[]>>])[] = [
    ["spleef", FUNCTIONS],
    ["tntrun", tntRun.FUNCTIONS],
    ["dropper", dropper.FUNCTIONS],
    ["boat", boatRace.FUNCTIONS],
    ["hit", hits.FUNCTIONS],
    ["door", doors.FUNCTIONS]
];

/** The advancements, by their folder under `polaris:`. */
const ADVANCEMENTS: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
    ["hit", hits.ADVANCEMENTS]
];

/** The pack's files, by their path inside its folder. Both spellings of the
 *  function and advancement folders, because 1.21 renamed them (`functions` to
 *  `function`, `advancements` to `advancement`) and each release reads only
 *  its own; the format range covers 1.13 onwards. */
export function packFiles(): ReadonlyMap<string, string> {
    const files = new Map<string, string>();
    files.set(
        "pack.mcmeta",
        `${JSON.stringify({
            pack: {
                description: "Polaris events",
                pack_format: 4,
                supported_formats: [4, 1000],
                min_format: 4,
                max_format: 1000
            }
        })}\n`
    );
    const tick = `${JSON.stringify({
        values: GAMES.filter(([, functions]) => functions.tick).map(
            ([game]) => `polaris:${game}/tick`
        )
    })}\n`;
    for (const folder of ["advancements", "advancement"])
        for (const [game, advancements] of ADVANCEMENTS)
            for (const [name, advancement] of Object.entries(advancements))
                files.set(
                    `data/polaris/${folder}/${game}/${name}.json`,
                    `${JSON.stringify(advancement)}\n`
                );
    for (const folder of ["functions", "function"]) {
        files.set(`data/minecraft/tags/${folder}/tick.json`, tick);
        for (const [game, functions] of GAMES)
            for (const [name, lines] of Object.entries(functions))
                files.set(
                    `data/polaris/${folder}/${game}/${name}.mcfunction`,
                    `${lines.join("\n")}\n`
                );
    }
    return files;
}

/** Whether `datapack list enabled` names the pack. */
export function packEnabled(said: string): boolean {
    return said.includes(`[${PACK_ID}`) || said.includes(`${PACK_ID} (`);
}

/**
 * Switched on for one arena: its box (every floor, edge to edge) in 64ths,
 * where a player's feet count as on it, a fresh probe stand in the middle of
 * it, which game it is, and the switch last - so the pack never runs against
 * half a box.
 */
export function armLines(arena: Arena, decay = false): string[] {
    const r = arena.size;
    const { x, z } = arena.center;
    const top = arena.floors[0] ?? arena.floor;
    const bottom = arena.floors.at(-1) ?? arena.floor;
    const from = (block: number) => block * SCALE;
    const to = (block: number) => (block + 1) * SCALE - 1;
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    return [
        `scoreboard objectives add ${OBJECTIVE} dummy`,
        set("on", 0),
        set("x1", from(x - r)),
        set("x2", to(x + r)),
        set("y1", from(bottom)),
        set("y2", to(top)),
        set("z1", from(z - r)),
        set("z2", to(z + r)),
        set("nx1", from(x - r - NEAR)),
        set("nx2", to(x + r + NEAR)),
        set("ny1", from(bottom - NEAR)),
        set("ny2", to(top + NEAR)),
        set("nz1", from(z - r - NEAR)),
        set("nz2", to(z + r + NEAR)),
        set("fx1", from(x - r)),
        set("fx2", to(x + r)),
        set("fy1", from(bottom)),
        set("fy2", to(top + FEET_ROOM)),
        set("fz1", from(z - r)),
        set("fz2", to(z + r)),
        set("steps", STEPS),
        set("decay", decay ? 1 : 0),
        `kill ${DECAY_FUSE}`,
        `kill @e[type=minecraft:armor_stand,tag=${PROBE_TAG}]`,
        `execute in minecraft:overworld run summon minecraft:armor_stand ${x + 0.5} ${top + 2} ${z + 0.5} {Tags:["${PROBE_TAG}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b}`,
        set("on", 1)
    ];
}

/**
 * Switched off, and its probe and any decay fuse taken away - only when the switch is still this
 * arena's (`floors` is any of its snow floors, or all of them), so ending an
 * old arena never stops a newer one. Safe when it was never on.
 */
export function stopLines(floors: readonly Pick<Box, "x1" | "y1" | "z1" | "block">[]): string[] {
    const snow = floors.filter((one) => one.block === FLOOR);
    if (snow.length === 0) return [];
    const corner = (axis: "x1" | "y1" | "z1") => Math.min(...snow.map((one) => one[axis]));
    const ours = (["x1", "y1", "z1"] as const)
        .map((axis) => `if score ${score(axis)} matches ${corner(axis) * SCALE}`)
        .join(" ");
    return [
        `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=${PROBE_TAG}]`,
        `execute ${ours} run kill ${DECAY_FUSE}`,
        `execute ${ours} run scoreboard players set ${score("decay")} 0`,
        `execute ${ours} run scoreboard players set ${score("on")} 0`
    ];
}
