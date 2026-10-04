/**
 * A TNT run arena, floating high over a site: floors of TNT stacked one under the
 * other, as spleef stacks its snow (`spleef.ts`), and every block a player stands
 * on taken away a moment after - so standing still is falling, and running is the
 * whole game. Fall through a floor and you land on the one below; fall through the
 * last and a glass net catches you, and you are out.
 *
 * Nothing ever explodes. TNT is only primed by fire, by a flaming arrow, by flint
 * and steel or a fire charge, by redstone power or by another explosion, and none
 * of those is let near it:
 * - the blocks are only ever taken out by setting them to air, which never primes
 *   them; nothing in the arena is redstone, fire or lava, and the weather is held
 *   clear (no lightning);
 * - players come in with nothing in their hands from 1.17 (`stash`), and are in
 *   adventure mode, so they place nothing;
 * - and in case something gets through anyway - a flaming arrow shot from the
 *   ground, a lighter carried in on a version too old to stash - every primed TNT
 *   in or near the arena is taken out the same game tick it appears, by the data
 *   pack below, well before the 80 ticks (10 at the least, set off by another
 *   explosion) it takes to go off.
 *
 * The blocks under the players are taken inside the game, every tick, by a data
 * pack of vanilla commands (the snowball pack's, `snowball-pack.ts`): a block
 * removed behind a running player has to go a fixed few ticks after they stepped
 * on it, and the fastest look over RCON comes round every eight. Each block a
 * player stands on gets a fuse - an invisible marker stand at its middle, with a
 * count of ticks - and when the count runs out the block is set to air, only if it
 * is still TNT, and the marker goes. A player stands on up to four blocks at once,
 * so each of the four corners of their feet is tried.
 *
 * Pure: the boxes, the pack's files and the lines are functions of what they are given.
 */

import type { Arena } from "./spleef";
import type { Box, Volume } from "./stage";
import type { EventOptions } from "../catalog";

export const FLOOR: Box["block"] = "minecraft:tnt";
/** Each floor's rim in its own color, top first, so a player knows which floor
 *  they are on - and, from the floor above, how far down the next one is. */
const RIMS: readonly Box["block"][] = [
    "minecraft:red_concrete",
    "minecraft:orange_concrete",
    "minecraft:yellow_concrete",
    "minecraft:lime_concrete"
];
/** The walls between the rims: clear, so the floors below can be seen. */
const WALL: Box["block"] = "minecraft:glass";
const NET: Box["block"] = "minecraft:white_stained_glass";
/** A light at every corner of every rim, and on top of the walls. */
const LIGHT: Box["block"] = "minecraft:sea_lantern";
/** How far under each floor the next one is: room to fall and to land. */
export const LAYER_GAP = 7;
/** How far under the lowest floor the net is. */
const NET_DROP = 4;
/** How high the walls go above the top floor. */
const WALL_HEIGHT = 3;
/** Room above the top floor for jumping about. */
const HEADROOM = 5;

/** A TNT run's arena reads as a spleef's (`spleef.Arena`), so it shares its
 *  start spots (`spleef.spots`) and its way out (`spleef.fell`). */
export type TntArena = Arena;

/**
 * The arena over a site: `layers` floors of TNT, `LAYER_GAP` apart, the top one at
 * `y`. One wall rises round all of them, from the lowest floor's rim to above the
 * top one, so there is no ledge to stand on but the TNT: at each floor's height
 * the wall is that floor's colored rim, with a light at each corner, and clear
 * glass between. A net under the lowest catches whoever falls through it.
 *
 * Every box is apart from every other - none is built into another's blocks - so
 * the count each `fill` answers is the whole box.
 */
export function arena(
    options: Pick<EventOptions<"tnt-run">, "size" | "layers">,
    site: { x: number; z: number },
    y: number
): TntArena {
    const r = options.size;
    const outer = r + 1;
    const { x, z } = site;
    const layers = Math.max(1, options.layers);
    const floors = Array.from({ length: layers }, (_, index) => y - index * LAYER_GAP);
    const bottom = floors[floors.length - 1]!;
    // A ring of the wall at the rim's side, one block wide, from `from` to `to`
    // high: the two long sides edge to edge, the two short ones between them.
    const ring = (from: number, to: number, block: Box["block"]): Box[] =>
        from > to
            ? []
            : [
                  {
                      x1: x - outer,
                      y1: from,
                      z1: z - outer,
                      x2: x + outer,
                      y2: to,
                      z2: z - outer,
                      block
                  },
                  {
                      x1: x - outer,
                      y1: from,
                      z1: z + outer,
                      x2: x + outer,
                      y2: to,
                      z2: z + outer,
                      block
                  },
                  { x1: x - outer, y1: from, z1: z - r, x2: x - outer, y2: to, z2: z + r, block },
                  { x1: x + outer, y1: from, z1: z - r, x2: x + outer, y2: to, z2: z + r, block }
              ];
    // A rim: its four sides between the corners, and a light on each corner.
    const rim = (at: number, block: Box["block"]): Box[] => [
        { x1: x - r, y1: at, z1: z - outer, x2: x + r, y2: at, z2: z - outer, block },
        { x1: x - r, y1: at, z1: z + outer, x2: x + r, y2: at, z2: z + outer, block },
        { x1: x - outer, y1: at, z1: z - r, x2: x - outer, y2: at, z2: z + r, block },
        { x1: x + outer, y1: at, z1: z - r, x2: x + outer, y2: at, z2: z + r, block },
        ...corners(x, z, outer, at)
    ];
    const boxes: Box[] = [
        {
            x1: x - outer,
            y1: bottom - NET_DROP,
            z1: z - outer,
            x2: x + outer,
            y2: bottom - NET_DROP,
            z2: z + outer,
            block: NET
        }
    ];
    // The lowest first: what stands higher is built over what is already there.
    for (let index = layers - 1; index >= 0; index -= 1) {
        const at = floors[index]!;
        const above = index === 0 ? at + WALL_HEIGHT : floors[index - 1]! - 1;
        boxes.push(
            { x1: x - r, y1: at, z1: z - r, x2: x + r, y2: at, z2: z + r, block: FLOOR },
            ...rim(at, RIMS[index % RIMS.length]!),
            ...ring(at + 1, above, WALL)
        );
    }
    // A light on top of each corner of the walls, as on a spleef's.
    boxes.push(...corners(x, z, outer, y + WALL_HEIGHT + 1));
    return {
        floor: y,
        floors,
        center: { x, z },
        size: r,
        boxes,
        volume: {
            x1: x - outer,
            y1: bottom - NET_DROP,
            z1: z - outer,
            x2: x + outer,
            y2: y + HEADROOM,
            z2: z + outer
        },
        reach: Math.ceil(Math.SQRT2 * outer)
    };
}

function corners(x: number, z: number, outer: number, at: number): Box[] {
    return [
        [x - outer, z - outer],
        [x + outer, z - outer],
        [x - outer, z + outer],
        [x + outer, z + outer]
    ].map(([cx, cz]) => ({
        x1: cx!,
        y1: at,
        z1: cz!,
        x2: cx!,
        y2: at,
        z2: cz!,
        block: LIGHT
    }));
}

/** Every floor's TNT, as its boxes: what the end takes out with the rest. */
export function floorBoxes(arena: TntArena): Box[] {
    return arena.boxes.filter((box) => box.block === FLOOR);
}

// ------------------------------------------------------------------ the data pack

/** Where its scores are kept. At most 16 characters, for the oldest releases. */
export const OBJECTIVE = "polaris_tntrun";
/** The marker on a block that is about to go, and the one just put down. */
export const FUSE_TAG = "polaris_tnt_fuse";
const NEW_TAG = "polaris_tnt_new";
/**
 * Ticks between a player stepping on a block and the block going: 8, two fifths
 * of a second - TNT Run's own pace. Running (0.22 of a block a tick walking, 0.28
 * sprinting) a player is well past it by then; standing still, or jumping on the
 * spot (about twelve ticks in the air), they are not.
 */
export const FUSE_TICKS = 8;
/** Positions are kept as 64ths of a block, as the snowball pack keeps them. */
const SCALE = 64;
/** How far round the arena a primed TNT is still taken out, in blocks. */
const NEAR = 4;
/** How far each corner of a player's feet is from their middle: half of the
 *  0.6 a player is wide. Exactly half, so a block a player only just
 *  overhangs - and so stands on - is never missed. */
const HALF_WIDTH = 0.3;

const FUSE = `@e[type=minecraft:armor_stand,tag=${FUSE_TAG}]`;

function score(name: string): string {
    return `#${name} ${OBJECTIVE}`;
}

/** The `if score` tests that `#px`/`#py`/`#pz` lie inside a box (`#x1`..`#z2`
 *  for "", `#nx1`..`#nz2` for "n"). */
function within(box: string): string {
    return ["x", "y", "z"]
        .map(
            (axis) =>
                `if score ${score(`p${axis}`)} >= ${score(`${box}${axis}1`)} if score ${score(`p${axis}`)} <= ${score(`${box}${axis}2`)}`
        )
        .join(" ");
}

const STORE_POSITION = ["x", "y", "z"].map(
    (axis, index) =>
        `execute store result score ${score(`p${axis}`)} run data get entity @s Pos[${index}] ${SCALE}`
);

/** The functions, by name under `polaris:tntrun/`. */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [`execute if score ${score("on")} matches 1 run function polaris:tntrun/run`],
    run: [
        // The fuses first, so a fuse lit this tick burns its full count.
        `scoreboard players remove ${FUSE} ${OBJECTIVE} 1`,
        `execute as @e[type=minecraft:armor_stand,tag=${FUSE_TAG},scores={${OBJECTIVE}=..0}] at @s run function polaris:tntrun/drop`,
        "execute in minecraft:overworld as @a[tag=pe_in,distance=0..] run function polaris:tntrun/player",
        "execute in minecraft:overworld as @e[type=minecraft:tnt,distance=0..] run function polaris:tntrun/primed"
    ],
    // As a fuse whose count ran out, at the middle of its block: the block gone
    // only if it is still the arena's TNT, and the fuse with it.
    drop: [
        "fill ~ ~ ~ ~ ~ ~ minecraft:air replace minecraft:tnt",
        "particle minecraft:poof ~ ~0.5 ~ 0.25 0.1 0.25 0.02 3",
        "kill @s"
    ],
    // As a player inside: only over the arena's own floors is anything lit.
    player: [...STORE_POSITION, `execute ${within("")} at @s run function polaris:tntrun/under`],
    // At a player's feet: each corner's block, if it is TNT and has no fuse yet,
    // gets one; then every fuse just lit is given its count.
    under: [
        ...[
            [HALF_WIDTH, HALF_WIDTH],
            [HALF_WIDTH, -HALF_WIDTH],
            [-HALF_WIDTH, HALF_WIDTH],
            [-HALF_WIDTH, -HALF_WIDTH]
        ].map(
            ([dx, dz]) =>
                `execute positioned ~${dx} ~-0.5 ~${dz} align xyz positioned ~0.5 ~0.5 ~0.5 if block ~ ~ ~ minecraft:tnt unless entity @e[type=minecraft:armor_stand,tag=${FUSE_TAG},distance=..0.5] run summon minecraft:armor_stand ~ ~ ~ {Tags:["${FUSE_TAG}","${NEW_TAG}"],Marker:1b,Invisible:1b,NoGravity:1b,Invulnerable:1b}`
        ),
        `scoreboard players set @e[type=minecraft:armor_stand,tag=${NEW_TAG}] ${OBJECTIVE} ${FUSE_TICKS}`,
        `tag @e[type=minecraft:armor_stand,tag=${NEW_TAG}] remove ${NEW_TAG}`
    ],
    // As a primed TNT anywhere in the overworld: in or near the arena, taken out
    // before it can go off.
    primed: [...STORE_POSITION, `execute ${within("n")} run kill @s`]
};

/**
 * Switched on for one arena: the floors' box in 64ths - a player's feet from the
 * lowest floor to a jump over the top one - and the box round the whole arena
 * where a primed TNT is taken out, with the switch last, so the pack never runs
 * against half a box.
 */
export function armLines(arena: TntArena): string[] {
    const r = arena.size;
    const { x, z } = arena.center;
    const top = arena.floors[0] ?? arena.floor;
    const bottom = arena.floors.at(-1) ?? arena.floor;
    const volume = arena.volume;
    const from = (block: number) => block * SCALE;
    const to = (block: number) => (block + 1) * SCALE - 1;
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    return [
        `scoreboard objectives add ${OBJECTIVE} dummy`,
        set("on", 0),
        set("x1", from(x - r)),
        set("x2", to(x + r)),
        set("y1", from(bottom)),
        set("y2", to(top + WALL_HEIGHT)),
        set("z1", from(z - r)),
        set("z2", to(z + r)),
        set("nx1", from(volume.x1 - NEAR)),
        set("nx2", to(volume.x2 + NEAR)),
        set("ny1", from(volume.y1 - NEAR)),
        set("ny2", to(volume.y2 + NEAR)),
        set("nz1", from(volume.z1 - NEAR)),
        set("nz2", to(volume.z2 + NEAR)),
        `kill ${FUSE}`,
        set("on", 1)
    ];
}

/**
 * Switched off, and every fuse taken away - only while the switch is still this
 * arena's (`boxes` holds any of its TNT floors), so ending an old arena never
 * stops a newer one. Safe when it was never on. A fuse left burning would take
 * a block of the next arena, so none outlives its game.
 */
export function stopLines(boxes: readonly Pick<Box, "x1" | "y1" | "z1" | "block">[]): string[] {
    const tnt = boxes.filter((one) => one.block === FLOOR);
    if (tnt.length === 0) return [];
    const x = Math.min(...tnt.map((one) => one.x1));
    const z = Math.min(...tnt.map((one) => one.z1));
    const ours = `if score ${score("x1")} matches ${x * SCALE} if score ${score("z1")} matches ${z * SCALE}`;
    return [
        `execute ${ours} run kill ${FUSE}`,
        `execute ${ours} run scoreboard players set ${score("on")} 0`
    ];
}

/** Every primed TNT in or near an arena's volume, taken out over RCON as well:
 *  the tick's own look, for a server whose pack is off for a moment. */
export function primedOut(volume: Volume): string {
    const x = Math.min(volume.x1, volume.x2) - NEAR;
    const y = Math.min(volume.y1, volume.y2) - NEAR;
    const z = Math.min(volume.z1, volume.z2) - NEAR;
    const dx = Math.abs(volume.x2 - volume.x1) + 2 * NEAR;
    const dy = Math.abs(volume.y2 - volume.y1) + 2 * NEAR;
    const dz = Math.abs(volume.z2 - volume.z1) + 2 * NEAR;
    return `execute in minecraft:overworld run kill @e[type=minecraft:tnt,x=${x},y=${y},z=${z},dx=${dx},dy=${dy},dz=${dz}]`;
}

/** Which floor somebody is on or falling to, counted from the top (1): the
 *  highest whose top their feet are still above. */
export function floorOf(arena: TntArena, y: number): number {
    const floors = arena.floors.length > 0 ? arena.floors : [arena.floor];
    const first = floors.findIndex((at) => y >= at + 0.5);
    return first === -1 ? floors.length : first + 1;
}
