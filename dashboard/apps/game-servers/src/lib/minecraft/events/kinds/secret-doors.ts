/**
 * Hide and seek's secret doors (`hide-and-seek.ts`), as the events data pack
 * (`snowball-pack.ts`) works them.
 *
 * A door is a doorway two blocks high in a bookcase, filled with two
 * bookshelves that look like the rest of it. Two sticky pistons move them: one
 * under the floor, facing up, holds the lower bookshelf in the doorway; one in
 * the wall over it, facing down, holds the upper one. Unpowered, each pulls its
 * bookshelf out of the way - the lower into the floor, the upper into the lintel
 * - and the doorway is open. Powered, they push them back: shut.
 *
 * What powers them is a block of redstone the pack sets beside each piston and
 * takes away again - never a button. A button's own pulse (1.5 s for wood) is
 * too short to walk through, and a pulse extender built of redstone would be
 * one more thing that can break, or be powered by accident. So the press is
 * only read (`powered=true` on a button beside the doorway, inside or out),
 * and the pack keeps the time: the door opens at once and stays open
 * `OPEN_TICKS` after the button was last seen pressed - five seconds from a
 * press of a wooden button, whose pulse is 30 ticks - and then shuts by itself.
 *
 * Nobody is ever shut in the doorway. A piston closing on a player pushes them
 * along, and with the two bookshelves coming from above and below they would
 * end up inside one. So the door shuts only on a tick when no entity's hitbox
 * touches the doorway or any block round it at its height (a 3 by 3 column),
 * a margin nobody can cross in the two ticks a piston takes; and should anybody
 * still be in the doorway of a shut door, it opens again at once. A piston is
 * never powered or unpowered again until `SETTLE_TICKS` after the last change,
 * longer than it takes to move: a sticky piston cut off mid-push drops its
 * block where it is, which would leave a bookshelf in the doorway for good.
 *
 * Each door is an invisible marker stand (`TAG`) set into the wall over it,
 * and everything is measured from there. The pack looks only at the doors
 * within `NEAR` of a player an arena took in, so its work each tick is a
 * handful of block tests per door near somebody and nothing at all elsewhere:
 * the players are found first (a short list), and the doors near each by
 * distance, which the game looks up by chunk. A door two players are near is
 * still worked once a tick (`LAST`).
 *
 * Every command here reads the same from 1.13, the oldest release the pack is
 * written for.
 *
 * Pure.
 */

/** The marker over each door, and the one a shut door carries. */
export const TAG = "pe_door";
export const SHUT_TAG = "pe_door_shut";
/** The tag every player an arena took in carries (`arena.IN_ARENA`). */
const IN_ARENA = "pe_arena";

/** Ticks a door has left open; ticks until it may move again; the game tick a
 *  door was last worked, with the current one on `#now`. At most 16
 *  characters, for the oldest releases. */
export const OPEN = "polaris_door";
export const WAIT = "polaris_dwait";
export const LAST = "polaris_dlast";
export const OBJECTIVES = [OPEN, WAIT, LAST] as const;

/** How long a door stays open after its button is last seen pressed: with a
 *  wooden button's 30-tick pulse, five seconds from the press. */
export const OPEN_TICKS = 70;
/** How long after a change a door is left alone: a piston moves in two ticks,
 *  after a start of up to one. */
export const SETTLE_TICKS = 4;
/** How far from a player a door is worked. */
export const NEAR = 12;
/** The button beside each doorway, inside and out. */
export const BUTTON = "minecraft:oak_button";
export const PISTON = "minecraft:sticky_piston";
export const POWER = "minecraft:redstone_block";

/**
 * Where everything is, in blocks up from the doorway's lower block: the marker
 * stands `MARK` over it, inside the wall, where no piston reaches. The rest is
 * the same column: the power under the lower piston, the lower piston, the
 * lower bookshelf when open (in the floor), the doorway's two blocks, the upper
 * bookshelf when open (the lintel), the upper piston and its power. The
 * buttons are on the bookcase beside the doorway, at its upper block's height,
 * a block in front and a block behind: a corner away from the doorway's
 * column, so a test of the four corners finds them whichever way it faces.
 */
export const RISE = {
    lowPower: -3,
    lowPiston: -2,
    lowShelf: -1,
    upperShelf: 2,
    topPiston: 3,
    topPower: 4,
    button: 1,
    mark: 5
} as const;

const at = (rise: number) => `~${rise - RISE.mark}`;
const CORNERS = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
] as const;

/** Anything but a dropped item, whose hitbox touches the volume. */
const SOMEBODY = "@e[type=!minecraft:item";

/** The functions, by name under `polaris:door/`. */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [
        `execute if entity @a[tag=${IN_ARENA}] store result score #now ${LAST} run time query gametime`,
        `execute as @a[tag=${IN_ARENA}] at @s as @e[type=minecraft:armor_stand,tag=${TAG},distance=..${NEAR}] at @s run function polaris:door/each`
    ],
    // Once a tick, however many players are near.
    each: [`execute unless score @s ${LAST} = #now ${LAST} run function polaris:door/work`],
    work: [
        `scoreboard players operation @s ${LAST} = #now ${LAST}`,
        `scoreboard players add @s ${OPEN} 0`,
        `scoreboard players add @s ${WAIT} 0`,
        // Pressed, inside or out: open from now.
        ...CORNERS.map(
            ([dx, dz]) =>
                `execute if block ~${dx} ${at(RISE.button)} ~${dz} ${BUTTON}[powered=true] run scoreboard players set @s ${OPEN} ${OPEN_TICKS}`
        ),
        `execute if score @s ${WAIT} matches 1.. run scoreboard players remove @s ${WAIT} 1`,
        `execute if score @s ${OPEN} matches 1.. if score @s ${WAIT} matches ..0 if entity @s[tag=${SHUT_TAG}] run function polaris:door/open`,
        // Shut on somebody after all: open again.
        `execute if entity @s[tag=${SHUT_TAG}] if score @s ${WAIT} matches ..0 positioned ~ ${at(0)} ~ align xyz if entity ${SOMEBODY},dx=0,dy=1,dz=0] at @s run function polaris:door/open`,
        `execute if score @s ${OPEN} matches 1.. run scoreboard players remove @s ${OPEN} 1`,
        // Time up, and nobody in the doorway or a block from it.
        `execute if score @s ${OPEN} matches ..0 if score @s ${WAIT} matches ..0 if entity @s[tag=!${SHUT_TAG}] positioned ~-1 ${at(0)} ~-1 align xyz unless entity ${SOMEBODY},dx=2,dy=1,dz=2] at @s run function polaris:door/shut`
    ],
    // The power taken away, only where it is ours.
    open: [
        `execute if block ~ ${at(RISE.lowPower)} ~ ${POWER} run setblock ~ ${at(RISE.lowPower)} ~ minecraft:air`,
        `execute if block ~ ${at(RISE.topPower)} ~ ${POWER} run setblock ~ ${at(RISE.topPower)} ~ minecraft:air`,
        `tag @s remove ${SHUT_TAG}`,
        `scoreboard players set @s ${WAIT} ${SETTLE_TICKS}`
    ],
    // Powered again, only beside a piston of the door's: never into a world
    // the house has gone from.
    shut: [
        `execute if block ~ ${at(RISE.lowPiston)} ~ ${PISTON} if block ~ ${at(RISE.lowPower)} ~ minecraft:air run setblock ~ ${at(RISE.lowPower)} ~ ${POWER}`,
        `execute if block ~ ${at(RISE.topPiston)} ~ ${PISTON} if block ~ ${at(RISE.topPower)} ~ minecraft:air run setblock ~ ${at(RISE.topPower)} ~ ${POWER}`,
        `tag @s add ${SHUT_TAG}`,
        `scoreboard players set @s ${WAIT} ${SETTLE_TICKS}`
    ]
};

/** Every door marker inside a box, as a selector. */
function markersIn(box: {
    x1: number;
    y1: number;
    z1: number;
    x2: number;
    y2: number;
    z2: number;
}): string {
    return `@e[type=minecraft:armor_stand,tag=${TAG},x=${box.x1},y=${box.y1},z=${box.z1},dx=${box.x2 - box.x1},dy=${box.y2 - box.y1},dz=${box.z2 - box.z1}]`;
}

type BoxLike = Parameters<typeof markersIn>[0];

/**
 * The doors of a house put to work: any marker left in its box from before
 * taken away, the scores made, a marker over each door (`marks`, the block the
 * marker stands in), and each door worked once at once - shut, where nobody is
 * in its way - so no door waits for a player to come near before it closes.
 */
export function armLines(
    box: BoxLike,
    marks: readonly { x: number; y: number; z: number }[]
): string[] {
    if (marks.length === 0) return [];
    return [
        `execute in minecraft:overworld run kill ${markersIn(box)}`,
        ...OBJECTIVES.map((objective) => `scoreboard objectives add ${objective} dummy`),
        `execute store result score #now ${LAST} run time query gametime`,
        ...marks.map(
            (mark) =>
                `execute in minecraft:overworld run summon minecraft:armor_stand ${mark.x + 0.5} ${mark.y} ${mark.z + 0.5} {Tags:["${TAG}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b}`
        ),
        `execute in minecraft:overworld as ${markersIn(box)} at @s run function polaris:door/each`
    ];
}

/**
 * The doors left as they are, their markers gone: what the arena's close
 * sends before the house comes down. Nothing moves - the house's pistons come
 * down before their power (`hide-and-seek.HALL_BLOCKS`) - so nothing lands
 * after the sweep that would have taken it.
 */
export function markersOff(box: BoxLike): string[] {
    return [`execute in minecraft:overworld run kill ${markersIn(box)}`];
}

/**
 * The doors stopped: their markers gone first, so nothing powers them again,
 * and every block of their power in the box taken away, so every door opens
 * and nobody is left shut in. Safe on a house with no doors, or none left.
 */
export function stopLines(box: BoxLike): string[] {
    return [
        `execute in minecraft:overworld run kill ${markersIn(box)}`,
        `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace ${POWER}`
    ];
}

/** The scores, removed with the rest of the game's. */
export const TEARDOWN: readonly string[] = OBJECTIVES.map(
    (objective) => `scoreboard objectives remove ${objective}`
);
