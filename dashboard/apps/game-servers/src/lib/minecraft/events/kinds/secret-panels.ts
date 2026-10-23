/**
 * The manor's secret panels (`seek-manor.ts`) and what opens them, as the
 * events data pack (`snowball-pack.ts`) works them.
 *
 * A panel is a piece of a wall two blocks high, or one block of a floor, that
 * looks like the blocks round it. Open, the pack sets it to air (a wall) or to
 * a ladder (a floor, over the ladder that goes on down); shut, back to its own
 * block. No pistons and no redstone: one `setblock` each way, only over what
 * the panel is supposed to be, and only where the house still stands round it
 * - a panel left in the sky by a house taken down never puts a block there.
 *
 * Panels are opened by keys, never the other way round, and a key is anywhere
 * in the room, not beside its panel:
 *
 * - a button on the furniture (`btn`), pressed;
 * - a spot on the floor (`up`) where somebody stands looking straight up for
 *   a second and a half (`x_rotation`, 1.13);
 * - something to look at (`gaze`) - a head on a shelf, a lamp - stared at for
 *   two seconds from up to seven blocks away: the classic test, facing the
 *   thing from the eyes, a block out and back along where the player looks,
 *   which lands on their feet only when the two agree;
 * - a rug (`crouch`) crouched on three times (`sneak_time`, read each tick);
 * - a lever (`lever`, from design 5): pulled either way. Nothing else in the
 *   house looks like one, so it is the key anybody sees and tries.
 *
 * A panel that opens or shuts is heard and seen: a piston's sound and a puff
 * of cloud where it is, so whoever pulled a lever across the room knows which
 * wall moved.
 *
 * Launch pads (`PAD`, from design 5) are slime blocks in the floor: standing on
 * one gives a second of Levitation, strong enough to throw a player up onto a
 * ledge beside it (`launchArc`), then a moment before the same player is
 * thrown again. Never Slow Falling: a server that does not allow flight kicks a
 * player who hovers, and Slow Falling is not one of the game's exceptions;
 * Levitation is, and a second of it ends in an ordinary fall.
 *
 * A key carries its panel's number (`ID`) and how long the panel stays open
 * (`HOLD`): long enough to walk from the key to it and in, worked out from the
 * walk (`seek-manor.holdTicks`). It shuts by itself after that, only on a tick
 * when no entity's hitbox touches it or any block round it (a 3 by 3 column, a
 * margin nobody crosses in the one tick a `setblock` takes), so nobody is ever
 * shut in a wall or a floor.
 *
 * The pack only looks at keys and panels near a player an arena took in, once
 * a tick each however many are near (`LAST`), like the bookcase doors
 * (`secret-doors.ts`). Its lava is crossed by everybody, hiders and seekers,
 * with fire resistance (`hide-and-seek.fireproofLines`): a seeker who was sent
 * back from it could never look in a spot under it.
 *
 * Every command here reads the same from 1.13.
 *
 * Pure.
 */

/** Markers: a panel, a key of each kind, a launch pad, the seekers' way home. */
export const PANEL = "pe_pnl";
export const PAD = "pe_pad";
export const KEY = "pe_key";
export const HOME = "pe_hs_home";
/** What the house shows that is not a block: paintings and display blocks. */
export const DECOR = "pe_hs_deco";
const OPEN_TAG = "pe_pnl_open";
const FLOOR_TAG = "pe_pnl_floor";
const NEW_TAG = "pe_new";
const HERE = "pe_key_here";
const SEEN = "pe_key_seen";
/** The tag every player an arena took in carries (`arena.IN_ARENA`). */
const IN_ARENA = "pe_arena";

export type KeyKind = "btn" | "up" | "gaze" | "crouch" | "lever";
export const KEY_KINDS: readonly KeyKind[] = ["btn", "up", "gaze", "crouch", "lever"];

/** Scores, at most 16 characters for the oldest releases. */
export const LEFT = "polaris_pnl";
export const LAST = "polaris_plast";
export const ID = "polaris_pid";
export const HOLD = "polaris_phold";
export const COUNT = "polaris_kt";
export const SNEAK = "polaris_sneak";
export const CROUCHED = "polaris_crch";
/** Ticks before a player is thrown by a pad again. */
export const PAD_WAIT = "polaris_padw";
/** Ticks a seeker stays frozen (hide and seek's freeze potion); `#len` holds
 *  how many a hit is worth. */
export const FROZEN = "polaris_frz";
const OBJECTIVES: readonly (readonly [string, string])[] = [
    [PAD_WAIT, "dummy"],
    [FROZEN, "dummy"],
    [LEFT, "dummy"],
    [LAST, "dummy"],
    [ID, "dummy"],
    [HOLD, "dummy"],
    [COUNT, "dummy"],
    [SNEAK, "minecraft.custom:minecraft.sneak_time"],
    [CROUCHED, "dummy"]
];

/** Ticks of looking up, staring, and crouches, before a key fires. */
export const LOOK_UP_TICKS = 30;
export const GAZE_TICKS = 40;
export const CROUCHES = 3;
/** How far from a player a key and a panel are worked. */
export const KEY_NEAR = 10;
export const PANEL_NEAR = 16;
/** How far from its key a panel may be. */
export const REACH = 64;

/** A pad's throw: a second of Levitation at this amplifier. */
export const LAUNCH_SECONDS = 1;
export const LAUNCH_AMPLIFIER = 7;
/** Ticks before the same player is thrown again: past landing. */
export const PAD_WAIT_TICKS = 40;
/** How close to the middle of a pad a player's feet have to be. */
const ON_PAD = 0.7;

/**
 * A player's flight off a pad, worked out the way the game moves a living
 * thing each tick (1.13 to 1.21): it moves by its speed, then under
 * Levitation the speed goes a fifth of the way to `0.05 * (amplifier + 1)`
 * blocks a tick, without it 0.08 is taken off, and either way it keeps 98% of
 * it. Answers the highest the feet get over where they started, and the
 * ticks after the Levitation ends with the player still going up or hanging
 * (speed above -0.03125 a tick) - what the game counts toward its "floating
 * too long" kick, at 80, where flight is off.
 */
export function launchArc(
    seconds = LAUNCH_SECONDS,
    amplifier = LAUNCH_AMPLIFIER
): { peak: number; hanging: number; ticks: number } {
    const lift = seconds * 20;
    let y = 0;
    let speed = 0;
    let peak = 0;
    let hanging = 0;
    let tick = 0;
    for (; tick < 400; tick += 1) {
        y += speed;
        if (y < 0) break;
        peak = Math.max(peak, y);
        if (tick < lift) speed = (speed + (0.05 * (amplifier + 1) - speed) * 0.2) * 0.98;
        else {
            speed = (speed - 0.08) * 0.98;
            if (speed >= -0.03125) hanging += 1;
        }
    }
    return { peak, hanging, ticks: tick };
}

/** Levels a pad throws a player up, for the house's walk: whole ones only. */
export const PAD_RISE = Math.floor(launchArc().peak);

/** Every block a panel can be, by its number. Only these ever go back. */
export const MATERIALS = [
    "minecraft:bookshelf",
    "minecraft:bricks",
    "minecraft:stone_bricks",
    "minecraft:mossy_stone_bricks",
    "minecraft:spruce_planks",
    "minecraft:dark_oak_planks",
    "minecraft:oak_planks",
    "minecraft:cobblestone",
    "minecraft:smooth_stone",
    "minecraft:snow_block",
    "minecraft:polished_andesite",
    "minecraft:grass_block",
    "minecraft:birch_planks",
    "minecraft:quartz_block",
    "minecraft:hay_block",
    "minecraft:white_wool",
    // The themed rooms (design 7). Only blocks every release from 1.13 knows:
    // a function naming one it does not is refused whole.
    "minecraft:nether_bricks",
    "minecraft:red_nether_bricks",
    "minecraft:end_stone_bricks",
    "minecraft:end_stone",
    "minecraft:purpur_block"
] as const;
export type Material = (typeof MATERIALS)[number];
const FACINGS = ["north", "south", "east", "west"] as const;
export type Facing = (typeof FACINGS)[number];

/** The seekers' tag (`hide-and-seek.SIDE_TAGS`): on a server team or ours. */
const SEEKER_TAG = "pe_seeker";
/** The two sides' tags, hiders' and seekers', as `hide-and-seek.SIDE_TAGS`. */
export const SIDE_TAGS = [SEEKER_TAG, "pe_hider"] as const;
/** As near a player as a dropped item is looked for, past where one is picked up. */
export const DROP_NEAR = 6;
/**
 * Whatever the house let fall near somebody playing it - a block knocked off,
 * popped or broken - gone the tick it lands, before its ten ticks are out and
 * anybody can pick it up. The quick look's own sweep (`arena.killBrokenDrops`)
 * goes over RCON and skips a turn while the last is on its way, so on its own
 * it let a hider walk off with what fell. Never the kit (marked, in either
 * spelling), what somebody threw (it has a `Thrower`) or an item the event
 * summoned (it has a tag).
 */
const DROPPED = `@e[type=minecraft:item,distance=..${DROP_NEAR},tag=,nbt=!{Item:{tag:{polaris_event:1b}}},nbt=!{Item:{components:{"minecraft:custom_data":{polaris_event:1b}}}}]`;
/** How near a thrown splash potion has to come to a seeker to freeze them. */
export const FREEZE_REACH = 3;
/**
 * A thrown splash potion: whatever carries a splash potion and is not a
 * dropped item, a frame or a marker. Not by its type: the thrown potion's
 * entity was renamed in 1.21.5, and a name the server does not know is a
 * function it refuses to load. Its stack is `Item` from 1.14 and `Potion` in
 * 1.13, so both are looked for. The game's kit is the only splash potion in an
 * arena: everybody's own things were taken at the door.
 */
const THROWN = (field: "Item" | "Potion"): string =>
    `@e[type=!minecraft:player,type=!minecraft:item,type=!minecraft:item_frame,type=!minecraft:armor_stand,type=!minecraft:painting,distance=..${FREEZE_REACH},nbt={${field}:{id:"minecraft:splash_potion"}}]`;

/** Anything but a dropped item, a marker, a painting or what the house shows. */
const SOMEBODY = `@e[type=!minecraft:item,type=!minecraft:armor_stand,type=!minecraft:painting,type=!minecraft:item_frame,tag=!${DECOR}`;
const MARKER = "@e[type=minecraft:armor_stand";

const materialFunctions = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    MATERIALS.forEach((block, index) => {
        out[`wall_open_${index}`] = [
            `execute if block ~ ~ ~ ${block} run setblock ~ ~ ~ minecraft:air`,
            `execute if block ~ ~1 ~ ${block} run setblock ~ ~1 ~ minecraft:air`
        ];
        // Back only into air, and only with the floor still under it.
        out[`wall_shut_${index}`] = [
            `execute if block ~ ~ ~ minecraft:air unless block ~ ~-1 ~ minecraft:air run setblock ~ ~ ~ ${block}`,
            `execute if block ~ ~1 ~ minecraft:air if block ~ ~ ~ ${block} run setblock ~ ~1 ~ ${block}`
        ];
        out[`floor_open_${index}`] = FACINGS.map(
            (facing) =>
                `execute if entity @s[tag=pe_pnl_f${facing[0]}] if block ~ ~-1 ~ minecraft:ladder if block ~ ~ ~ ${block} run setblock ~ ~ ~ minecraft:ladder[facing=${facing}]`
        );
        out[`floor_shut_${index}`] = [
            `execute if block ~ ~ ~ minecraft:ladder if block ~ ~-1 ~ minecraft:ladder run setblock ~ ~ ~ ${block}`
        ];
    });
    return out;
};

/** The functions, by name under `polaris:panel/`. */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [
        `execute if entity @a[tag=${IN_ARENA}] store result score #now ${LAST} run time query gametime`,
        `execute as @a[tag=${IN_ARENA}] at @s as ${MARKER},tag=${KEY},distance=..${KEY_NEAR}] at @s run function polaris:panel/key`,
        `execute as @a[tag=${IN_ARENA}] at @s as ${MARKER},tag=${PANEL},distance=..${PANEL_NEAR}] at @s run function polaris:panel/each`,
        // A crouch now and the tick before, for the rugs; only near one.
        `execute as @a[tag=${IN_ARENA}] at @s if entity ${MARKER},tag=pe_key_crouch,distance=..${KEY_NEAR}] run function polaris:panel/crouched`,
        // Launch pads: whoever stands on one, unless just thrown.
        `scoreboard players remove @a[tag=${IN_ARENA},scores={${PAD_WAIT}=1..}] ${PAD_WAIT} 1`,
        `execute as @a[tag=${IN_ARENA}] at @s if entity ${MARKER},tag=${PAD},distance=..${ON_PAD}] unless score @s ${PAD_WAIT} matches 1.. run function polaris:panel/launch`,
        // Hide and seek's freeze potion: a seeker it comes near stands still
        // for as long as `#len` says, counted down here; nobody else.
        ...(["Item", "Potion"] as const).map(
            (field) =>
                `execute as @a[tag=${IN_ARENA},tag=${SEEKER_TAG}] at @s if entity ${THROWN(field)} run scoreboard players operation @s ${FROZEN} = #len ${FROZEN}`
        ),
        `execute as @a[tag=${IN_ARENA},scores={${FROZEN}=1..}] at @s run function polaris:panel/frozen`,
        ...SIDE_TAGS.map(
            (side) =>
                `execute as @a[tag=${IN_ARENA},tag=${side}] at @s as ${DROPPED} unless data entity @s Thrower run kill @s`
        )
    ],
    // Unable to walk (Slowness 10, as in the cage) or to strike (Weakness 100,
    // as a hider), a second at a time, so it ends a second after the count.
    frozen: [
        `scoreboard players remove @s ${FROZEN} 1`,
        "effect give @s minecraft:slowness 1 10 true",
        "effect give @s minecraft:weakness 1 100 true",
        "particle minecraft:item_snowball ~ ~1 ~ 0.3 0.5 0.3 0 2 normal"
    ],
    launch: [
        `effect give @s minecraft:levitation ${LAUNCH_SECONDS} ${LAUNCH_AMPLIFIER} true`,
        `scoreboard players set @s ${PAD_WAIT} ${PAD_WAIT_TICKS}`,
        "playsound minecraft:entity.slime.jump block @a[distance=..16] ~ ~ ~ 1 0.6",
        "particle minecraft:item_slime ~ ~0.2 ~ 0.4 0.1 0.4 0 16 normal"
    ],
    crouched: [
        `execute store result score @s ${CROUCHED} run scoreboard players get @s ${SNEAK}`,
        `scoreboard players set @s ${SNEAK} 0`
    ],
    key: [`execute unless score @s ${LAST} = #now ${LAST} run function polaris:panel/key_work`],
    key_work: [
        `scoreboard players operation @s ${LAST} = #now ${LAST}`,
        `scoreboard players add @s ${COUNT} 0`,
        "execute if entity @s[tag=pe_key_btn] if block ~ ~ ~ #minecraft:buttons[powered=true] run function polaris:panel/fire",
        `execute if entity @s[tag=pe_key_up] if entity @a[tag=${IN_ARENA},distance=..0.8,x_rotation=-90..-70] run scoreboard players add @s ${COUNT} 1`,
        `execute if entity @s[tag=pe_key_up] unless entity @a[tag=${IN_ARENA},distance=..0.8,x_rotation=-90..-70] run scoreboard players set @s ${COUNT} 0`,
        `execute if entity @s[tag=pe_key_up] if score @s ${COUNT} matches ${LOOK_UP_TICKS}.. run function polaris:panel/fired`,
        "execute if entity @s[tag=pe_key_gaze] run function polaris:panel/gaze",
        `execute if entity @s[tag=pe_key_crouch] if entity @a[tag=${IN_ARENA},distance=..0.8,scores={${SNEAK}=1..,${CROUCHED}=..0}] run scoreboard players add @s ${COUNT} 1`,
        `execute if entity @s[tag=pe_key_crouch] unless entity @a[tag=${IN_ARENA},distance=..1.5] run scoreboard players set @s ${COUNT} 0`,
        `execute if entity @s[tag=pe_key_crouch] if score @s ${COUNT} matches ${CROUCHES}.. run function polaris:panel/fired`,
        // A lever, pulled either way since the last look: its count is the
        // way it was (1 on, 0 off), so it fires once a pull.
        `execute if entity @s[tag=pe_key_lever] if block ~ ~ ~ minecraft:lever[powered=true] unless score @s ${COUNT} matches 1 run function polaris:panel/fire`,
        `execute if entity @s[tag=pe_key_lever] if block ~ ~ ~ minecraft:lever[powered=false] unless score @s ${COUNT} matches 0 run function polaris:panel/fire`,
        `execute if entity @s[tag=pe_key_lever] if block ~ ~ ~ minecraft:lever[powered=true] run scoreboard players set @s ${COUNT} 1`,
        `execute if entity @s[tag=pe_key_lever] if block ~ ~ ~ minecraft:lever[powered=false] run scoreboard players set @s ${COUNT} 0`
    ],
    gaze: [
        `tag @s add ${HERE}`,
        `execute as @a[tag=${IN_ARENA},distance=..7] at @s anchored eyes facing entity ${MARKER},tag=${HERE},distance=..8,limit=1] feet anchored feet positioned ^ ^ ^1 rotated as @s positioned ^ ^ ^-1 if entity @s[distance=..0.15] run tag ${MARKER},tag=${HERE},distance=..9,limit=1] add ${SEEN}`,
        `execute if entity @s[tag=${SEEN}] run scoreboard players add @s ${COUNT} 1`,
        `execute if entity @s[tag=!${SEEN}] run scoreboard players set @s ${COUNT} 0`,
        `tag @s remove ${HERE}`,
        `tag @s remove ${SEEN}`,
        `execute if score @s ${COUNT} matches ${GAZE_TICKS}.. run function polaris:panel/fired`
    ],
    // Fired, and a moment before the same key fires again.
    fired: ["function polaris:panel/fire", `scoreboard players set @s ${COUNT} -40`],
    fire: [
        `scoreboard players operation #id ${ID} = @s ${ID}`,
        `scoreboard players operation #hold ${LEFT} = @s ${HOLD}`,
        `execute as ${MARKER},tag=${PANEL},distance=..${REACH}] if score @s ${ID} = #id ${ID} run scoreboard players operation @s ${LEFT} > #hold ${LEFT}`
    ],
    each: [`execute unless score @s ${LAST} = #now ${LAST} run function polaris:panel/work`],
    work: [
        `scoreboard players operation @s ${LAST} = #now ${LAST}`,
        `scoreboard players add @s ${LEFT} 0`,
        `execute if score @s ${LEFT} matches 1.. if entity @s[tag=!${OPEN_TAG}] run function polaris:panel/open`,
        `execute if score @s ${LEFT} matches 1.. run scoreboard players remove @s ${LEFT} 1`,
        `execute if score @s ${LEFT} matches ..0 if entity @s[tag=${OPEN_TAG},tag=!${FLOOR_TAG}] positioned ~-1 ~ ~-1 align xyz unless entity ${SOMEBODY},dx=2,dy=1,dz=2] at @s run function polaris:panel/shut`,
        `execute if score @s ${LEFT} matches ..0 if entity @s[tag=${OPEN_TAG},tag=${FLOOR_TAG}] positioned ~-1 ~-1 ~-1 align xyz unless entity ${SOMEBODY},dx=2,dy=3,dz=2] at @s run function polaris:panel/shut`
    ],
    open: [
        ...MATERIALS.map(
            (_, index) =>
                `execute if entity @s[tag=pe_pnl_m${index},tag=!${FLOOR_TAG}] run function polaris:panel/wall_open_${index}`
        ),
        ...MATERIALS.map(
            (_, index) =>
                `execute if entity @s[tag=pe_pnl_m${index},tag=${FLOOR_TAG}] run function polaris:panel/floor_open_${index}`
        ),
        `tag @s add ${OPEN_TAG}`,
        "playsound minecraft:block.piston.extend block @a[distance=..24] ~ ~ ~ 1 0.7",
        "particle minecraft:cloud ~ ~1 ~ 0.3 0.6 0.3 0.02 12 normal"
    ],
    shut: [
        ...MATERIALS.map(
            (_, index) =>
                `execute if entity @s[tag=pe_pnl_m${index},tag=!${FLOOR_TAG}] run function polaris:panel/wall_shut_${index}`
        ),
        ...MATERIALS.map(
            (_, index) =>
                `execute if entity @s[tag=pe_pnl_m${index},tag=${FLOOR_TAG}] run function polaris:panel/floor_shut_${index}`
        ),
        `tag @s remove ${OPEN_TAG}`,
        "playsound minecraft:block.piston.contract block @a[distance=..24] ~ ~ ~ 1 0.7"
    ],
    ...materialFunctions()
};

type Point = { readonly x: number; readonly y: number; readonly z: number };
type BoxLike = {
    readonly x1: number;
    readonly y1: number;
    readonly z1: number;
    readonly x2: number;
    readonly y2: number;
    readonly z2: number;
};

export interface PanelMark extends Point {
    readonly id: number;
    readonly shape: "wall" | "floor";
    readonly material: Material;
    /** A floor panel's ladder, when open. */
    readonly facing?: Facing;
}

export interface KeyMark extends Point {
    readonly id: number;
    readonly kind: KeyKind;
    /** Ticks its panel stays open. */
    readonly hold: number;
}

/** Every marker of ours inside a box, of one tag, as a selector. */
function markersIn(box: BoxLike, tag: string): string {
    return `${MARKER},tag=${tag},x=${box.x1},y=${box.y1},z=${box.z1},dx=${box.x2 - box.x1},dy=${box.y2 - box.y1},dz=${box.z2 - box.z1}]`;
}

function stand(at: Point, tags: readonly string[], y = at.y): string {
    return `execute in minecraft:overworld run summon minecraft:armor_stand ${at.x + 0.5} ${y} ${at.z + 0.5} {Tags:[${[...tags, NEW_TAG].map((tag) => JSON.stringify(tag)).join(",")}],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b}`;
}

function scored(scores: readonly (readonly [string, number])[]): string[] {
    return [
        ...scores.map(
            ([objective, value]) =>
                `scoreboard players set ${MARKER},tag=${NEW_TAG},limit=1] ${objective} ${value}`
        ),
        `tag ${MARKER},tag=${NEW_TAG}] remove ${NEW_TAG}`
    ];
}

/**
 * The panels of a house put to work: anything of ours left in its box from
 * before taken away, the scores made, a marker in each panel (in its lower
 * block) and on each key (a button's or a lever's own block, the spot to stand
 * on, the middle of what to stare at), one on each launch pad (where a player
 * standing on it has their feet), and the seekers' way home.
 */
export function armLines(
    box: BoxLike,
    panels: readonly PanelMark[],
    keys: readonly KeyMark[],
    home: Point | null,
    pads: readonly Point[] = []
): string[] {
    if (panels.length === 0 && pads.length === 0 && !home) return [];
    const lines = [
        ...stopLines(box),
        ...OBJECTIVES.map(
            ([objective, criterion]) => `scoreboard objectives add ${objective} ${criterion}`
        ),
        `execute store result score #now ${LAST} run time query gametime`
    ];
    for (const panel of panels) {
        const tags = [PANEL, `pe_pnl_m${MATERIALS.indexOf(panel.material)}`];
        if (panel.shape === "floor")
            tags.push(FLOOR_TAG, `pe_pnl_f${(panel.facing ?? "north")[0]}`);
        lines.push(stand(panel, tags), ...scored([[ID, panel.id]]));
    }
    for (const key of keys)
        lines.push(
            stand(key, [KEY, `pe_key_${key.kind}`], key.kind === "gaze" ? key.y + 0.25 : key.y),
            ...scored([
                [ID, key.id],
                [HOLD, key.hold]
            ])
        );
    for (const pad of pads)
        lines.push(stand(pad, [PAD]), `tag ${MARKER},tag=${NEW_TAG}] remove ${NEW_TAG}`);
    if (home) lines.push(stand(home, [HOME]), `tag ${MARKER},tag=${NEW_TAG}] remove ${NEW_TAG}`);
    return lines;
}

/** Every marker of ours in the box taken away: the panels stay as they are. */
export function stopLines(box: BoxLike): string[] {
    return [PANEL, KEY, PAD, HOME].map(
        (tag) => `execute in minecraft:overworld run kill ${markersIn(box, tag)}`
    );
}

/** The paintings and display blocks in the box taken away, before the walls
 *  they hang on: a painting whose wall goes first drops as an item. */
export function decorOff(box: BoxLike): string {
    return `execute in minecraft:overworld run kill @e[tag=${DECOR},x=${box.x1},y=${box.y1},z=${box.z1},dx=${box.x2 - box.x1},dy=${box.y2 - box.y1},dz=${box.z2 - box.z1}]`;
}

/** The scores, removed with the rest of the game's. */
export const TEARDOWN: readonly string[] = OBJECTIVES.map(
    ([objective]) => `scoreboard objectives remove ${objective}`
);
