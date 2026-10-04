/**
 * Minecraft events played end to end against a server that answers the way the
 * game does: the countdown, the scoreboard, the chest found, the podium, the
 * prizes - handed over or kept for later - the anti-cheat's word, calling one
 * off, and the minute sweep that starts them on their own.
 *
 * The server here records every line it is sent and answers the few questions
 * the engine asks it. Nothing else is faked: the loop, the timers, the stored
 * state and every decision are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as snbt from "@polaris-app/game-servers/src/lib/minecraft/snbt";

// ------------------------------------------------------------------ the world

interface World {
    online: string[];
    /** Buttons pressed in the chat since the last look: the trigger's value by player. */
    pressed: Record<string, number>;
    scores: Record<string, number>;
    chestOpenedAfter: number;
    chestChecks: number;
    flagged: string[];
    sent: string[];
    /** The server log, for what players say in the chat. */
    log: string;
    bossAlive: boolean;
    deaths: Record<string, number>;
    arrived: boolean;
    /** Every column tried is water. */
    allWater: boolean;
    /** Open sea everywhere: the marker comes down on the water, which is nobody's build. */
    sea: boolean;
    /** With `sea`: an island of dry ground this far round 0 0, sea beyond it. */
    dryWithin: number;
    /** Where whoever has a kill of the boss's kind is standing. */
    killerAt: [number, number, number];
    /** Item ids the server does not know. */
    unknownItems: string[];
    /** Which world each player is in; the Overworld when not said. */
    dims: Record<string, string>;
    /** The game's running damage counts, per player. */
    hurt: Record<string, number>;
    /** Damage each player has dealt, as `pe_hit` counts it. */
    dealt: Record<string, number>;
    /** Players standing perfectly still, looking the same way. */
    still: string[];
    /** Players in creative or spectator. */
    creative: string[];
    difficulty: string;
    daylightCycle: "true" | "false";
    /** Whether phantoms come for a player who has not slept. */
    insomnia: "true" | "false";
    /** Each player's own stacks by slot, as `data get entity <p> Inventory` answers
     *  them; a player with none listed carries nothing. */
    inv: Record<string, Map<number, Stack>>;
    /** What each container block holds, by its slot, keyed `x y z`. */
    containers: Map<string, Map<number, Stack>>;
    /** Stacks lying on the ground, by the tag they were dropped with. */
    drops: Map<string, { stack: Stack; owner: string | null }>;
    /** Whether a stack dropped for a player is picked up by them the moment it
     *  is theirs, as a player standing on it does. */
    pickUp: boolean;
    /** Parkour: each racer's checkpoint as the game keeps it, and the tick they finished at. */
    checkpoint: Record<string, number>;
    finishTick: Record<string, number>;
    /** A version that knows the game rules by their new names only. */
    renamedRules: boolean;
    /** Whether the ground under a place is somebody's build. */
    built: boolean;
    /** Ground names the server does not know. */
    refusedGround: string[];
    /** How many ground checks answer that the column is not loaded before any answers. */
    unsureGround: number;
    /** Where players online sleep: `Name: [x, z]`. */
    homes: Record<string, [number, number]>;
    /** The world each of those homes is in; the Overworld when not said. */
    homeWorlds: Record<string, string>;
    /** The marker lands where it was spread, and chests are tracked by where
     *  they are - for the events that put down more than one. */
    markFollows: boolean;
    markAt: [number, number];
    /** Small wild plants put back where they grew, as `x y z`; with `grass`,
     *  short grass grows everywhere nothing else stands. */
    plants: Map<string, string>;
    grass: boolean;
    /** The markers a place's columns are judged by, all at once, as `x,z`. */
    samples: [number, number][];
    /** The markers along the way to a place. */
    path: [number, number][];
    /** Chests standing in the world, as `x y z`, and the ones opened. */
    chests: string[];
    /** The loot table the chests were put down with. */
    chestTable: string;
    opened: string[];
    /** Nothing is air: every chest the event tries to put down is refused. */
    solid: boolean;
    /** Who reeled a treasure in since the last look. */
    caught: string[];
    /** What each player has gathered, as the scoreboard counts it. */
    progress: Record<string, number>;
    /** Unknown: a server that answers to neither name of the rule. */
    keepInventory: "true" | "false" | "unknown";
    /** The answer to `forceload query`. */
    forced: string;
    /** Horde defense: who is at the point, and how many monsters are left. */
    defenders: string[];
    waveAlive: number;
    hits: Record<string, number>;
    /** Blocks that are not air, by `x y z`: the world's, a player's, a meteor's. */
    blocks: Map<string, string>;
    /** Whether somebody stands near a meteor. */
    nearMeteor: boolean;
    /** Parkour and spleef: who carries the arena tag, and where each of them is. */
    inside: Set<string>;
    at: Record<string, [number, number, number]>;
    /** Who a teleport leaves where they were: stuck loading the world. */
    stuck: string[];
    /** Game modes by name: 0 survival, 1 creative, 2 adventure. */
    modes: Record<string, number>;
    /** Something already stands in the air over every site. */
    skyTaken: boolean;
    /** The server's settings file, or null when it cannot be read. */
    properties: string | null;
    /** Files written into the container, by path, and every write in order. */
    files: Map<string, string>;
    writes: string[];
    /** The data packs the game has found in the folder, and the ones it has on. */
    packsFound: Set<string>;
    packsOn: Set<string>;
    /** How many blocks that are not air any box an arena would take holds. */
    solidCount: number;
    /** A protected area: blocks put down do not stay. */
    refuseBlocks: boolean;
    /** A duel's counts, per player: health (20 when not said), damage dealt,
     *  deaths and players killed. */
    hp: Record<string, number>;
    dealt: Record<string, number>;
    died: Record<string, number>;
    pk: Record<string, number>;
    /** The version the server runs. */
    version: string;
    /** Where the line that says so is: this run's log, an archive of it rolled
     *  over at midnight, or nowhere at all. */
    versionIn: "latest" | "archive" | "none";
    /** Lines the game refused to read. */
    refused: string[];
    /** The name over the boss's head, as a player reads it. */
    bossName: string;
    /** The boss's greatest health, as the game has it. */
    bossMaxHealth: number;
    /** A Bukkit-family server (Paper, Spigot, Purpur), and whether EssentialsX
     *  is on it - whose commands answer to vanilla's names. */
    bukkit: boolean;
    essentials: boolean;
    /** Lines a plugin answered instead of the game. */
    pluginGot: string[];
    /** Answers run together with nothing between, as vanilla, Fabric and Paper
     *  send them; NeoForge ends each with a newline. */
    glued: boolean;
    /** A team's prefix and suffix around a player's name, as the game prints it. */
    display: Record<string, [string, string]>;
    /** The side panel's title: the bracket in every score read. */
    scoreTitle: string;
    /** Players carrying each tag. */
    tags: Record<string, Set<string>>;
    /** How long the rain lasts, in ticks, as the last `weather rain` left it. */
    stormTicks: number;
    /** Players linked to a Polaris account, and each account's language. */
    links: Record<string, string>;
    locales: Record<string, string>;
    /** What each player carries, by item, and how many more items fit: a
     *  player with no entry takes any amount and is never counted. */
    bag: Record<string, Record<string, number>>;
    room: Record<string, number>;
    levels: Record<string, number>;
    /** Each player's experience points into their next level. */
    points: Record<string, number>;
    /** Who is still in the air, with nothing under them. */
    aloft: string[];
    /** The boss's health, and each player's melee near it since the last look. */
    bossHealth: number;
    raw: Record<string, number>;
    /** Who shot a bow near the boss since the last look. */
    shooters: string[];
    /** Unknown: a server that answers to neither name of the rule. */
    mobGriefing: "true" | "false" | "unknown";
    /** Who is fighting the boss on the land, nearest first, each a step further off. */
    fighters: string[];
    /** The second phase's minions still alive. */
    minionsLeft: number;
    /** Who stands in the beam up to a boss's sky arena. */
    lift: string[];
    /** How far the nearest fighter stands from the boss, and whether blocks close it in on every side. */
    fighterGap: number;
    bossBoxed: boolean;
}

const world: World = {
    online: [],
    pressed: {},
    scores: {},
    chestOpenedAfter: 3,
    chestChecks: 0,
    flagged: [],
    sent: [],
    log: "",
    bossAlive: true,
    deaths: {},
    arrived: false,
    allWater: false,
    sea: false,
    dryWithin: 0,
    killerAt: [305, 70, 2],
    unknownItems: [],
    dims: {},
    hurt: {},
    dealt: {},
    still: [],
    creative: [],
    difficulty: "Normal",
    daylightCycle: "true",
    insomnia: "true",
    inv: {},
    containers: new Map(),
    drops: new Map(),
    pickUp: false,
    checkpoint: {},
    finishTick: {},
    renamedRules: false,
    built: false,
    refusedGround: [],
    unsureGround: 0,
    homes: {},
    homeWorlds: {},
    markFollows: false,
    markAt: [300, 0],
    plants: new Map(),
    grass: false,
    samples: [],
    path: [],
    chests: [],
    chestTable: "",
    opened: [],
    solid: false,
    caught: [],
    progress: {},
    keepInventory: "false",
    forced: "",
    defenders: [],
    waveAlive: 0,
    hits: {},
    blocks: new Map(),
    nearMeteor: false,
    inside: new Set(),
    at: {},
    stuck: [],
    modes: {},
    skyTaken: false,
    properties: "pvp=true\ndifficulty=normal\n",
    files: new Map(),
    writes: [],
    packsFound: new Set(),
    packsOn: new Set(),
    solidCount: 0,
    refuseBlocks: false,
    hp: {},
    dealt: {},
    died: {},
    pk: {},
    version: "1.21.4",
    versionIn: "latest",
    refused: [],
    bossName: "",
    bossMaxHealth: 0,
    bukkit: false,
    essentials: false,
    pluginGot: [],
    glued: false,
    display: {},
    scoreTitle: "Event title",
    tags: {},
    stormTicks: 0,
    links: {},
    locales: {},
    bag: {},
    room: {},
    levels: {},
    points: {},
    aloft: [],
    bossHealth: 400,
    raw: {},
    shooters: [],
    mobGriefing: "true",
    fighters: [],
    minionsLeft: 0,
    lift: [],
    fighterGap: 2,
    bossBoxed: false
};
let config: Record<string, unknown> = {};
/** The kept-bag copies written to the database, by id. */
const stashRows = new Map<string, Record<string, unknown>>();
/** The database copy cannot be deleted: a give-back stops after they are home. */
let stashDeleteFails = false;
const held: string[] = [];
const released: string[] = [];

/** Bumped on every look, so a player who is not still has always moved - a
 *  block and a turn, well past the threshold for standing still. */
let step = 0;

/** A `fill` as the game answers it: how many blocks changed. */
function fillAnswer(line: string): string | null {
    const fill =
        /fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)(?: replace (\S+)| keep)$/.exec(
            line
        );
    if (!fill) return null;
    const [x1, y1, z1, x2, y2, z2] = fill.slice(1, 7).map(Number) as number[];
    const volume =
        (Math.abs(x2! - x1!) + 1) * (Math.abs(y2! - y1!) + 1) * (Math.abs(z2! - z1!) + 1);
    if (fill[8]) return "Successfully filled 1 block(s)";
    if (fill[7] === "minecraft:structure_void" && world.skyTaken)
        return `Successfully filled ${volume - 7} block(s)`;
    return `Successfully filled ${volume} block(s)`;
}

/** A player's `Dimension` as the game writes it: a number up to 1.15, a name from 1.16. */
function dimension(id: string): string {
    if (events.atLeast(world.version, [1, 16])) return `"${id}"`;
    return String({ "minecraft:the_nether": -1, "minecraft:the_end": 1 }[id] ?? 0);
}

/**
 * A parkour racer's checkpoint and finish, and the quick look's selectors over
 * them, as the game answers: `@a[tag=pe_in,scores={pe_cp=..},x=,y=,z=,dx=,dy=,dz=]`
 * finds a player inside whose score is in range and whose hitbox (0.6 wide, 1.8
 * tall, from their feet) meets the box - which reaches one block past each `d`.
 */
/** Parkour before the start: who is off the start pad, and put back on it. */
let offStart = new Set<string>();

function holdAnswer(line: string): string | null {
    const inside = world.online.filter((name) => world.inside.has(name));
    if (line === "execute in minecraft:overworld run tag @a[tag=pe_in,distance=0..] add pe_hold") {
        offStart = new Set(inside);
        return "";
    }
    const pad =
        /^execute in minecraft:overworld run tag @a\[tag=pe_in,x=(-?\d+),y=(-?\d+),z=(-?\d+),dx=(\d+),dy=(\d+),dz=(\d+)\] remove pe_hold$/.exec(
            line
        );
    if (pad) {
        const [x, y, z, dx, dy, dz] = pad.slice(1).map(Number) as number[];
        for (const name of inside) {
            const [px, py, pz] = world.at[name] ?? [0, 0, 0];
            if (
                px + 0.3 > x! &&
                px - 0.3 < x! + dx! + 1 &&
                py + 1.8 > y! &&
                py < y! + dy! + 1 &&
                pz + 0.3 > z! &&
                pz - 0.3 < z! + dz! + 1
            )
                offStart.delete(name);
        }
        return "";
    }
    const back =
        /^execute in minecraft:overworld run tp @a\[tag=pe_hold\] (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(
            line
        );
    if (back) {
        for (const name of offStart)
            if (!world.stuck.includes(name))
                world.at[name] = [Number(back[1]), Number(back[2]), Number(back[3])];
        return "";
    }
    if (line === "tag @a remove pe_hold") {
        offStart = new Set();
        return "";
    }
    return null;
}

function quickAnswer(line: string): string | null {
    const set = /^scoreboard players set (\w+) pe_cp (-?\d+)$/.exec(line);
    if (set) {
        world.checkpoint[set[1]!] = Number(set[2]);
        return `Set [pe_cp] for ${set[1]} to ${set[2]}`;
    }
    const reset = /^scoreboard players reset (\w+) pe_done$/.exec(line);
    if (reset) {
        delete world.finishTick[reset[1]!];
        return `Reset [pe_done] for ${reset[1]}`;
    }
    const inside = world.online.filter((name) => world.inside.has(name));
    if (line === "execute as @a[tag=pe_in,scores={pe_cp=0..}] run scoreboard players get @s pe_cp")
        return inside
            .filter((name) => world.checkpoint[name] !== undefined)
            .map((name) => `${name} has ${world.checkpoint[name]} [pe_cp]`)
            .join("\n");
    if (
        line ===
        "execute as @a[tag=pe_in,scores={pe_done=1..}] run scoreboard players get @s pe_done"
    )
        return inside
            .filter((name) => world.finishTick[name] !== undefined)
            .map((name) => `${name} has ${world.finishTick[name]} [pe_done]`)
            .join("\n");
    const look =
        /^execute in minecraft:overworld as @a\[tag=pe_in,scores=\{pe_cp=(-?\d*)(\.\.)?(-?\d*)\},x=(-?\d+),y=(-?\d+),z=(-?\d+),dx=(\d+),dy=(\d+),dz=(\d+)\] (?:at @s )?(?:store result score @s pe_done )?run (.+)$/.exec(
            line
        );
    if (!look) return null;
    const [, low, range, high, ...rest] = look as unknown as string[];
    const [x, y, z, dx, dy, dz] = rest.slice(0, 6).map(Number) as number[];
    const command = rest[6]!;
    const inRange = (score: number) =>
        range
            ? (low === "" || score >= Number(low)) && (high === "" || score <= Number(high))
            : score === Number(low);
    const found = inside.filter((name) => {
        const score = world.checkpoint[name];
        const [px, py, pz] = world.at[name] ?? [0, 0, 0];
        return (
            score !== undefined &&
            inRange(score) &&
            px + 0.3 > x! &&
            px - 0.3 < x! + dx! + 1 &&
            py + 1.8 > y! &&
            py < y! + dy! + 1 &&
            pz + 0.3 > z! &&
            pz - 0.3 < z! + dz! + 1
        );
    });
    for (const name of found) {
        const moved = /^tp @s (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(command);
        if (moved) world.at[name] = [Number(moved[1]), Number(moved[2]), Number(moved[3])];
        const marked = /^scoreboard players set @s pe_cp (\d+)$/.exec(command);
        if (marked) world.checkpoint[name] = Number(marked[1]);
        if (line.includes(" store result score @s pe_done "))
            world.finishTick[name] = Math.floor(Date.now() / 50) % 2147483647;
    }
    return found.map((name) => `${command.split(" ")[0]} ${name}`).join("\n");
}

/** One stack as the game keeps it: its data is the components compound, raw. */
interface Stack {
    id: string;
    count: number;
    components?: string;
}

/** A stack as SNBT, the way `data get` writes it. */
function stackSnbt(stack: Stack, slot: number | null): string {
    const parts = [
        ...(slot === null ? [] : [`Slot: ${slot}b`]),
        `id: "${stack.id}"`,
        `count: ${stack.count}`,
        ...(stack.components ? [`components: ${stack.components}`] : [])
    ];
    return `{${parts.join(", ")}}`;
}

/** `[minecraft:x=1,minecraft:y={a: 2}]` back into `{"minecraft:x": 1, "minecraft:y": {a: 2}}`,
 *  the way `data get` writes a stack's components. */
function componentsOf(list: string): string {
    const parts = snbt.splitTopLevel(list.slice(1, -1)).map((part) => {
        const at = part.indexOf("=");
        return `"${part.slice(0, at)}": ${part.slice(at + 1)}`;
    });
    return `{${parts.join(", ")}}`;
}

/** How many stacks in a bag are the player's own, and not the event's marked kit. */
function ownStacks(bag: Map<number, Stack>): number {
    return [...bag.values()].filter(
        (stack) => !`${stack.id}${stack.components ?? ""}`.includes("polaris_event")
    ).length;
}

/** `hotbar.3`, `armor.head` and the rest, as the inventory numbers them. */
function slotNumber(name: string): number | null {
    const hotbar = /^hotbar\.(\d+)$/.exec(name);
    if (hotbar) return Number(hotbar[1]);
    const bag = /^inventory\.(\d+)$/.exec(name);
    if (bag) return 9 + Number(bag[1]);
    const worn = ["armor.feet", "armor.legs", "armor.chest", "armor.head"].indexOf(name);
    if (worn >= 0) return 100 + worn;
    return name === "weapon.offhand" ? -106 : null;
}

/**
 * Bags, barrels and dropped stacks, and `item replace` between them, as a 1.17+
 * server answers: a copy is exact, a slot replaced with air is emptied, and an
 * older server does not know the command.
 */
function itemAnswer(line: string): string | null {
    const bagRead = /^data get entity (\w+) Inventory$/.exec(line);
    if (bagRead) {
        const name = bagRead[1]!;
        if (!world.online.includes(name)) return "No entity was found";
        const bag = world.inv[name] ?? new Map<number, Stack>();
        const list = [...bag]
            .sort(([a], [b]) => a - b)
            .map(([slot, stack]) => stackSnbt(stack, slot));
        return `${name} has the following entity data: [${list.join(", ")}]`;
    }
    const boxRead = /^data get block (-?\d+) (-?\d+) (-?\d+) Items$/.exec(line);
    if (boxRead) {
        const at = `${boxRead[1]} ${boxRead[2]} ${boxRead[3]}`;
        const held = world.containers.get(at);
        if (!held || world.blocks.get(at) !== "minecraft:barrel")
            return "The target block is not a block entity";
        if (held.size === 0) return "Found no elements matching Items";
        const list = [...held]
            .sort(([a], [b]) => a - b)
            .map(([slot, stack]) => stackSnbt(stack, slot));
        return `${boxRead[1]}, ${boxRead[2]}, ${boxRead[3]} has the following block data: [${list.join(", ")}]`;
    }
    const dropRead = /^data get entity @e\[type=minecraft:item,tag=(\w+),limit=1\] Item$/.exec(
        line
    );
    if (dropRead) {
        const drop = world.drops.get(dropRead[1]!);
        return drop
            ? `Item has the following entity data: ${stackSnbt(drop.stack, null)}`
            : "No entity was found";
    }
    const slotRead = /^data get entity (\w+) Inventory\[\{Slot:(-?\d+)b\}\]$/.exec(line);
    if (slotRead) {
        if (!world.online.includes(slotRead[1]!)) return "No entity was found";
        const stack = world.inv[slotRead[1]!]?.get(Number(slotRead[2]));
        return stack
            ? `${slotRead[1]} has the following entity data: ${stackSnbt(stack, Number(slotRead[2]))}`
            : `Found no elements matching Inventory[{Slot:${slotRead[2]}b}]`;
    }
    if (
        !/\bitem replace\b/.test(line) &&
        !/summon minecraft:item/.test(line) &&
        !/tag=pe_(sd|gb)/.test(line)
    )
        return null;
    if (!events.atLeast(world.version, [1, 17]))
        return "Unknown or incomplete command, see below for error\n...item<--[HERE]";
    const intoBox =
        /^execute in minecraft:overworld run item replace block (-?\d+ -?\d+ -?\d+) container\.(\d+) from entity (\w+) (\S+)$/.exec(
            line
        );
    if (intoBox) {
        const [, at, container, name, slotName] = intoBox as unknown as string[];
        const stack = world.inv[name!]?.get(slotNumber(slotName!)!);
        const held = world.containers.get(at!);
        if (!held) return "The target block is not a container";
        if (stack) held.set(Number(container), { ...stack });
        else held.delete(Number(container));
        return "Replaced a slot on 1 block";
    }
    const emptyBag = /^item replace entity (\w+) (\S+) with minecraft:air(?: 1)?$/.exec(line);
    if (emptyBag) {
        if (!world.online.includes(emptyBag[1]!)) return "No entity was found";
        world.inv[emptyBag[1]!]?.delete(slotNumber(emptyBag[2]!)!);
        return "Replaced a slot on 1 entity";
    }
    const written = /^item replace entity (\w+) (\S+) with (\S+?)(\[.*\])? (\d+)$/.exec(line);
    if (written) {
        const [, name, slotName, id, list, count] = written as unknown as string[];
        if (!world.online.includes(name!)) return "No entity was found";
        const bag = (world.inv[name!] ??= new Map());
        bag.set(slotNumber(slotName!)!, {
            id: id!,
            count: Number(count),
            ...(list ? { components: componentsOf(list) } : {})
        });
        return "Replaced a slot on 1 entity";
    }
    const intoBag =
        /^execute in minecraft:overworld run item replace entity (\w+) (\S+) from block (-?\d+ -?\d+ -?\d+) container\.(\d+)$/.exec(
            line
        );
    if (intoBag) {
        const [, name, slotName, at, container] = intoBag as unknown as string[];
        if (!world.online.includes(name!)) return "No entity was found";
        const stack = world.containers.get(at!)?.get(Number(container));
        const bag = (world.inv[name!] ??= new Map());
        if (stack) bag.set(slotNumber(slotName!)!, { ...stack });
        else bag.delete(slotNumber(slotName!)!);
        return "Replaced a slot on 1 entity";
    }
    const emptyBox =
        /^execute in minecraft:overworld run item replace block (-?\d+ -?\d+ -?\d+) container\.(\d+) with minecraft:air$/.exec(
            line
        );
    if (emptyBox) {
        world.containers.get(emptyBox[1]!)?.delete(Number(emptyBox[2]));
        return "Replaced a slot on 1 block";
    }
    const modern = events.atLeast(world.version, [1, 20, 5]);
    const summoned =
        /^execute (unless entity @e\[type=minecraft:item,tag=\w+\] )?at (\w+) run summon minecraft:item ~ ~ ~ \{.*Tags:\["(\w+)"\].*\}$/.exec(
            line
        );
    if (summoned) {
        if (summoned[1] && world.drops.has(summoned[3]!)) return "Test failed";
        if (!world.online.includes(summoned[2]!)) return "No entity was found";
        // Before 1.20.5 an item's count is `Count`: without it, an empty item, gone
        // at once. From 1.20.5 it is `count`, and a `Count` alone is one item.
        const lower = /\{Item:\{id:"([^"]+)",count:(\d+)/.exec(line);
        const upper = /\{Item:\{id:"([^"]+)",Count:(\d+)b/.exec(line);
        const read = modern ? lower : upper;
        if (!read) return "Summoned new Air";
        const components = /,components:(\{.*\})\},Tags:/.exec(line)?.[1];
        world.drops.set(summoned[3]!, {
            stack: { id: read[1]!, count: Number(read[2]), ...(components ? { components } : {}) },
            owner: null
        });
        return "Summoned new Item";
    }
    const copied =
        /^execute as @e\[type=minecraft:item,tag=(\w+),limit=1\] unless data entity @s Item\.count run data modify entity @s Item set from block (-?\d+ -?\d+ -?\d+) Items\[\{Slot:(\d+)b\}\]$/.exec(
            line
        );
    if (copied) {
        const drop = world.drops.get(copied[1]!);
        const stack = world.containers.get(copied[2]!)?.get(Number(copied[3]));
        if (!drop || !stack) return "No entity was found";
        // Since 1.20.5 an item is written with `count`, and the copy is not taken twice.
        if (modern) return "Test failed";
        drop.stack = { ...stack };
        return "Modified entity data of Item";
    }
    if (
        /^execute as @e\[type=minecraft:item,tag=\w+,limit=1\] run data remove entity @s Item\.Slot$/.test(
            line
        )
    )
        return "Nothing changed. The specified properties already have these values";
    const filled =
        /^execute as @e\[type=minecraft:item,tag=(\w+),limit=1\] run item replace entity @s contents from block (-?\d+ -?\d+ -?\d+) container\.(\d+)$/.exec(
            line
        );
    if (filled) {
        const drop = world.drops.get(filled[1]!);
        const stack = world.containers.get(filled[2]!)?.get(Number(filled[3]));
        if (!drop || !stack) return "No entity was found";
        drop.stack = { ...stack };
        return "Replaced a slot on 1 entity";
    }
    const owned =
        /^execute as @e\[type=minecraft:item,tag=(\w+)(?:,limit=1)?\] run data modify entity @s Owner set from entity (\w+) UUID$/.exec(
            line
        );
    if (owned) {
        const drop = world.drops.get(owned[1]!);
        if (drop) drop.owner = owned[2]!;
        return drop ? "Modified entity data of Item" : "No entity was found";
    }
    const released =
        /^execute as @e\[type=minecraft:item,tag=(\w+)\] run data modify entity @s PickupDelay set value 0s$/.exec(
            line
        );
    if (released) {
        const drop = world.drops.get(released[1]!);
        if (drop && world.pickUp && drop.owner) {
            // Theirs, and under their feet: in their bag as soon as it can be.
            const bag = (world.inv[drop.owner] ??= new Map());
            let slot = 0;
            while (bag.has(slot)) slot += 1;
            bag.set(slot, { ...drop.stack });
            world.drops.delete(released[1]!);
        }
        return drop ? "Modified entity data of Item" : "No entity was found";
    }
    const discarded = /^kill @e\[type=minecraft:item,tag=(\w+)\]$/.exec(line);
    if (discarded) {
        const had = world.drops.delete(discarded[1]!);
        return had ? "Killed Item" : "No entity was found";
    }
    const untagged = /^tag @e\[type=minecraft:item,tag=(\w+)\] remove \1$/.exec(line);
    if (untagged) {
        const drop = world.drops.get(untagged[1]!);
        if (drop) {
            world.drops.delete(untagged[1]!);
            world.drops.set(`lying-${world.drops.size}-${untagged[1]}`, drop);
        }
        // Picked up already: no item left to carry the tag.
        return drop ? "Removed tag from 1 entity" : "No entity was found";
    }
    return null;
}

/** How a server refuses a line it cannot read: the brigadier error and where it stopped. */
function refuse(line: string, why: string): string {
    world.refused.push(line);
    return `${why}\n...${line.slice(-30)}<--[HERE]`;
}

/** Whether an item argument is written the way this version reads one: data
 *  components in brackets from 1.20.5, an NBT tag in braces before. */
function itemReadable(item: string): boolean {
    const components = events.atLeast(world.version, [1, 20, 5]);
    return components ? !/^[^[]*\{/.test(item) : !item.includes("[");
}

/** The commands EssentialsX takes over from vanilla, by the names vanilla has. */
const ESSENTIALS =
    /(^|^execute .*? run )(kill|give|tp|teleport|gamemode|clear|xp|experience|time|weather|item) /;

function answer(sent: string): string {
    world.sent.push(sent);
    let line = sent;
    // A data pack is found once the folder is looked at again, and on once enabled.
    if (line === "datapack list available") {
        for (const path of world.files.keys()) {
            const pack = /\/datapacks\/([^/]+)\/pack\.mcmeta$/.exec(path)?.[1];
            if (pack) world.packsFound.add(`file/${pack}`);
        }
        return "";
    }
    if (line === "datapack list enabled")
        return `There are ${world.packsOn.size + 1} data pack(s) enabled: [vanilla (built-in)]${[
            ...world.packsOn
        ]
            .map((id) => `, [${id} (world)]`)
            .join("")}`;
    const toggled = /^datapack (enable|disable) "([^"]+)"$/.exec(line);
    if (toggled) {
        const id = toggled[2]!;
        if (toggled[1] === "disable") return world.packsOn.delete(id) ? "Disabled" : "Not enabled";
        if (!world.packsFound.has(id)) return `Unknown data pack '${id}'`;
        world.packsOn.add(id);
        return "Enabled";
    }
    if (line === "execute as @a[scores={pe_join=1..}] run scoreboard players get @s pe_join")
        return Object.entries(world.pressed)
            .filter(([name]) => world.online.includes(name))
            .map(([name, value]) => `${name} has ${value} [pe_join]`)
            .join("\n");
    if (line === "scoreboard players set @a[scores={pe_join=1..}] pe_join 0") {
        world.pressed = {};
        return "";
    }
    // No `execute if data` before 1.14: a chest is asked about by its loot table.
    if (/ if data /.test(line) && !events.atLeast(world.version, [1, 14]))
        return refuse(line, "Incorrect argument for command");
    const byTable =
        /^execute in minecraft:overworld if block (\S+ \S+ \S+) minecraft:chest\{LootTable:"([^"]+)"\}( run setblock \S+ \S+ \S+ minecraft:air replace)?$/.exec(
            line
        );
    if (byTable) {
        const at = byTable[1]!;
        const unopened =
            world.chests.includes(at) &&
            !world.opened.includes(at) &&
            byTable[2] === world.chestTable;
        if (byTable[3] && unopened) world.chests = world.chests.filter((one) => one !== at);
        return unopened ? (byTable[3] ? "Changed the block" : "Test passed") : "Test failed";
    }
    if (line === "minecraft:difficulty") {
        // Only a Bukkit-family server has vanilla's commands under `minecraft:`.
        return world.bukkit
            ? `The difficulty is ${world.difficulty}`
            : "Unknown or incomplete command, see below for error\n...difficulty<--[HERE]";
    }
    if (world.bukkit) {
        const vanilla = line.replace(/(^| run )minecraft:(?=[a-z_]+( |$))/g, "$1");
        if (vanilla !== line) line = vanilla;
        else if (world.essentials && ESSENTIALS.test(line)) {
            world.pluginGot.push(line);
            return "Error: Player not found.";
        }
    } else if (/(^| run )minecraft:[a-z_]+ /.test(line)) {
        return `Unknown or incomplete command, see below for error\n...${line.slice(0, 20)}<--[HERE]`;
    }
    // Up to 1.21.4 a name is JSON in a string, and anything else is passed over;
    // from 1.21.5 it is a text component, which a plain string is too.
    const named = /^data merge entity @e\[tag=pe_boss,limit=1\] \{CustomName:(.*)\}$/.exec(line);
    if (named) {
        const value = named[1]!;
        const modern = events.atLeast(world.version, [1, 21, 5]);
        const plain = (part: unknown): string =>
            typeof part === "string"
                ? part
                : Array.isArray(part)
                  ? part.map(plain).join("")
                  : String((part as { text?: string }).text ?? "");
        if (value.startsWith("'")) {
            const inner = value.slice(1, -1).replace(/\\(.)/g, "$1");
            world.bossName = modern ? inner : plain(JSON.parse(inner));
        } else if (modern) {
            world.bossName = JSON.parse(/text:("(?:[^"\\]|\\.)*")/.exec(value)![1]!) as string;
        }
        return "Modified entity data of Wither Skeleton";
    }
    if (line.startsWith("attribute ") && !events.atLeast(world.version, [1, 16]))
        return refuse(line, "Unknown command");
    // A boss's own data: its attributes by the names of its version - camelCase
    // up to 1.15 - and anything else passed over.
    const summoned = /run summon minecraft:\S+ \S+ \S+ \S+ \{.*Tags:\["pe_boss"\].*\}$/.exec(line);
    if (summoned) {
        world.bossMaxHealth = 20;
        const legacy = /\{Name:"generic\.maxHealth",Base:([\d.]+)d\}/.exec(line);
        if (legacy && !events.atLeast(world.version, [1, 16]))
            world.bossMaxHealth = Number(legacy[1]);
        return "Summoned new Wither Skeleton";
    }
    const maxHealth =
        /^attribute @e\[tag=pe_boss,limit=1\] minecraft:(generic\.)?max_health base set (\d+)$/.exec(
            line
        );
    if (maxHealth) {
        const modern = events.atLeast(world.version, [1, 21, 2]);
        if (modern === Boolean(maxHealth[1]))
            return refuse(line, "Can't find element of type 'minecraft:attribute'");
        world.bossMaxHealth = Number(maxHealth[2]);
        return `Set base value of attribute Max Health for entity Wither Skeleton to ${maxHealth[2]}.0`;
    }
    const counting = /^clear (\w+) (\S+) 0$/.exec(line);
    if (counting && world.bag[counting[1]!]) {
        const held = world.bag[counting[1]!]![counting[2]!] ?? 0;
        return held > 0
            ? `Found ${held} matching item(s) on player ${counting[1]}`
            : `No items were found on player ${counting[1]}`;
    }
    const cleared = /^clear (\S+) (\S+)(?: (\d+))?$/.exec(line);
    if (cleared) {
        if (!itemReadable(cleared[2]!))
            return refuse(line, "Expected whitespace to end one argument, but found trailing data");
        if (cleared[1]!.startsWith("@a[tag=pe_probe]")) return "No player was found";
        if (!world.online.includes(cleared[1]!)) return "No player was found";
        // What was put in a slot by `item replace` is taken out of it again: by
        // id, and only a marked stack when the marker is asked for.
        const bag = world.inv[cleared[1]!];
        const id = /^[^[{]+/.exec(cleared[2]!)![0];
        const marked = cleared[2]!.includes("polaris_event");
        for (const [slot, stack] of bag ?? []) {
            if (id !== "*" && /^[^[{]+/.exec(stack.id)![0] !== id) continue;
            if (marked && !`${stack.id}${stack.components ?? ""}`.includes("polaris_event"))
                continue;
            bag!.delete(slot);
        }
        return `Removed 1 item(s) from player ${cleared[1]}`;
    }
    const filled = fillAnswer(line);
    if (filled !== null) return filled;
    // Onto whatever is highest under the point - here, the floor six under it.
    const landed =
        /^execute in minecraft:overworld positioned (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) positioned over motion_blocking_no_leaves run tp (\w+) ~ ~ ~/.exec(
            line
        );
    if (landed) {
        const name = landed[4] as string;
        if (!world.online.includes(name)) return "No entity was found";
        if (!world.stuck.includes(name))
            world.at[name] = [Number(landed[1]), Number(landed[2]) - 6, Number(landed[3])];
        return `Teleported ${name}`;
    }
    const holding = holdAnswer(line);
    if (holding !== null) return holding;
    const moved = /^execute in (\S+) run tp (\w+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(line);
    if (moved) {
        const name = moved[2] as string;
        if (!world.online.includes(name)) return "No entity was found";
        if (!world.stuck.includes(name))
            world.at[name] = [Number(moved[3]), Number(moved[4]), Number(moved[5])];
        return `Teleported ${name} to ${moved[3]}, ${moved[4]}, ${moved[5]}`;
    }
    const quick = quickAnswer(line);
    if (quick !== null) return quick;
    const item = itemAnswer(line);
    if (item !== null) return item;
    // Several tests in one line: every one must pass.
    const chained =
        /^execute in minecraft:overworld((?: if block -?\d+ -?\d+ -?\d+ \S+){2,})$/.exec(line);
    if (chained) {
        const tests = [...chained[1]!.matchAll(/ if block (-?\d+ -?\d+ -?\d+) (\S+)/g)];
        const all = tests.every(([, at, block]) =>
            block === "minecraft:air"
                ? !world.blocks.has(at!) && !world.solid
                : world.blocks.get(at!) === block
        );
        return all ? "Test passed" : "Test failed";
    }
    const arenaTag = /^tag (\w+) (add|remove) pe_in$/.exec(line);
    if (arenaTag) {
        if (arenaTag[2] === "add") world.inside.add(arenaTag[1] as string);
        else world.inside.delete(arenaTag[1] as string);
        return "";
    }
    // One player's own tag, as the game answers it; offline, nobody is found.
    const tagOne = /^tag (\w+) (add|remove) (p[el]_\w+)$/.exec(line);
    if (tagOne) {
        const [, name, how, tag] = tagOne as unknown as [string, string, string, string];
        if (!world.online.includes(name)) return "No entity was found";
        if (how === "add") tagged(tag).add(name);
        else tagged(tag).delete(name);
        return how === "add"
            ? `Added tag '${tag}' to ${name}`
            : `Removed tag '${tag}' from ${name}`;
    }
    // Whether somebody is on, and whether they carry a tag.
    const isThere = /^execute if entity @a\[name=(\w+)(?:,tag=(pe_\w+))?\]$/.exec(line);
    if (isThere) {
        const [, name, tag] = isThere as unknown as [string, string, string | undefined];
        const carries = !tag || (tag === "pe_in" ? world.inside.has(name) : tagged(tag).has(name));
        return world.online.includes(name) && carries ? "Test passed, count: 1" : "Test failed";
    }
    if (line === "execute as @a run data get entity @s playerGameType") {
        return world.online
            .map((name) => `${name} has the following entity data: ${world.modes[name] ?? 0}`)
            .join("\n");
    }
    const inArena = world.online.filter((name) => world.inside.has(name));
    if (line === "execute as @a[tag=pe_in] run data get entity @s Pos") {
        return inArena
            .map((name) => {
                const [x, y, z] = world.at[name] ?? [0, 0, 0];
                return `${name} has the following entity data: [${x}d, ${y}d, ${z}d]`;
            })
            .join("\n");
    }
    if (line === "execute as @a[tag=pe_in] run data get entity @s Dimension") {
        return inArena
            .map(
                (name) =>
                    `${name} has the following entity data: ${dimension("minecraft:overworld")}`
            )
            .join("\n");
    }
    const air = /^execute in minecraft:overworld if block (-?\d+ -?\d+ -?\d+) minecraft:air$/.exec(
        line
    );
    if (air) {
        // Not air: a block of the world's or a meteor's, a chest, or a plant standing there.
        const at = air[1] as string;
        const taken =
            world.blocks.has(at) ||
            world.solid ||
            world.chests.includes(at) ||
            plantAt(at) !== undefined;
        return taken ? "Test failed" : "Test passed";
    }
    const plant =
        /^execute in minecraft:overworld if block (-?\d+ -?\d+ -?\d+) minecraft:(short_grass|grass|fern|snow)$/.exec(
            line
        );
    if (plant) return plantAt(plant[1]!) === plant[2] ? "Test passed" : "Test failed";
    const overPlant =
        /^execute in minecraft:overworld if block (\S+ \S+ \S+) minecraft:(short_grass|grass|fern|snow) run setblock \1 minecraft:chest\{LootTable:"([^"]+)"\} replace$/.exec(
            line
        );
    if (overPlant) {
        if (plantAt(overPlant[1]!) !== overPlant[2]) return "Test failed";
        world.plants.delete(overPlant[1]!);
        world.chestTable = overPlant[3]!;
        world.chests.push(overPlant[1]!);
        return "Changed the block";
    }
    const plantBack =
        /^execute in minecraft:overworld if block (\S+ \S+ \S+) minecraft:chest if data block \1 LootTable run setblock \1 minecraft:(short_grass|grass|fern|snow) replace$/.exec(
            line
        );
    if (plantBack) {
        const at = plantBack[1]!;
        if (!world.chests.includes(at) || world.opened.includes(at)) return "Test failed";
        world.chests = world.chests.filter((one) => one !== at);
        world.plants.set(at, plantBack[2]!);
        return "Changed the block";
    }
    const put = /^execute in minecraft:overworld run setblock (-?\d+ -?\d+ -?\d+) (\S+) keep$/.exec(
        line
    );
    if (put) {
        if (world.blocks.has(put[1] as string)) return "Could not set the block";
        world.blocks.set(put[1] as string, put[2] as string);
        if (put[2] === "minecraft:barrel") world.containers.set(put[1] as string, new Map());
        return `Changed the block at ${put[1]}`;
    }
    const take =
        /^execute in minecraft:overworld if block (-?\d+ -?\d+ -?\d+) (\S+) run setblock \S+ \S+ \S+ minecraft:air$/.exec(
            line
        );
    if (take) {
        if (world.blocks.get(take[1] as string) !== take[2]) return "Test failed";
        world.blocks.delete(take[1] as string);
        world.containers.delete(take[1] as string);
        return "Changed the block";
    }
    const ours = /^execute in minecraft:overworld if block (-?\d+ -?\d+ -?\d+) (\S+)$/.exec(line);
    // A block the world knows of, or a meteor's ore; any other test is answered
    // further down.
    if (
        ours &&
        (world.blocks.has(ours[1] as string) ||
            /(_ore|ancient_debris|^minecraft:barrel|^minecraft:barrier)$/.test(ours[2]!))
    )
        return world.blocks.get(ours[1] as string) === ours[2] ? "Test passed" : "Test failed";
    if (line.includes("if entity @a[distance=..12]"))
        return world.nearMeteor ? "Test passed, count: 1" : "Test failed";
    if (line.startsWith("execute in minecraft:overworld if blocks "))
        return `Test passed, count: ${world.solidCount}`;
    if (line === "execute as @a run data get entity @s UUID") {
        return world.online
            .map(
                (name, index) => `${name} has the following entity data: [I; ${index + 1}, 2, 3, 4]`
            )
            .join("\n");
    }
    const duelled =
        /^execute as @a run scoreboard players get @s (pe_hp|pe_dealt|pe_died|pe_pk)$/.exec(line);
    if (duelled) {
        const objective = duelled[1] as "pe_hp" | "pe_dealt" | "pe_died" | "pe_pk";
        const table = {
            pe_hp: world.hp,
            pe_dealt: world.dealt,
            pe_died: world.died,
            pe_pk: world.pk
        }[objective];
        return world.online
            .map(
                (name) =>
                    `${name} has ${table[name] ?? (objective === "pe_hp" ? 20 : 0)} [${objective}]`
            )
            .join("\n");
    }
    if (line === "gamerule sendCommandFeedback") {
        // A server that shows operators every command's answer, as they come.
        return "Gamerule sendCommandFeedback is currently set to: true";
    }
    if (line === "gamerule mobGriefing") {
        return world.mobGriefing === "unknown"
            ? "Unknown or incomplete command, see below for error"
            : `Gamerule mobGriefing is currently set to: ${world.mobGriefing}`;
    }
    const griefing = /^gamerule mobGriefing (true|false)$/.exec(line);
    if (griefing) {
        world.mobGriefing = griefing[1] as "true" | "false";
        return `Gamerule mobGriefing is now set to: ${griefing[1]}`;
    }
    // A world boss's fighters, from where it stands or where it is going to.
    if (
        line.includes("as @a[distance=..40,gamemode=!creative,gamemode=!spectator") &&
        line.endsWith("run data get entity @s Pos")
    ) {
        const fighters = line.includes("sort=furthest,limit=1")
            ? world.fighters.slice(-1)
            : world.fighters;
        return fighters
            .map((name) => {
                const step = world.fighterGap + 8 * world.fighters.indexOf(name);
                return `${name} has the following entity data: [${310.5 + step}d, 70.0d, 4.5d]`;
            })
            .join("\n");
    }
    if (
        line.startsWith(
            "execute at @e[tag=pe_boss,limit=1] align xz positioned ~0.5 ~ ~0.5 unless block ~1 ~ ~ minecraft:air "
        )
    )
        return world.bossAlive && world.bossBoxed ? "Test passed" : "Test failed";
    if (line === "execute if entity @e[tag=pe_bshield]")
        return world.minionsLeft > 0 ? `Test passed, count: ${world.minionsLeft}` : "Test failed";
    if (
        line.includes(
            "tag=!pe_in,gamemode=!creative,gamemode=!spectator] run data get entity @s Pos"
        )
    ) {
        return world.lift
            .map((name) => `${name} has the following entity data: [300.5d, 64.0d, 2.5d]`)
            .join("\n");
    }
    if (
        line === "gamerule naturalRegeneration" ||
        line === "gamerule natural_health_regeneration"
    ) {
        return world.renamedRules === (line === "gamerule natural_health_regeneration")
            ? `Gamerule ${line.slice(9)} is currently set to: true`
            : "Unknown or incomplete command, see below for error";
    }
    if (line === "gamerule keepInventory") {
        return world.keepInventory === "unknown"
            ? "Unknown or incomplete command, see below for error"
            : `Gamerule keepInventory is currently set to: ${world.keepInventory}`;
    }
    if (line === "execute in minecraft:overworld run forceload query") return world.forced;
    if (
        line === "execute if entity @e[tag=pe_mob]" ||
        line === "execute if entity @e[tag=pe_mob,tag=!pe_wmount]"
    )
        return world.waveAlive > 0 ? `Test passed, count: ${world.waveAlive}` : "Test failed";
    if (
        line.includes(
            "as @a[distance=..24,gamemode=!spectator,gamemode=!creative] run data get entity @s Pos"
        )
    ) {
        return world.defenders
            .map((name) => `${name} has the following entity data: [301.0d, 70.0d, 1.0d]`)
            .join("\n");
    }
    if (line === "execute as @a run scoreboard players get @s pe_whit") {
        return Object.entries(world.hits)
            .map(([name, value]) => `${name} has ${value} [pe_whit]`)
            .join("\n");
    }
    const wet =
        /^execute in minecraft:overworld if block (-?\d+) -?\d+ (-?\d+) minecraft:water$/.exec(
            line
        );
    if (wet) return world.sea && !onIsland(wet[1]!, wet[2]!) ? "Test passed" : "Test failed";
    if (line.startsWith("execute in minecraft:overworld unless block")) {
        const column = /unless block (-?\d+) -?\d+ (-?\d+) /.exec(line);
        if (world.sea && !(column && onIsland(column[1]!, column[2]!))) return "Test passed";
        const refused = world.refusedGround.find(
            (id) => line.includes(`minecraft:${id} `) || line.endsWith(`minecraft:${id}`)
        );
        if (refused) return `Unknown block type 'minecraft:${refused}'`;
        if (world.unsureGround > 0) {
            world.unsureGround -= 1;
            return "That position is not loaded";
        }
        // As a real server answers: a chain that holds says "Test passed"; one where any
        // condition fails says nothing at all.
        return world.built ? "Test passed" : "\u001b[0m\n";
    }
    if (
        line === "execute as @a run data get entity @s SpawnX" ||
        line === "execute as @a run data get entity @s SpawnZ"
    ) {
        const axis = line.endsWith("SpawnX") ? 0 : 1;
        return Object.entries(world.homes)
            .map(([name, home]) => `${name} has the following entity data: ${home[axis]}`)
            .join("\n");
    }
    if (line === "execute as @a run data get entity @s SpawnDimension") {
        return Object.keys(world.homes)
            .map(
                (name) =>
                    `${name} has the following entity data: "${world.homeWorlds[name] ?? "minecraft:overworld"}"`
            )
            .join("\n");
    }
    if (line === "difficulty") return `The difficulty is ${world.difficulty}`;
    // Seconds as a whole number up to 1.19.3; a time from 1.19.4, where a bare
    // number is ticks and `s` makes it seconds.
    const storm = /^weather (?:rain|thunder) (\d+)(s?)$/.exec(line);
    if (storm) {
        const seconds = storm[2] === "s";
        if (!events.atLeast(world.version, [1, 19, 4])) {
            if (seconds)
                return `Expected whitespace to end one argument, but found trailing data\n...r rain ${storm[1]}<--[HERE]`;
            world.stormTicks = Number(storm[1]) * 20;
        } else world.stormTicks = Number(storm[1]) * (seconds ? 20 : 1);
        return line.includes("thunder") ? "Changing to rain and thunder" : "Changing to rain";
    }
    // `daytime` is gone from 26.1, read as a timeline that does not exist; the
    // day's own timeline answers instead.
    if (line === "time query daytime") {
        return events.atLeast(world.version, [26, 1])
            ? "Unknown timeline 'minecraft:daytime'\n...query daytime<--[HERE]"
            : "The time is 6000";
    }
    if (line === "time query minecraft:day" && events.atLeast(world.version, [26, 1]))
        return "Timeline minecraft:day is at 6000 tick(s)";
    if (world.renamedRules && /^gamerule do\w+$/.test(line))
        return "Unknown or incomplete command, see below for error";
    if (line === "gamerule advance_time" || line === "gamerule advance_weather") {
        return world.renamedRules
            ? `Gamerule ${line.slice(9)} is currently set to: ${world.daylightCycle}`
            : "Unknown or incomplete command, see below for error";
    }
    if (line === "gamerule doDaylightCycle")
        return `Gamerule doDaylightCycle is currently set to: ${world.daylightCycle}`;
    if (line === "gamerule doInsomnia")
        return `Gamerule doInsomnia is currently set to: ${world.insomnia}`;
    if (line === "gamerule spawn_phantoms") {
        return world.renamedRules
            ? `Gamerule spawn_phantoms is currently set to: ${world.insomnia}`
            : "Unknown or incomplete command, see below for error";
    }
    const ruleSet =
        /^gamerule (doDaylightCycle|advance_time|doInsomnia|spawn_phantoms) (true|false)$/.exec(
            line
        );
    if (ruleSet) {
        const [, name, value] = ruleSet as unknown as [string, string, "true" | "false"];
        if (world.renamedRules !== !name.startsWith("do"))
            return "Unknown or incomplete command, see below for error";
        if (name === "doInsomnia" || name === "spawn_phantoms") world.insomnia = value;
        else world.daylightCycle = value;
        return `Gamerule ${name} is now set to: ${value}`;
    }
    // The game's own tick count, twenty a second.
    if (line === "time query gametime")
        return `The time is ${Math.floor(Date.now() / 50) % 2147483647}`;
    if (line.startsWith("execute as @a[gamemode=!survival,gamemode=!adventure]")) {
        return world.creative
            .map((name) => `${name} has the following entity data: [0.0d, 64.0d, 0.0d]`)
            .join("\n");
    }
    if (line === "execute as @a run data get entity @s Dimension") {
        return world.online
            .map(
                (name) =>
                    `${name} has the following entity data: ${dimension(world.dims[name] ?? "minecraft:overworld")}`
            )
            .join("\n");
    }
    const counted = /^execute as @a run scoreboard players get @s (pe_hurt|pe_hit)$/.exec(line);
    if (counted) {
        return world.online
            .map(
                (name) =>
                    `${name} has ${(counted[1] === "pe_hurt" ? world.hurt : world.dealt)[name] ?? 0} [${counted[1]}]`
            )
            .join("\n");
    }
    if (line.includes("as @a[distance=0..] run data get entity @s Pos")) {
        return world.online
            .filter((name) => (world.dims[name] ?? "minecraft:overworld") === "minecraft:overworld")
            .map((name, index) => {
                const at = world.at[name] ?? [index * 10 + step, 64, 0];
                // As the game writes a double: `64.0d`, `10.5d`.
                const [x, y, z] = at.map((value) =>
                    Number.isInteger(value) ? value.toFixed(1) : value
                );
                return `${name} has the following entity data: [${x}d, ${y}d, ${z}d]`;
            })
            .join("\n");
    }
    if (line === "execute as @a run data get entity @s Pos") {
        step += 1;
        return world.online
            .map((name, index) =>
                world.still.includes(name)
                    ? `${name} has the following entity data: [100.0d, 64.0d, 100.0d]`
                    : `${name} has the following entity data: [${index * 10 + step}d, 64.0d, 0.0d]`
            )
            .join("\n");
    }
    if (line === "execute as @a run data get entity @s Rotation") {
        return world.online
            .map((name) =>
                world.still.includes(name)
                    ? `${name} has the following entity data: [10.0f, 0.0f]`
                    : `${name} has the following entity data: [${(step * 37) % 360}f, 0.0f]`
            )
            .join("\n");
    }
    if (line === "execute as @a run scoreboard players get @s pe_score") {
        return world.online
            .filter((name) => world.scores[name] !== undefined)
            .map((name) => `${name} has ${world.scores[name]} [${world.scoreTitle}]`)
            .join("\n");
    }
    const one = /^scoreboard players get (\S+) pe_score$/.exec(line);
    if (one) {
        const name = one[1] as string;
        return world.scores[name] !== undefined
            ? `${name} has ${world.scores[name]} [${world.scoreTitle}]`
            : `Can't get value of pe_score for ${name}; none is set`;
    }
    // The heightmap under the trees: water stops it too, and the ground check refuses that.
    // The way to a place, judged all at once.
    if (line === "kill @e[tag=pe_path]") {
        world.path = [];
        return "";
    }
    const pathStep =
        /positioned (-?[\d.]+) 0 (-?[\d.]+) positioned over .* run summon .*"pe_path"/.exec(line);
    if (pathStep) {
        world.path.push([Number(pathStep[1]), Number(pathStep[2])]);
        return "Summoned new Armor Stand";
    }
    if (line.startsWith("execute as @e[tag=pe_path]")) {
        const wet = line.includes("minecraft:water");
        return world.path
            .filter(
                ([x, z]) =>
                    !wet || (world.sea && !onIsland(String(Math.floor(x)), String(Math.floor(z))))
            )
            .map(([x, z]) => `Armor Stand has the following entity data: [${x}d, 70.0d, ${z}d]`)
            .join("\n");
    }
    // The columns of a place, judged all at once.
    if (line === "kill @e[tag=pe_samp]") {
        world.samples = [];
        return "";
    }
    const sample =
        /positioned (-?[\d.]+) 0 (-?[\d.]+) positioned over .* run summon .*"pe_samp"/.exec(line);
    if (sample) {
        if (world.allWater) return "";
        world.samples.push([Number(sample[1]), Number(sample[2])]);
        return "Summoned new Armor Stand";
    }
    if (line.startsWith("execute as @e[tag=pe_samp]")) {
        const listed = (picked: [number, number][]) =>
            picked
                .map(([x, z]) => `Armor Stand has the following entity data: [${x}d, 70.0d, ${z}d]`)
                .join("\n");
        const wet = world.samples.filter(
            ([x, z]) => world.sea && !onIsland(String(Math.floor(x)), String(Math.floor(z)))
        );
        if (line === "execute as @e[tag=pe_samp] run data get entity @s Pos")
            return listed(world.samples);
        if (line.includes("if block ~ ~-1 ~ minecraft:water")) return listed(wet);
        // A tree, as every other block test answers: whatever the protected-area switch says.
        if (line.includes("if block ~ ~-1 ~ #minecraft:"))
            return world.refuseBlocks ? "" : listed(world.samples);
        const refused = world.refusedGround.find(
            (id) => line.includes(`minecraft:${id} `) || line.includes(`minecraft:${id} run`)
        );
        if (refused) return `Unknown block type 'minecraft:${refused}'`;
        if (world.unsureGround > 0) {
            world.unsureGround -= 1;
            return "That position is not loaded";
        }
        return listed(world.built ? world.samples : wet);
    }
    if (line.includes("positioned over motion_blocking_no_leaves") && line.includes("pe_mark")) {
        if (world.allWater) return "No entity was found";
        const over = /positioned (-?[\d.]+) 0 (-?[\d.]+) positioned over/.exec(line);
        if (world.markFollows && over) {
            world.markAt = [Math.floor(Number(over[1])), Math.floor(Number(over[2]))];
            return `Teleported Armor Stand to ${over[1]}, 70.0, ${over[2]}`;
        }
        return `Teleported Armor Stand to ${world.markAt[0]}.500000, 70.000000, ${world.markAt[1]}.500000`;
    }
    if (line.includes("spreadplayers") && line.includes("pe_mark") && world.allWater) {
        return "Could not spread 1 entity around 300, 0 (too many entities for space - try using spread of at most 0.0)";
    }
    if (world.markFollows) {
        const spread = /spreadplayers (-?\d+) (-?\d+) 0 1 false @e\[tag=pe_mark\]$/.exec(line);
        if (spread) {
            world.markAt = [Number(spread[1]), Number(spread[2])];
            return `Spread 1 entity around ${spread[1]}.5, ${spread[2]}.5 with an average distance of 0 blocks apart`;
        }
        if (line.startsWith("data get entity @e[tag=pe_mark"))
            return `Armor Stand has the following entity data: [${world.markAt[0]}.5d, 70.0d, ${world.markAt[1]}.5d]`;
        const hidden =
            /if block (\S+ \S+ \S+) minecraft:air run setblock \S+ \S+ \S+ minecraft:chest\{LootTable:"[^"]+"\} keep$/.exec(
                line
            );
        if (hidden) {
            world.chestTable = /LootTable:"([^"]+)"/.exec(line)![1]!;
            if (!world.solid && !world.chests.includes(hidden[1]!)) world.chests.push(hidden[1]!);
            return world.solid ? "Test failed" : "Changed the block";
        }
        const taken =
            /if block (\S+ \S+ \S+) minecraft:chest if data block \S+ \S+ \S+ LootTable run setblock \S+ \S+ \S+ minecraft:air replace$/.exec(
                line
            );
        if (taken) {
            const at = taken[1]!;
            if (world.chests.includes(at) && !world.opened.includes(at))
                world.chests = world.chests.filter((one) => one !== at);
            return "";
        }
        const unopened =
            /^execute in minecraft:overworld if data block (\S+ \S+ \S+) LootTable$/.exec(line);
        if (unopened) {
            const at = unopened[1]!;
            return world.chests.includes(at) && !world.opened.includes(at)
                ? "Test passed"
                : "Test failed";
        }
    }
    if (line.includes("spreadplayers") && line.includes("pe_mark"))
        return `Spread 1 entity around ${world.markAt[0]}.5, ${world.markAt[1]}.5 with an average distance of 0 blocks apart`;
    // Over open water everywhere the heightmap finds no ground: nothing was summoned.
    if (line.startsWith("data get entity @e[tag=pe_mark") && world.allWater)
        return "No entity was found";
    if (line.startsWith("data get entity @e[tag=pe_mark"))
        return `Armor Stand has the following entity data: [${world.markAt[0]}.5d, 70.0d, ${world.markAt[1]}.5d]`;
    if (line.includes("if data block") && line.includes("LootTable")) {
        world.chestChecks += 1;
        return world.chestChecks > world.chestOpenedAfter ? "Test failed" : "Test passed";
    }
    if (line.includes("sort=nearest"))
        return `${world.online[0]} has the following entity data: [301.0d, 70.0d, 1.0d]`;
    if (line.startsWith("give ")) {
        const given = /^give (\S+) (.+?)(?: (\d+))?$/.exec(line)!;
        const [name, item, count = "1"] = [given[1]!, given[2]!, given[3]];
        if (!itemReadable(item))
            return refuse(line, "Expected whitespace to end one argument, but found trailing data");
        if (world.unknownItems.includes(item)) return `Unknown item '${item}'`;
        if (!world.online.includes(name)) return "No player was found";
        // 1.17 on: at most a hundred stacks in one give; a sword stacks to one.
        if (item.endsWith("_sword") && Number(count) > 100)
            return "Can't give more than 100 of [Diamond Sword]";
        // What does not fit falls at their feet, and the game still says "Gave".
        const bag = world.bag[name];
        if (bag) {
            const fits = Math.min(Number(count), world.room[name] ?? Number(count));
            world.room[name] = (world.room[name] ?? fits) - fits;
            // Counted by the item alone, whatever name or data the stack carries.
            const id = item.replace(/[[{].*$/, "");
            bag[id] = (bag[id] ?? 0) + fits;
        }
        return `Gave ${count} [Item] to ${name}`;
    }
    const levels = /^xp add (\S+) (\d+) levels$/.exec(line);
    if (levels) {
        if (!world.online.includes(levels[1]!)) return "No player was found";
        world.levels[levels[1]!] = (world.levels[levels[1]!] ?? 0) + Number(levels[2]);
        return `Gave ${levels[2]} experience levels to ${levels[1]}`;
    }
    const addPoints = /^xp add (\S+) (\d+) points$/.exec(line);
    if (addPoints) {
        if (!world.online.includes(addPoints[1]!)) return "No player was found";
        world.points[addPoints[1]!] = (world.points[addPoints[1]!] ?? 0) + Number(addPoints[2]);
        return `Gave ${addPoints[2]} experience points to ${addPoints[1]}`;
    }
    const level = /^xp query (\S+) levels$/.exec(line);
    if (level)
        return world.online.includes(level[1]!)
            ? `${level[1]} has ${world.levels[level[1]!] ?? 0} experience levels`
            : "No player was found";
    const point = /^xp query (\S+) points$/.exec(line);
    if (point)
        return world.online.includes(point[1]!)
            ? `${point[1]} has ${world.points[point[1]!] ?? 0} experience points`
            : "No player was found";
    const setXp = /^xp set (\S+) (\d+) (levels|points)$/.exec(line);
    if (setXp) {
        if (!world.online.includes(setXp[1]!)) return "No player was found";
        (setXp[3] === "levels" ? world.levels : world.points)[setXp[1]!] = Number(setXp[2]);
        return `Set ${setXp[2]} experience ${setXp[3]} on ${setXp[1]}`;
    }
    // Somebody sent home is on the ground, unless still in the air.
    const airborne =
        /^execute as (\w+) at @s if block ~ ~-0\.2 ~ minecraft:air if block ~ ~-1\.2 ~ minecraft:air$/.exec(
            line
        );
    if (airborne) return world.aloft.includes(airborne[1]!) ? "Test passed" : "Test failed";
    if (line === "data get entity @e[tag=pe_boss,limit=1] Health")
        return world.bossAlive
            ? `Wither Skeleton has the following entity data: ${world.bossHealth}.0f`
            : "No entity was found";
    if (
        / as @a\[distance=\.\.40,scores=\{pe_shot=1\.\.\}\] run scoreboard players get @s pe_shot$/.test(
            line
        )
    )
        return world.shooters.map((name) => `${name} has 1 [pe_shot]`).join("\n");
    if (/ as @a\[distance=\.\.40\] run scoreboard players get @s pe_raw$/.test(line)) {
        const near = Object.entries(world.raw);
        world.raw = {};
        return near.map(([name, raw]) => `${name} has ${raw} [pe_raw]`).join("\n");
    }
    if (line === "execute if entity @e[tag=pe_boss]")
        return world.bossAlive ? "Test passed, count: 1" : "Test failed";
    if (line === "data get entity @e[tag=pe_boss,limit=1] Pos") {
        return world.bossAlive
            ? "Wither Skeleton has the following entity data: [310.5d, 70.0d, 4.5d]"
            : "No entity was found";
    }
    if (line.startsWith("execute as @a[scores={pe_kill=1..}]")) {
        const [x, y, z] = world.killerAt;
        return world.bossAlive
            ? ""
            : `${world.online[0]} has the following entity data: [${x}.0d, ${y}.0d, ${z}.0d]`;
    }
    if (line.includes("dx=12,dy=384,dz=12")) {
        return world.arrived
            ? `${world.online[1]} has the following entity data: [1.0d, 64.0d, 1.0d]`
            : "";
    }
    const rule = /^gamerule (doDaylightCycle|doWeatherCycle)$/.exec(line);
    if (rule) return `Gamerule ${rule[1]} is currently set to: true`;
    if (line.startsWith("attribute "))
        return "Set base value of attribute Max Health for entity Boss to 400.0";
    if (line === "execute as @a[scores={pe_rdc=1..,pe_rfr=1..}] run data get entity @s Pos") {
        const caught = world.caught;
        world.caught = [];
        return caught
            .map((name) => `${name} has the following entity data: [1.0d, 63.0d, 1.0d]`)
            .join("\n");
    }
    if (line === "execute as @a run scoreboard players get @s pe_prog") {
        return world.online
            .map((name) => `${name} has ${world.progress[name] ?? 0} [pe_prog]`)
            .join("\n");
    }
    if (line === "execute as @a run scoreboard players get @s pe_death") {
        return Object.entries(world.deaths)
            .map(([name, count]) => `${name} has ${count} [pe_death]`)
            .join("\n");
    }
    // Any other block test: whatever the protected-area switch says.
    if (line.startsWith("execute in minecraft:overworld if block "))
        return world.refuseBlocks ? "Test failed" : "Test passed";
    return "";
}

/** What small wild plant grows at a spot, if any. */
function plantAt(at: string): string | undefined {
    if (world.plants.has(at)) return world.plants.get(at);
    return world.grass && !world.chests.includes(at) && !world.blocks.has(at)
        ? "short_grass"
        : undefined;
}

/** Whether a column is on the island of `dryWithin`, when there is one. */
function onIsland(x: string, z: string): boolean {
    return world.dryWithin > 0 && Math.hypot(Number(x), Number(z)) <= world.dryWithin;
}

/** Who carries a tag. */
function tagged(tag: string): Set<string> {
    return (world.tags[tag] ??= new Set());
}

/**
 * A line as the server takes it and its answer as RCON hands it back: display
 * names, answers run together, and at most one 4096-character packet - or, when
 * that packet is more than 4096 bytes, nothing but the console tool's complaint.
 * The event's page tags are the game's too.
 */
function heard(line: string): string {
    const page = /^(.*)\[(?:(.*),)?tag=!pe_seen,limit=20\] run tag @s add pe_page$/.exec(line);
    if (page) {
        world.sent.push(line);
        const next = world.online.filter((name) => !tagged("pe_seen").has(name)).slice(0, 20);
        for (const name of next) tagged("pe_page").add(name);
        return next.map((name) => `Added tag 'pe_page' to ${name}`).join(world.glued ? "" : "\n");
    }
    const tagging = /^tag @a(\[tag=(pe_\w+)\])? (add|remove) (pe_\w+)$/.exec(line);
    if (tagging) {
        world.sent.push(line);
        const who = tagging[2] ? [...tagged(tagging[2])] : world.online;
        for (const name of who) {
            if (tagging[3] === "add") tagged(tagging[4]!).add(name);
            else tagged(tagging[4]!).delete(name);
        }
        return "";
    }
    if (line === "list uuids") {
        world.sent.push(line);
        return `There are ${world.online.length} of a max of 100 players online: ${world.online
            .map(
                (name, index) =>
                    `${name} (00000000-0000-0000-0000-${String(index).padStart(12, "0")})`
            )
            .join(", ")}`;
    }
    let out: string;
    if (/tag=pe_page\]/.test(line)) {
        const whole = line.replace(",tag=pe_page]", "]").replace("[tag=pe_page]", "");
        const inPage = tagged("pe_page");
        out = answer(whole)
            .split("\n")
            .filter((entry) => inPage.has(/^(\S+) has /.exec(entry)?.[1] ?? ""))
            .join("\n");
        world.sent[world.sent.length - 1] = line;
    } else out = answer(line);
    for (const [name, [before, after]] of Object.entries(world.display))
        out = out.replace(
            new RegExp(`(^|\\n)${name} has `, "g"),
            `$1${before}${name}${after} has `
        );
    if (world.glued) out = out.replace(/\n(?=\S+.* has )/g, "");
    if (out.length > 4096) {
        const first = out.slice(0, 4096);
        out = /[^\x00-\x7f]/.test(first)
            ? "Failed to read command: rcon: response too long\n"
            : first;
    }
    return out;
}

const server = {
    installedAppId: "s",
    applicationId: "a",
    edition: "java",
    running: true,
    say: async (argv: readonly string[]) => heard(argv.join(" ")),
    sayAll: async (lines: readonly string[]) => {
        for (const line of lines) heard(line);
    },
    run: async (argv: readonly string[]) => {
        if (argv[0] === "stat") return { code: 0, output: String(world.log.length) };
        // The shell reads the line out of whichever file it looks in.
        const script = argv.join(" ");
        const looks =
            world.versionIn === "latest"
                ? script.includes("latest.log")
                : world.versionIn === "archive" && script.includes(".log.gz");
        return {
            code: 0,
            output: looks ? `Starting minecraft server version ${world.version}` : ""
        };
    },
    runOk: async () => "",
    readFile: async () => new ReadableStream(),
    trimWorld: null
};

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({
                ownerId: "owner",
                name: "ExampleSMP",
                catalogId: "minecraft",
                status: "running",
                config: JSON.stringify(config)
            }),
            findMany: async () => [
                { id: SERVER, ownerId: "owner", config: JSON.stringify(config) }
            ],
            updateMany: async ({
                where,
                data
            }: {
                where: { config: string };
                data: { config: string };
            }) => {
                if (where.config !== JSON.stringify(config)) return { count: 0 };
                config = JSON.parse(data.config) as Record<string, unknown>;
                return { count: 1 };
            }
        },
        minecraftAnticheatFlag: {
            groupBy: async () => world.flagged.map((player) => ({ player }))
        },
        gamePlayerLink: {
            findMany: async () =>
                Object.entries(world.links).map(([player, userId]) => ({ player, userId }))
        },
        eventInventoryStash: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const id = `00000000-0000-7000-8000-${String(stashRows.size + 1).padStart(12, "0")}`;
                stashRows.set(id, { ...data, id, dismissedAt: null, updatedAt: new Date() });
                return { id };
            },
            delete: async ({ where }: { where: { id: string } }) => {
                stashRows.delete(where.id);
                return {};
            },
            deleteMany: async ({ where }: { where: { id: string } }) => {
                if (stashDeleteFails) throw new Error("database unavailable");
                return { count: stashRows.delete(where.id) ? 1 : 0 };
            },
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                const row = stashRows.get(where.id);
                if (row) stashRows.set(where.id, { ...row, ...data, updatedAt: new Date() });
                return row ?? {};
            },
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                const row = stashRows.get(where.id);
                if (row) stashRows.set(where.id, { ...row, ...data });
                return { count: row ? 1 : 0 };
            },
            findUnique: async ({ where }: { where: { id: string } }) =>
                stashRows.get(where.id) ?? null,
            findFirst: async ({ where }: { where: { id: string; status?: string } }) => {
                const row = stashRows.get(where.id);
                return row && (!where.status || row.status === where.status) ? row : null;
            },
            findMany: async ({ where }: { where: { status?: string } }) =>
                [...stashRows.values()].filter(
                    (row) => (!where.status || row.status === where.status) && !row.dismissedAt
                )
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string | null) =>
                raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            // Where a slot write remembers which spelling of `item` the server took.
            patchInstallConfig: async () => undefined
        },
        i18nLocaleService: {
            getUserLocale: async (userId: string) => world.locales[userId] ?? "en-US",
            storedLocale: async (userId: string) => world.locales[userId] ?? null
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: (catalogId: string) => (catalogId.includes("bedrock") ? "bedrock" : "java"),
    openServerContainer: async () => ({ server, close: async () => undefined }),
    withServerContainer: async (
        _owner: string,
        _id: string,
        work: (s: typeof server) => Promise<unknown>
    ) => work(server)
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-display-service", () => ({
    holdSidebar: (id: string) => held.push(id),
    releaseSidebar: (_owner: string, id: string) => released.push(id)
}));

vi.mock("@polaris-app/game-servers/src/lib/container-files", () => ({
    readContainerRange: async (_server: unknown, _file: string, from: number, to: number) =>
        world.log.slice(from, to),
    readContainerFile: async (_server: unknown, path: string) =>
        path.endsWith("server.properties") ? world.properties : null,
    readContainerFiles: async (_server: unknown, paths: readonly string[]) =>
        new Map(
            paths.flatMap((path) => {
                const content = world.files.get(path);
                return content === undefined ? [] : [[path, content] as const];
            })
        ),
    writeContainerFile: async (_server: unknown, path: string, content: string) => {
        world.writes.push(path);
        world.files.set(path, content);
    },
    containerFileSize: async () => world.log.length
}));

const SERVER = "00000000-0000-4000-8000-000000000001";
const catalog = await import("@polaris-app/game-servers/src/lib/minecraft/events/catalog");

/**
 * A new event as these runs were written against it: the prizes and the length
 * every kind started with before they were set by kind. Stored with this
 * version's defaults marker, so nothing is migrated under them.
 */
function newPreset(kind: catalog.EventKind, id: string): catalog.EventPreset {
    const made = catalog.newPreset(kind, id);
    return {
        ...made,
        minutes: catalog.oldDefaultMinutes(kind),
        rewards: catalog.KIND_INFO[kind].competitive ? catalog.OLD_DEFAULT_REWARDS : made.rewards
    };
}
const events = await import("@polaris-app/game-servers/src/lib/minecraft/events/events-service");
const speechService = await import("@polaris-app/game-servers/src/lib/minecraft/speech-service");
const triviaBank = await import("@polaris-app/game-servers/src/lib/minecraft/events/trivia-bank");
const { readEventState } = await import("@polaris-app/game-servers/src/lib/minecraft/events/state");
const { gameMessageIn } = await import("@polaris-app/game-servers/src/lib/game-message");
const commands = await import("@polaris-app/game-servers/src/lib/minecraft/events/commands");
const eventMessages = await import("@polaris-app/game-servers/src/lib/minecraft/events/messages");
const plan = await import("@polaris-app/game-servers/src/lib/minecraft/events/plan");
const build = await import("@polaris-app/game-servers/src/lib/minecraft/events/kinds/build-battle");
const boss = await import("@polaris-app/game-servers/src/lib/minecraft/events/kinds/boss");
const hill = await import("@polaris-app/game-servers/src/lib/minecraft/events/kinds/hill");
const hillService = await import(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hill-service"
);
const playing = await import("@polaris-app/game-servers/src/lib/minecraft/activity");
const arrival = await import("@polaris-app/game-servers/src/lib/minecraft/events/kinds/arrival");

/** What a player reads of a command's text: the words of its JSON, without the
 *  formatting that splits them into parts (a highlighted name, a number). */
function visible(line: string): string {
    // The JSON after the command and its target (which may hold brackets itself).
    const at = line.search(/ [[{"]/) + 1;
    if (at < 1) return line;
    const walk = (node: unknown): string => {
        if (typeof node === "string") return node;
        if (Array.isArray(node)) return node.map(walk).join("");
        if (node && typeof node === "object") {
            const part = node as { text?: unknown; extra?: unknown };
            return walk(part.text ?? "") + walk(part.extra ?? []);
        }
        return "";
    };
    try {
        return line.slice(0, at) + walk(JSON.parse(line.slice(at)));
    } catch {
        return line;
    }
}

/** What a refusal says to an English reader: the service carries catalog keys. */
async function refusal(promise: Promise<unknown>): Promise<string | null> {
    try {
        await promise;
    } catch (error) {
        return gameMessageIn("en-US", (error as Error).message);
    }
    return null;
}

function setUp(
    presets: catalog.EventPreset[],
    settings: Partial<catalog.EventSettings> = {},
    schedules: catalog.EventScheduleEntry[] = []
) {
    config = {
        [catalog.EVENTS_KEY]: {
            settings: { ...catalog.settingsSchema.parse({}), countdownSeconds: 0, ...settings },
            presets,
            schedules
        }
    };
}

const state = () => readEventState(config);

/** Advance the clock, letting the loop's ticks run in between. */
async function play(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-09-28T20:00:00Z") });
    world.online = ["Ana", "Ben"];
    world.pressed = {};
    world.scores = {};
    world.chestOpenedAfter = 3;
    world.chestChecks = 0;
    world.flagged = [];
    world.sent = [];
    world.log = "";
    world.bossAlive = true;
    world.deaths = {};
    world.arrived = false;
    world.allWater = false;
    world.sea = false;
    world.dryWithin = 0;
    world.killerAt = [305, 70, 2];
    world.unknownItems = [];
    world.dims = {};
    world.hurt = {};
    world.dealt = {};
    world.still = [];
    world.creative = [];
    world.difficulty = "Normal";
    world.daylightCycle = "true";
    world.insomnia = "true";
    world.inv = {};
    stashRows.clear();
    stashDeleteFails = false;
    world.containers = new Map();
    world.drops = new Map();
    world.pickUp = false;
    world.checkpoint = {};
    world.finishTick = {};
    world.renamedRules = false;
    world.built = false;
    world.refusedGround = [];
    world.unsureGround = 0;
    world.homes = {};
    world.homeWorlds = {};
    world.markFollows = false;
    world.markAt = [300, 0];
    world.plants = new Map();
    world.grass = false;
    world.samples = [];
    world.path = [];
    world.chests = [];
    world.chestTable = "";
    world.opened = [];
    world.solid = false;
    world.caught = [];
    world.progress = {};
    world.keepInventory = "false";
    world.forced = "No force loaded chunks were found in minecraft:overworld";
    world.defenders = [];
    world.waveAlive = 0;
    world.hits = {};
    world.blocks = new Map();
    world.nearMeteor = false;
    world.inside = new Set();
    world.at = {};
    world.stuck = [];
    world.modes = {};
    world.skyTaken = false;
    world.properties = "pvp=true\ndifficulty=normal\n";
    world.files = new Map();
    world.writes = [];
    world.packsFound = new Set();
    world.packsOn = new Set();
    world.solidCount = 0;
    world.refuseBlocks = false;
    world.hp = {};
    world.dealt = {};
    world.died = {};
    world.pk = {};
    world.version = "1.21.4";
    world.versionIn = "latest";
    world.refused = [];
    world.bossName = "";
    world.bossMaxHealth = 0;
    world.bukkit = false;
    world.essentials = false;
    world.pluginGot = [];
    world.glued = false;
    world.display = {};
    world.scoreTitle = "Event title";
    world.tags = {};
    world.links = {};
    world.locales = {};
    world.bag = {};
    world.room = {};
    world.levels = {};
    world.points = {};
    world.bossHealth = 400;
    world.raw = {};
    world.shooters = [];
    world.mobGriefing = "true";
    world.fighters = [];
    world.minionsLeft = 0;
    world.lift = [];
    world.fighterGap = 2;
    world.bossBoxed = false;
    speechService.forget(SERVER);
    world.stormTicks = 0;
    events.forgetPlayers();
    held.length = 0;
    released.length = 0;
});

afterEach(async () => {
    for (const id of events.runningEvents()) {
        await events.cancelEvent("owner", id).catch(() => undefined);
    }
    await play(10_000);
    vi.useRealTimers();
});

describe("operators' chat", () => {
    it("is kept clear of the event's commands while it runs, and given back after", async () => {
        setUp([{ ...newPreset("mining-rush", "rush"), minutes: 3 }], {
            countdownSeconds: 10
        });
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        // Written down before it is turned off, so any end puts it back.
        expect(state().run?.gamerules).toEqual({ sendCommandFeedback: "true" });
        const off = world.sent.indexOf("gamerule sendCommandFeedback false");
        expect(off).toBeGreaterThanOrEqual(0);
        expect(off).toBeLessThan(world.sent.findIndex((line) => line.startsWith("bossbar add")));
        await play(4 * 60_000);
        expect(state().run).toBeNull();
        expect(
            world.sent.filter((line) => line.startsWith("gamerule sendCommandFeedback ")).at(-1)
        ).toBe("gamerule sendCommandFeedback true");
    });
});

describe("the boss bar's clock", () => {
    it("moves every second through the start, with no second standing still in between", async () => {
        // Eleven seconds: the countdown ends between two ticks, as it does on a
        // real server, where starting takes a moment of its own.
        setUp([{ ...newPreset("mining-rush", "rush"), minutes: 3 }], {
            countdownSeconds: 11
        });
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        const shown: (string | null)[] = [];
        for (let second = 0; second < 16; second += 1) {
            const from = world.sent.length;
            await play(1_000);
            const names = world.sent
                .slice(from)
                .filter((line) => line.startsWith("bossbar set polaris:event name"));
            shown.push(names.at(-1) ?? null);
        }
        // From the first second the bar is up, every second shows it again.
        expect(shown.slice(2).every((one) => one !== null)).toBe(true);
    });
});

describe("a mining rush, from start to podium", () => {
    it("counts, ranks, hands prizes to who is on and keeps the rest", async () => {
        const rush = { ...newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: "u1"
        });
        expect(state().run?.phase).toBe("countdown");

        await play(2_100);
        expect(state().run?.phase).toBe("running");
        expect(held).toContain(SERVER);
        expect(world.sent).toContain("scoreboard objectives setdisplay sidebar pe_score");
        expect(
            world.sent.some((line) =>
                line.startsWith("scoreboard objectives add pe_c0 minecraft.mined:")
            )
        ).toBe(true);

        world.scores = { Ana: 30, Ben: 12 };
        // Ben leaves before the end; his score is still read, by name.
        await play(60_000);
        world.online = ["Ana"];
        await play(3 * 60_000);

        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({ outcome: "finished", presetId: "rush" });
        expect(after.history[0]?.podium).toEqual([
            { place: 1, name: "Ana", score: 30 },
            { place: 2, name: "Ben", score: 12 }
        ]);
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        expect(world.sent).toContain("xp add Ana 15 levels");
        // Ben is owed second place - and no more, being on the podium - kept for
        // when he is back.
        expect(after.pending.map((one) => one.player)).toEqual(["Ben"]);
        expect(after.pending[0]?.reward.items.map((item) => item.id)).toEqual([
            "minecraft:diamond"
        ]);
        // Everything the event made is taken down, and the side panel given back.
        expect(world.sent).toContain("scoreboard objectives remove pe_score");
        expect(world.sent).toContain("bossbar remove polaris:event");
        expect(released).toContain(SERVER);
    });

    it("leaves somebody the anti-cheat caught off the podium and the prizes", async () => {
        const rush = { ...newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 50, Ben: 14 };
        world.flagged = ["ana"];
        await play(3 * 60_000);
        const entry = state().history[0];
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 14 }]);
        expect(entry?.disqualified).toEqual(["Ana"]);
        expect(world.sent.some((line) => line.startsWith("give Ana"))).toBe(false);
    });
});

/** Every chunk a `forceload remove` sent to the server let go of, as `x,z`. */
function chunksLetGo(): Set<string> {
    const gone = new Set<string>();
    for (const line of world.sent) {
        const match = /forceload remove (-?\d+) (-?\d+)(?: (-?\d+) (-?\d+))?$/.exec(line);
        if (!match) continue;
        const [x1, z1] = [Number(match[1]), Number(match[2])];
        const [x2, z2] = [Number(match[3] ?? match[1]), Number(match[4] ?? match[2])];
        for (let x = Math.min(x1, x2) >> 4; x <= Math.max(x1, x2) >> 4; x += 1)
            for (let z = Math.min(z1, z2) >> 4; z <= Math.max(z1, z2) >> 4; z += 1)
                gone.add(`${x},${z}`);
    }
    return gone;
}

describe("chunks somebody else keeps loaded", () => {
    it("are never let go of by an event that loaded ground over them", async () => {
        // The operator keeps the chunk the drop lands in, and one next to it,
        // loaded for a farm: judging the ground loads an area over both and
        // lets it go again, and the end lets the drop's own chunk go.
        world.forced =
            "2 force loaded chunks were found in minecraft:overworld at: [18, 0], [18, -1]";
        setUp([{ ...newPreset("supply-drop", "drop"), minutes: 10 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(30_000);
        expect(state().history[0]?.note).toBe("Found by Ana");
        expect(world.sent.some((line) => line.includes("forceload add"))).toBe(true);
        const gone = chunksLetGo();
        expect(gone.has("18,0")).toBe(false);
        expect(gone.has("18,-1")).toBe(false);
        // What the event loaded itself round them is still let go of.
        expect(gone.has("19,0")).toBe(true);
    });
});

describe("the chunks an event loads", () => {
    it("are all let go of at the end, wherever the marker came down", async () => {
        // The marker lands at 300 0, chunks away from the column tried, on
        // somebody's build at first - given up - and later, elsewhere, on
        // open ground.
        world.built = true;
        setUp([{ ...newPreset("supply-drop", "drop"), minutes: 10 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(6_100);
        world.built = false;
        world.markAt = [500, 0];
        await play(30_000);
        expect(state().history[0]?.note).toBe("Found by Ana");
        // Every add and remove played back in order, as the game keeps them.
        const held = new Set<string>();
        for (const line of world.sent) {
            const match = /forceload (add|remove) (-?\d+) (-?\d+)(?: (-?\d+) (-?\d+))?$/.exec(line);
            if (!match) continue;
            const [x1, z1] = [Number(match[2]), Number(match[3])];
            const [x2, z2] = [Number(match[4] ?? match[2]), Number(match[5] ?? match[3])];
            for (let x = Math.min(x1, x2) >> 4; x <= Math.max(x1, x2) >> 4; x += 1)
                for (let z = Math.min(z1, z2) >> 4; z <= Math.max(z1, z2) >> 4; z += 1) {
                    if (match[1] === "add") held.add(`${x},${z}`);
                    else held.delete(`${x},${z}`);
                }
        }
        expect(world.sent.some((line) => line.endsWith("forceload add 300 0"))).toBe(true);
        expect([...held]).toEqual([]);
    });
});

describe("a supply drop", () => {
    it("lands on dry ground, is told in steps, and goes to whoever opens it", async () => {
        const drop = { ...newPreset("supply-drop", "drop"), minutes: 10 };
        setUp([drop]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(30_000);

        expect(
            world.sent.some((line) =>
                line.startsWith("execute in minecraft:overworld run forceload add")
            )
        ).toBe(true);
        expect(
            world.sent.some((line) =>
                line.includes(
                    'setblock 300 70 0 minecraft:chest{LootTable:"minecraft:chests/buried_treasure"}'
                )
            )
        ).toBe(true);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 1 }]);
        expect(after.history[0]?.note).toBe("Found by Ana");
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        // Released; the chest stays, since what is inside is the finder's.
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove 300 0");
        const removals = world.sent.filter((line) =>
            line.includes("setblock 300 70 0 minecraft:air")
        );
        expect(removals.length).toBeGreaterThan(0);
        expect(
            removals.every((line) =>
                /if data block 300 70 0 LootTable|if block 300 70 0 minecraft:chest\{LootTable:"/.test(
                    line
                )
            )
        ).toBe(true);
    });

    it("lets go of every chunk it tried when it is called off before landing", async () => {
        // Somebody's build everywhere: no column ever takes the chest.
        world.built = true;
        const drop = { ...newPreset("supply-drop", "drop"), minutes: 10 };
        setUp([drop]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        // Begun at once: a column chosen and judged on each tick, the chest
        // never down.
        await play(4_100);
        const added = world.sent.filter((line) => line.includes("run forceload add"));
        expect(added.length).toBeGreaterThan(0);
        expect(state().run?.place).toBeNull();
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().run).toBeNull();
        for (const line of added)
            expect(world.sent).toContain(line.replace("forceload add", "forceload remove"));
    });
});

describe("starting one now", () => {
    it("skips what is left of the countdown and still runs its full time", async () => {
        const hunt = { ...newPreset("mob-hunt", "hunt"), minutes: 10 };
        setUp([hunt], { countdownSeconds: 60 });
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(state().run?.phase).toBe("countdown");
        const pressed = Date.now();
        await events.startNow("owner", SERVER);
        await play(2_100);
        const run = state().run;
        expect(run?.phase).toBe("running");
        expect(run!.startsAt).toBeLessThanOrEqual(pressed + 2_100);
        expect(run!.endsAt - run!.startsAt).toBeGreaterThanOrEqual(10 * 60_000 - 2_100);
        expect(world.sent).toContain("scoreboard objectives setdisplay sidebar pe_score");
    });

    it("says so once it has already begun", async () => {
        setUp([{ ...newPreset("mob-hunt", "hunt"), minutes: 10 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(await refusal(events.startNow("owner", SERVER))).toBe("It has already started");
    });
});

describe("calling one off", () => {
    it("ends it with nobody winning and cleans up", async () => {
        const hunt = { ...newPreset("mob-hunt", "hunt"), minutes: 10 };
        setUp([hunt]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        world.scores = { Ana: 9 };
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({ outcome: "cancelled", podium: [] });
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        expect(world.sent).toContain("scoreboard objectives remove pe_score");
    });

    it("refuses a second event while one is on", async () => {
        setUp([{ ...newPreset("fishing", "fish"), minutes: 10 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "fish",
            trigger: "manual",
            startedBy: null
        });
        const refused = await refusal(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "fish",
                trigger: "manual",
                startedBy: null
            })
        );
        expect(refused).toMatch(/another event is on/i);
    });

    it("refuses one with nobody on the server", async () => {
        world.online = [];
        setUp([{ ...newPreset("fishing", "fish"), minutes: 10 }]);
        const refused = await refusal(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "fish",
                trigger: "manual",
                startedBy: null
            })
        );
        expect(refused).toMatch(/nobody is on/i);
    });
});

describe("the minute sweep", () => {
    it("draws an event once enough people are playing, not before", async () => {
        const fish = { ...newPreset("fishing", "fish"), minutes: 5 };
        setUp([fish], {
            minActive: 2,
            random: {
                enabled: true,
                days: [],
                from: "00:00",
                to: "23:59",
                minGap: 15,
                maxGap: 15,
                pool: [{ presetId: "fish", weight: 1 }]
            }
        });
        // Armed on the first pass, a gap away.
        await events.sweepEvents();
        expect(state().nextRandomAt).toBe(Date.now() + 15 * 60_000);
        await play(15 * 60_000);
        // Due, and the players have been seen moving since the last look.
        const started = await events.sweepEvents();
        expect(started.started).toBe(1);
        expect(state().run?.trigger).toBe("random");
    });

    it("does not open an event players join with fewer on the server than must join it", async () => {
        world.online = ["Ana", "Ben"];
        setUp([{ ...newPreset("build-battle", "build"), minutes: 10 }]);
        const refused = await refusal(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "build",
                trigger: "manual",
                startedBy: null
            })
        );
        // Three builders at the least: with two on, nobody is asked to join.
        expect(refused).toBe("Only 2 players are on the server; this event needs 3");
        expect(state().run).toBeNull();
        expect(world.sent.some((line) => line.includes("bossbar add"))).toBe(false);
    });

    it("does not start with fewer players on than its minimum, and says why", async () => {
        world.online = ["Ana"];
        setUp([{ ...newPreset("mining-rush", "rush"), minutes: 3 }]);
        const refused = await refusal(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "rush",
                trigger: "manual",
                startedBy: null
            })
        );
        expect(refused).toBe("Only 1 player is on the server; this event needs 2");
        expect(state().run).toBeNull();
        expect(world.sent.some((line) => line.includes("bossbar add"))).toBe(false);
        // An operator who lets one play alone sets the minimum to one.
        setUp([{ ...newPreset("mining-rush", "rush"), minutes: 3, minPlayers: 1 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        expect(state().run?.preset.id).toBe("rush");
    });

    it("skips, not fails, a scheduled event below its own minimum", async () => {
        world.online = ["Ana", "Ben"];
        const boost = { ...newPreset("xp-boost", "boost"), minutes: 5, minPlayers: 3 };
        setUp([boost], { minActive: 1 }, [
            { id: "at8", presetId: "boost", enabled: true, days: [], at: "20:00" }
        ]);
        await events.sweepEvents();
        const entry = state().history[0];
        expect(entry).toMatchObject({ outcome: "skipped", trigger: "scheduled" });
        expect(entry?.note).toMatch(/^Skipped: [0-2] active of the 3 it waits for$/);
        expect(state().run).toBeNull();
    });

    it("skips a scheduled event when too few are playing, and says so", async () => {
        const fish = { ...newPreset("fishing", "fish"), minutes: 5 };
        world.online = ["Ana"];
        setUp([fish], { minActive: 2 }, [
            { id: "at8", presetId: "fish", enabled: true, days: [], at: "20:00" }
        ]);
        await events.sweepEvents();
        const entry = state().history[0];
        expect(entry).toMatchObject({ outcome: "skipped", trigger: "scheduled" });
        // One player on can be at most one playing - the earlier cases may
        // already have seen Ana move, which is remembered per server.
        expect(entry?.note).toMatch(/^Skipped: [01] active of the 2 it waits for$/);
        expect(state().run).toBeNull();
    });

    it("hands a waiting prize to somebody who is back", async () => {
        setUp([newPreset("fishing", "fish")], {
            random: { ...catalog.settingsSchema.parse({}).random }
        });
        config[catalog.EVENT_STATE_KEY] = {
            pending: [
                {
                    id: "p1",
                    player: "Ana",
                    reward: { items: [{ id: "minecraft:emerald", count: 2 }], levels: 0 },
                    event: "Fishing contest",
                    createdAt: Date.now()
                }
            ]
        };
        await events.sweepEvents();
        expect(world.sent).toContain("give Ana minecraft:emerald 2");
        expect(state().pending).toEqual([]);
    });

    it("gives a prize once to a player whose name reads like an error", async () => {
        world.online = ["ErrorBoy", "Unknown_1"];
        setUp([newPreset("fishing", "fish")], {
            random: { ...catalog.settingsSchema.parse({}).random }
        });
        const reward = { items: [{ id: "minecraft:emerald", count: 2 }], levels: 3 };
        config[catalog.EVENT_STATE_KEY] = {
            pending: ["ErrorBoy", "Unknown_1"].map((player, index) => ({
                id: `p${index}`,
                player,
                reward,
                event: "Fishing contest",
                createdAt: Date.now()
            }))
        };
        await events.sweepEvents();
        await events.sweepEvents();
        for (const name of ["ErrorBoy", "Unknown_1"]) {
            expect(
                world.sent.filter((line) => line === `give ${name} minecraft:emerald 2`)
            ).toHaveLength(1);
            expect(world.sent.filter((line) => line === `xp add ${name} 3 levels`)).toHaveLength(1);
        }
        expect(state().pending).toEqual([]);
    });

    it("keeps a prize the game refused as too many, rather than calling it given", async () => {
        setUp([newPreset("fishing", "fish")], {
            random: { ...catalog.settingsSchema.parse({}).random }
        });
        const reward = { items: [{ id: "minecraft:diamond_sword", count: 150 }], levels: 0 };
        config[catalog.EVENT_STATE_KEY] = {
            pending: [
                { id: "p1", player: "Ana", reward, event: "Fishing contest", createdAt: Date.now() }
            ]
        };
        await events.sweepEvents();
        expect(state().pending.map((one) => one.reward)).toEqual([reward]);
    });

    it("keeps only what did not arrive, so nothing is given twice", async () => {
        setUp([newPreset("fishing", "fish")], {
            random: { ...catalog.settingsSchema.parse({}).random }
        });
        world.unknownItems = ["minecraft:diamnd"];
        const reward = {
            items: [
                { id: "minecraft:emerald", count: 2 },
                { id: "minecraft:diamnd", count: 1 }
            ],
            levels: 5
        };
        config[catalog.EVENT_STATE_KEY] = {
            pending: [
                { id: "p1", player: "Ana", reward, event: "Fishing contest", createdAt: Date.now() }
            ]
        };
        await events.sweepEvents();
        await events.sweepEvents();
        expect(world.sent.filter((line) => line === "give Ana minecraft:emerald 2")).toHaveLength(
            1
        );
        expect(world.sent.filter((line) => line === "xp add Ana 5 levels")).toHaveLength(1);
        expect(state().pending.map((one) => one.reward)).toEqual([
            { items: [{ id: "minecraft:diamnd", count: 1 }], levels: 0 }
        ]);
    });
});

describe("trivia", () => {
    it("remembers what a game asked, and the next game asks other questions first", async () => {
        const quiz = {
            ...newPreset("trivia", "quiz"),
            options: { rounds: 3, seconds: 15, mode: "questions" as const, questions: [] }
        };
        setUp([quiz]);
        const play1 = async () => {
            await events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "quiz",
                trigger: "manual",
                startedBy: null
            });
            const run = state().run!;
            await play(4_100);
            await events.cancelEvent("owner", SERVER);
            await play(4_200);
            return run;
        };
        const first = await play1();
        const asked = state().triviaSeen;
        expect(asked.length).toBeGreaterThan(0);
        expect(asked[0]).toBe(triviaBank.ordered(first.id, [])[0]!.id);
        const second = await play1();
        expect(second.triviaSkip).toEqual(asked);
        expect(asked).not.toContain(triviaBank.ordered(second.id, second.triviaSkip)[0]!.id);
    });

    it("reads the chat for the first right answer and scores the rounds", async () => {
        const quiz = {
            ...newPreset("trivia", "quiz"),
            options: {
                rounds: 3,
                seconds: 15,
                mode: "questions" as const,
                questions: [{ question: "Which green mob explodes?", answers: ["creeper"] }]
            }
        };
        setUp([quiz]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "quiz",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw @a") && line.includes("Which green mob explodes?")
            )
        ).toBe(true);
        // On screen too: the title as it is asked, and above the hotbar with the time left.
        expect(
            world.sent.some(
                (line) => line.startsWith("title @a title") && line.includes("Question 1/3")
            )
        ).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("title @a subtitle") &&
                    line.includes("Which green mob explodes?")
            )
        ).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("title @a actionbar") &&
                    line.includes("Which green mob explodes?") &&
                    line.includes(" s)")
            )
        ).toBe(true);
        world.log +=
            "[20:00:05] [Server thread/INFO]: <Ana> zombie\n[20:00:06] [Server thread/INFO]: <Ben> Creeper!\n";
        await play(2_100);
        expect(state().run?.points).toEqual({ Ben: 1 });
        expect(world.sent).toContain("scoreboard players set Ben pe_score 1");
        expect(
            world.sent.some(
                (line) => line.startsWith("title @a title") && line.includes("Ben got it")
            )
        ).toBe(true);
        // The other two rounds nobody answers, and the game ends on its own.
        await play(2 * (15_000 + 6_000) + 10_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("All rounds played");
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ben", score: 1 }]);
    });

    it("asks true or false with buttons, takes a click or a typed letter once, and gives a tie to the faster", async () => {
        const quiz = {
            ...newPreset("trivia", "quiz"),
            options: {
                rounds: 3,
                seconds: 15,
                mode: "questions" as const,
                questions: [
                    { question: "Creepers run away from cats.", answers: ["true"] },
                    { question: "Ghasts live in the End.", answers: ["falso"] },
                    { question: "Sheep can be dyed.", answers: ["v"] }
                ]
            }
        };
        setUp([quiz]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "quiz",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        // A [True] and a [False] under it, each pressing this round's own value.
        const buttons = world.sent.find(
            (line) => line.startsWith("tellraw @a") && line.includes("[True]")
        );
        expect(buttons).toContain(`/trigger pe_join set ${commands.truthValue(0, true)}`);
        expect(buttons).toContain(`/trigger pe_join set ${commands.truthValue(0, false)}`);
        expect(buttons).toContain("[False]");
        expect(world.sent).toContain("scoreboard players enable @a pe_join");
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("title @a actionbar") &&
                    line.includes("True or false") &&
                    line.includes("t/f")
            )
        ).toBe(true);
        // Ben's first answer is wrong: his second is no answer at all.
        chat(["Ben", "f"], ["Ben", "t"]);
        await play(2_100);
        expect(state().run?.points).toEqual({});
        expect(state().run?.triviaOut).toEqual(["Ben"]);
        // Ana clicks [True].
        world.pressed = { Ana: commands.truthValue(0, true) };
        await play(2_100);
        expect(state().run?.points).toEqual({ Ana: 1 });
        expect(state().run?.answerMs.Ana).toBeGreaterThan(0);
        // The next round, false, answered at once in Spanish by Ben.
        for (let tries = 0; tries < 10 && state().run?.round !== 1; tries += 1) await play(1_000);
        expect(state().run?.roundEndsAt).not.toBeNull();
        expect(state().run?.triviaOut).toEqual([]);
        chat(["Ben", "Falso"]);
        await play(2_100);
        expect(state().run?.points).toEqual({ Ana: 1, Ben: 1 });
        expect(state().run!.answerMs.Ben!).toBeLessThan(state().run!.answerMs.Ana!);
        // The third: a button left from the first round answers nothing.
        for (let tries = 0; tries < 10 && state().run?.round !== 2; tries += 1) await play(1_000);
        world.pressed = { Ana: commands.truthValue(0, true) };
        await play(2_100);
        expect(state().run?.points).toEqual({ Ana: 1, Ben: 1 });
        expect(state().run?.triviaOut).toEqual([]);
        await play(15_000 + 10_000);
        const after = state();
        expect(after.run).toBeNull();
        // One round each: Ben answered his faster, so he is first, not tied.
        expect(after.history[0]?.podium).toEqual([
            { place: 1, name: "Ben", score: 1 },
            { place: 2, name: "Ana", score: 1 }
        ]);
    });
});

/** A world boss fought on the land, always The Warlord, on Normal: the
 *  counting and the prizes, apart from the draw and the arena. */
function groundBoss(
    id: string,
    minutes: number,
    options: Partial<catalog.EventOptions<"world-boss">> = {}
): catalog.EventPreset {
    const preset = newPreset("world-boss", id);
    return {
        ...preset,
        minutes,
        options: {
            ...(preset.options as catalog.EventOptions<"world-boss">),
            choice: "chosen",
            boss: "wither-skeleton",
            difficulty: "normal",
            arena: false,
            ...options
        }
    };
}

describe("a world boss", () => {
    it("appears with its health and name, counts damage near it, and falls", async () => {
        const boss = groundBoss("boss", 10);
        setUp([boss]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        expect(
            world.sent.some(
                (line) =>
                    line.includes("summon minecraft:wither_skeleton") && line.includes("pe_boss")
            )
        ).toBe(true);
        // 400 on Normal is 500 for one fighter.
        expect(world.sent).toContain(
            "attribute @e[tag=pe_boss,limit=1] minecraft:max_health base set 500"
        );
        // 1.21.4: the name is still written as JSON in a string.
        expect(
            world.sent.some((line) =>
                line.startsWith("data merge entity @e[tag=pe_boss,limit=1] {CustomName:'")
            )
        ).toBe(true);
        expect(
            world.sent.some((line) =>
                line.startsWith(
                    "execute store result bossbar polaris:event value run data get entity @e[tag=pe_boss"
                )
            )
        ).toBe(true);

        world.scores = { Ana: 180, Ben: 60 };
        world.bossAlive = false;
        await play(2_100);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("Defeated; the final blow by Ana");
        expect(after.history[0]?.podium.map((one) => one.name)).toEqual(["Ana", "Ben"]);
        expect(world.sent).toContain("execute as @e[tag=pe_boss] at @s run tp @s ~ -1000 ~");
    });

    it("points whoever is out of its reach the way, with how far and which way to turn", async () => {
        const boss = groundBoss("boss", 10);
        setUp([boss]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        // The boss stands at (310, 70, 4); Ana is far past its 40-block reach.
        world.online = ["Ana"];
        world.at = { Ana: [200, 64, 4] };
        await play(8_100);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("title Ana actionbar") &&
                    /The Warlord: \d+ m [↑↗→↘↓↙←↖]/.test(visible(line))
            )
        ).toBe(true);
        // Once within its reach, it stops pointing the way.
        world.at = { Ana: [310, 70, 4] };
        await play(2_100);
        const since = world.sent.length;
        await play(2_100);
        expect(
            world.sent
                .slice(since)
                .some(
                    (line) =>
                        line.startsWith("title Ana actionbar") &&
                        visible(line).includes("The Warlord:")
                )
        ).toBe(false);
    });

    it("is not taken as felled when it is out of reach and somebody far off kills its kind", async () => {
        const boss = groundBoss("boss", 10);
        setUp([boss]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        await play(10_100);
        expect(world.sent).toContain(
            "execute if entity @e[tag=pe_boss] run scoreboard players set @a pe_kill 0"
        );
        world.bossAlive = false;
        world.killerAt = [-2000, 40, 900];
        await play(6_100);
        expect(state().run).not.toBeNull();
        expect(state().run?.decidedBy).toBeNull();
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
    });

    it("gives nobody a prize when it got away", async () => {
        const boss = groundBoss("boss", 3);
        setUp([boss]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        world.scores = { Ana: 40 };
        await play(3 * 60_000 + 4_000);
        const after = state();
        expect(after.history[0]?.podium).toEqual([]);
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
    });
});

describe("a world boss fought at range", () => {
    const boss = () => groundBoss("boss", 10);

    it("shares the health nobody's melee accounts for among those fighting it, and places the killer first when the final blow decides it", async () => {
        // Both at it from the start: its health is set for them, and it never
        // heals for want of a fighter.
        world.fighters = ["Ana", "Ben"];
        setUp([groundBoss("boss", 10, { winner: "final-blow" })]);
        await startArena("boss");
        await play(8_100);
        // Arrows: the boss loses 100 health and nobody's melee counts any of it -
        // with nobody seen shooting, everybody near it shares.
        world.raw = { Ana: 0, Ben: 0 };
        world.bossHealth = 300;
        await play(2_100);
        expect(world.sent).toContain("scoreboard players add Ana pe_acc 500");
        expect(world.sent).toContain("scoreboard players add Ben pe_acc 500");
        // Ana is seen shooting: all of the next 50 is hers, not the bystander's.
        world.raw = { Ana: 0, Ben: 0 };
        world.shooters = ["Ana"];
        world.bossHealth = 250;
        await play(2_100);
        expect(world.sent).toContain("scoreboard players add Ana pe_acc 500");
        expect(
            world.sent.filter((line) => line === "scoreboard players add Ben pe_acc 500")
        ).toHaveLength(1);
        world.shooters = [];
        // Some melee: only the rest is shared, among those who hit it.
        world.raw = { Ana: 400, Ben: 0 };
        world.bossHealth = 200;
        await play(2_100);
        expect(world.sent).toContain("scoreboard players add Ana pe_acc 100");
        // It falls to an arrow: its last 200 health counted where it fell, before
        // anything empties the counts, and the killer placed whatever they scored.
        world.raw = { Ana: 0, Ben: 0 };
        world.scores = { Ben: 90 };
        world.bossAlive = false;
        await play(2_100);
        const sent = world.sent;
        const last = sent.lastIndexOf("scoreboard players add Ana pe_acc 1000");
        expect(last).toBeGreaterThanOrEqual(0);
        expect(
            sent.findIndex(
                (line, index) =>
                    index > last &&
                    /^execute in minecraft:overworld positioned \S+ \S+ \S+ as @a\[distance=\.\.40\] run scoreboard players operation @s pe_acc \+= @s pe_raw$/.test(
                        line
                    )
            )
        ).toBeGreaterThan(last);
        const after = state();
        expect(after.history[0]?.note).toBe("Defeated; the final blow by Ana");
        const podium = after.history[0]?.podium ?? [];
        // The final blow first, whatever it scored; the rest by their damage.
        expect(podium.map((one) => one.name)).toEqual(["Ana", "Ben"]);
        expect(podium[0]?.place).toBe(1);
        // The killer is paid, and nobody is paid twice.
        const gives = world.sent.filter((line) => line.startsWith("give "));
        expect(gives.some((line) => line.startsWith("give Ana "))).toBe(true);
        expect(new Set(gives).size).toBe(gives.length);
    });
});

describe("a world boss fight", () => {
    const start = async () =>
        events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });

    it("is shielded by minions in its second phase until they are killed, and rages in its third", async () => {
        world.fighters = ["Ana"];
        world.bossHealth = 500;
        setUp([groundBoss("boss", 10)]);
        await start();
        await play(8_100);
        expect(state().run?.boss).toMatchObject({
            kind: "wither-skeleton",
            standing: true,
            max: 500,
            phase: 1
        });
        expect(world.sent).toContain("bossbar set polaris:event color yellow");

        world.bossHealth = 300;
        world.minionsLeft = 3;
        await play(2_100);
        expect(state().run?.boss).toMatchObject({ phase: 2, shielded: true, broken: false });
        expect(world.sent).toContain("bossbar set polaris:event color purple");
        const minions = world.sent.filter((line) => line.includes("summon minecraft:skeleton"));
        expect(minions.length).toBeGreaterThanOrEqual(3);
        expect(minions.every((line) => line.includes('"pe_bshield"'))).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.includes(" title @a[distance=..40,") &&
                    line.includes("Kill the minions to break the shield")
            )
        ).toBe(true);

        await play(2_100);
        expect(world.sent).toContain(
            "effect give @e[tag=pe_boss,limit=1] minecraft:resistance 6 4 true"
        );

        world.minionsLeft = 0;
        const before = world.sent.length;
        await play(2_100);
        expect(state().run?.boss?.broken).toBe(true);
        expect(world.sent.slice(before)).toContain(
            "effect clear @e[tag=pe_boss,limit=1] minecraft:resistance"
        );
        expect(world.sent.slice(before).some((line) => line.includes("The shield is broken"))).toBe(
            true
        );

        world.bossHealth = 150;
        await play(2_100);
        expect(state().run?.boss?.phase).toBe(3);
        expect(world.sent).toContain("bossbar set polaris:event color red");
        expect(world.sent).toContain(
            "effect give @e[tag=pe_boss,limit=1] minecraft:strength 6 0 true"
        );
    });

    it("grows for every fighter who comes, keeping what was already taken off it", async () => {
        world.fighters = ["Ana"];
        world.bossHealth = 500;
        setUp([groundBoss("boss", 10)]);
        await start();
        await play(8_100);
        expect(state().run?.boss?.max).toBe(500);
        world.bossHealth = 400;
        world.fighters = ["Ana", "Ben"];
        await play(2_100);
        expect(world.sent).toContain(
            "attribute @e[tag=pe_boss,limit=1] minecraft:max_health base set 750"
        );
        expect(world.sent).toContain("data merge entity @e[tag=pe_boss,limit=1] {Health:650f}");
        expect(world.sent).toContain("bossbar set polaris:event max 750");
        expect(state().run?.boss).toMatchObject({ max: 750, fighters: ["Ana", "Ben"] });
    });

    it("heals slowly while nobody fights it, and warns of each attack before it lands", async () => {
        world.bossHealth = 400;
        setUp([groundBoss("boss", 10)]);
        await start();
        await play(10_100);
        expect(world.sent).toContain("data merge entity @e[tag=pe_boss,limit=1] {Health:410f}");
        expect(world.sent.some((line) => line.includes("it is healing"))).toBe(true);
        // Nobody near: no attack.
        expect(world.sent.some((line) => line.includes("run damage @s"))).toBe(false);

        world.fighters = ["Ana", "Ben"];
        await play(4_100);
        const warned = world.sent.findIndex(
            (line) =>
                line.includes("run particle minecraft:crit") ||
                line.includes("run particle minecraft:flame") ||
                line.includes("run particle minecraft:portal") ||
                line.includes("run particle minecraft:witch")
        );
        expect(warned).toBeGreaterThan(0);
        const landed = world.sent.findIndex(
            (line, index) =>
                index > warned &&
                (line.includes("run damage @s") ||
                    line.includes(" run tp @s ~ ~ ~") ||
                    line.includes("summon minecraft:vex") ||
                    line.startsWith("execute at Ben run tp @e[tag=pe_boss"))
        );
        expect(landed).toBeGreaterThan(warned);
    });

    it("gets out of a box built round it, even one that fights from afar and stands still to shoot", async () => {
        world.fighters = ["Ana"];
        world.fighterGap = 5;
        setUp([groundBoss("boss", 10, { boss: "captain" })]);
        await start();
        await play(12_100);
        // Standing still to shoot, in the open: it stays where it is.
        expect(world.sent).not.toContain("execute at Ana run tp @e[tag=pe_boss,limit=1] ~ ~ ~");
        world.bossBoxed = true;
        await play(8_100);
        expect(world.sent).toContain("execute at Ana run tp @e[tag=pe_boss,limit=1] ~ ~ ~");
    });

    it("gets out of a box with somebody standing right against it, a wall between them", async () => {
        world.fighters = ["Ana"];
        setUp([groundBoss("boss", 10, { boss: "ravager" })]);
        await start();
        // It never moves, two blocks from Ana: brought beside her.
        await play(14_100);
        expect(world.sent).toContain("execute at Ana run tp @e[tag=pe_boss,limit=1] ~ ~ ~");
    });

    it("holds mob griefing off for a ravager on the land, keeps inventories, and gives both back", async () => {
        world.mobGriefing = "true";
        setUp([groundBoss("boss", 10, { boss: "ravager" })]);
        await start();
        await play(4_100);
        expect(state().run?.gamerules).toMatchObject({
            mobGriefing: "true",
            keepInventory: "false"
        });
        expect(world.sent).toContain("gamerule mobGriefing false");
        expect(world.sent).toContain("gamerule keepInventory true");
        // What a restarted Polaris would send, from the stored run alone.
        const cleanup = events.cleanupOf(state().run!);
        expect(cleanup).toContain("gamerule mobGriefing true");
        expect(cleanup).toContain("gamerule keepInventory false");
        expect(cleanup).toContain("kill @e[tag=pe_bmob]");
        await events.cancelEvent("owner", SERVER);
        await play(4_100);
        expect(world.sent.filter((line) => line.startsWith("gamerule mobGriefing ")).at(-1)).toBe(
            "gamerule mobGriefing true"
        );
        expect(world.sent).toContain("execute as @e[tag=pe_bmob] at @s run tp @s ~ -1000 ~");
        expect(world.sent).toContain("kill @e[tag=pe_bmob]");
        expect(state().history[0]?.outcome).toBe("cancelled");
    });

    it("leaves mob griefing as the server has it for a boss that changes no block", async () => {
        world.mobGriefing = "true";
        setUp([groundBoss("boss", 10, { boss: "husk" })]);
        await start();
        await play(4_100);
        expect(world.sent).toContain("gamerule keepInventory true");
        expect(world.sent.some((line) => line.startsWith("gamerule mobGriefing "))).toBe(false);
        expect(state().run?.gamerules).not.toHaveProperty("mobGriefing");
    });

    it("does not start where it cannot hold mob griefing off", async () => {
        world.mobGriefing = "unknown";
        setUp([groundBoss("boss", 10, { boss: "ravager" })]);
        await start();
        await play(4_100);
        expect(state().history[0]?.outcome).toBe("failed");
        expect(world.sent.some((line) => line.includes("summon minecraft:ravager"))).toBe(false);
    });

    it("pays more on a harder level, and the final blow a named trophy", async () => {
        world.fighters = ["Ana", "Ben"];
        world.bag = { Ana: {}, Ben: {} };
        world.room = { Ana: 640, Ben: 640 };
        setUp([groundBoss("boss", 10, { difficulty: "epic" })]);
        await start();
        await play(8_100);
        world.scores = { Ana: 180, Ben: 60 };
        world.bossAlive = false;
        await play(2_100);
        const entry = state().history[0]!;
        expect(entry.note).toBe("Defeated; the final blow by Ana");
        expect(world.sent).toContain("give Ana minecraft:diamond 10");
        expect(world.sent).toContain("give Ben minecraft:diamond 6");
        const trophy = world.sent.find((line) =>
            line.startsWith("give Ana minecraft:nether_star[")
        );
        expect(trophy).toContain("Trophy: The Warlord");
        // 1.21.4 reads a name as JSON in a string: that is what is sent, and nothing it would refuse.
        expect(trophy).toContain(`minecraft:custom_name='{"text":"Trophy: The Warlord"`);
        expect(world.sent.some((line) => line.includes("minecraft:custom_name={text:"))).toBe(
            false
        );
        const ana = entry.delivered.find((one) => one.name === "Ana");
        expect(ana?.items).toContainEqual({ id: "minecraft:nether_star", count: 1, dropped: 0 });
        expect(
            world.sent.some((line) => line.startsWith("tellraw Ana ") && line.includes("trophy"))
        ).toBe(true);
    });

    it("stands in a closed arena in the sky, takes players up through the beam and puts them back", async () => {
        const preset = groundBoss("boss", 10, { arena: true });
        setUp([preset]);
        await start();
        await play(12_100);
        const run = state().run!;
        expect(run.stage?.built).toBe(true);
        expect(run.boss?.standing).toBe(true);
        const origin = run.stage!.origin!;
        const built = world.sent.filter(
            (line) => line.includes(" run fill ") && line.endsWith(" keep")
        );
        expect(built.some((line) => line.endsWith("minecraft:light_blue_stained_glass keep"))).toBe(
            true
        );
        expect(
            built.filter((line) => line.endsWith("minecraft:white_stained_glass keep"))
        ).toHaveLength(5);
        expect(
            world.sent.some((line) =>
                line.startsWith(
                    `execute in minecraft:overworld run summon minecraft:wither_skeleton ${origin.x + 0.5} ${origin.y + 1} ${origin.z + 0.5} `
                )
            )
        ).toBe(true);
        // Its place is where it stands; the beam is on the ground of its own
        // column, by the players, stepped into anywhere round it.
        expect(run.place).toEqual({ x: origin.x, y: origin.y + 1, z: origin.z });
        const lift = run.boss!.lift!;
        expect(lift.y).toBe(70);
        expect(lift.y).toBeLessThan(origin.y);
        expect(run.boss?.direct).toBe(false);
        expect(world.sent).toContain(boss.inLift(lift));

        world.lift = ["Ana"];
        await play(2_100);
        expect(world.sent).toContain("tag Ana add pe_in");
        expect(world.sent).toContain("gamemode adventure Ana");
        expect(state().run?.stage?.saved.map((one) => one.name)).toEqual(["Ana"]);
        world.lift = [];

        await events.cancelEvent("owner", SERVER);
        await play(6_100);
        const sent = world.sent;
        const mobsGone = sent.indexOf(
            "kill @e[tag=pe_boss]",
            sent.lastIndexOf("tag Ana add pe_in")
        );
        const firstRemoved = sent.findIndex((line) =>
            line.includes("minecraft:air replace minecraft:white_stained_glass")
        );
        expect(mobsGone).toBeGreaterThan(0);
        expect(firstRemoved).toBeGreaterThan(mobsGone);
        expect(
            sent.some((line) =>
                line.includes("minecraft:air replace minecraft:light_blue_stained_glass")
            )
        ).toBe(true);
        expect(sent).toContain("gamemode survival Ana");
        expect(sent).toContain("tag Ana remove pe_in");
        expect(state().stageLeftovers).toEqual([]);
        expect(state().history[0]?.outcome).toBe("cancelled");
    });
});

describe("a sky arena with no open ground for its beam", () => {
    it("takes everybody up once instead of making them climb, and puts them back", async () => {
        // Every column round the players is somebody's build.
        world.built = true;
        setUp([groundBoss("boss", 10, { arena: true })]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        await play(12_100);
        const run = state().run!;
        expect(run.boss?.standing).toBe(true);
        expect(run.boss?.lift).toBeNull();
        expect(run.boss?.direct).toBe(true);
        expect(world.sent.some((line) => line.includes("You are being taken up now"))).toBe(true);
        // Never pointed at a beam that is not there.
        expect(
            world.sent.some(
                (line) =>
                    line.includes("awaits in a sky arena over") ||
                    line.includes("Walk into the beam of light:")
            )
        ).toBe(false);

        world.lift = ["Ana"];
        await play(2_100);
        expect(world.sent).toContain("tag Ana add pe_in");
        expect(state().run?.boss?.taken).toEqual(["ana"]);
        expect(state().run?.stage?.saved.map((one) => one.name)).toEqual(["Ana"]);
        const admitted = world.sent.filter((line) => line === "tag Ana add pe_in").length;
        await play(2_100);
        // Taken once: never pulled up twice.
        expect(world.sent.filter((line) => line === "tag Ana add pe_in")).toHaveLength(admitted);
        world.lift = [];

        await events.cancelEvent("owner", SERVER);
        await play(6_100);
        expect(world.sent).toContain("gamemode survival Ana");
        expect(world.sent).toContain("tag Ana remove pe_in");
        expect(state().history[0]?.outcome).toBe("cancelled");
    });
});

describe("a Wither felled in its arena", () => {
    it("drops no star of its own: one left lying is taken, one picked up is taken back, and nobody's own", async () => {
        const plain = "minecraft:nether_star[!minecraft:custom_name]";
        world.version = "1.21.4";
        world.bag = { Ana: { [plain]: 2 }, Ben: {} };
        setUp([groundBoss("boss", 10, { arena: true, boss: "wither" })]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        await play(12_100);
        world.lift = ["Ana"];
        await play(2_100);
        world.lift = [];
        expect(state().run?.boss?.carried).toEqual({ Ana: 2 });
        // It falls; Ana stood where its star landed and has three now.
        world.bag.Ana![plain] = 3;
        world.bossAlive = false;
        await play(2_100);
        const sent = world.sent;
        const scored = sent.findIndex((line) =>
            line.includes(
                'nbt={Item:{id:"minecraft:nether_star"}}] store result score @s pe_sum run data get entity @s Age'
            )
        );
        const taken = sent.findIndex(
            (line) =>
                line.endsWith("kill @e[type=minecraft:item,scores={pe_sum=..-1}]") ||
                /kill @e\[type=minecraft:item,.*scores=\{pe_sum=\.\.-1\}\]$/.test(line)
        );
        const cleared = sent.indexOf(`clear Ana ${plain} 1`);
        expect(scored).toBeGreaterThan(0);
        expect(taken).toBeGreaterThan(scored);
        expect(cleared).toBeGreaterThan(taken);
        // Never a named star, and never more than the one she picked up.
        expect(
            sent.some(
                (line) =>
                    /^clear Ana minecraft:nether_star [1-9]/.test(line) ||
                    line === `clear Ana ${plain} 3`
            )
        ).toBe(false);
    });
});

describe("a prize a full inventory has no room for", () => {
    it("is dropped at their feet as the operator chose, the player told how much, and the history says so", async () => {
        world.bag = { Ana: { "minecraft:diamond": 2 }, Ben: {} };
        world.room = { Ana: 1, Ben: 64 };
        world.levels = { Ana: 10 };
        const rush = { ...newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await startArena("rush");
        world.scores = { Ana: 40, Ben: 12 };
        await play(3 * 60_000 + 4_000);
        const entry = state().history[0]!;
        const ana = entry.delivered.find((one) => one.name === "Ana");
        // One slot's room: a diamond went in; the rest of the first place fell at
        // her feet (the taking-part prize is for those off the podium).
        expect(ana?.items).toEqual([{ id: "minecraft:diamond", count: 5, dropped: 4 }]);
        expect(ana?.levels).toBe(15);
        const ben = entry.delivered.find((one) => one.name === "Ben");
        expect(ben?.items.every((one) => one.dropped === 0)).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw Ana ") &&
                    visible(line).includes("Inventory full: 4 [Item] fell at your feet")
            )
        ).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw Ben ") && visible(line).includes("Inventory full")
            )
        ).toBe(false);
        // Given once: the dropped ones are not kept owed.
        expect(world.sent.filter((line) => line === "give Ana minecraft:diamond 5")).toHaveLength(
            1
        );
        expect(state().pending).toEqual([]);
    });
});

describe("a blood moon", () => {
    it("brings night and waves, and only the survivors stand on the podium", async () => {
        const moon = { ...newPreset("blood-moon", "moon"), minutes: 3 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(world.sent).toContain("time set 13000");
        // The night is held still, so it neither runs out nor is slept through.
        expect(world.sent).toContain("gamerule doDaylightCycle false");
        expect(world.sent).toContain("gamerule doWeatherCycle false");
        // What it brings up tramples no farm and breaks nothing built, from
        // before the first of them rises.
        const griefOff = world.sent.indexOf("gamerule mobGriefing false");
        expect(griefOff).toBeGreaterThanOrEqual(0);
        expect(griefOff).toBeLessThan(
            world.sent.findIndex((line) => line.includes("run summon minecraft:"))
        );
        expect(state().run?.gamerules.mobGriefing).toBe("true");
        expect(
            world.sent.filter((line) => line.includes("run summon minecraft:")).length
        ).toBeGreaterThan(0);
        world.online = ["Ana", "Ben", "Cai"];
        world.scores = { Ana: 7, Ben: 12, Cai: 0 };
        world.deaths = { Ben: 1 };
        await play(3 * 60_000);
        const after = state();
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 7 }]);
        // First place is paid; seeing the dawn without a single kill is not taking part.
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        expect(world.sent.some((line) => line.startsWith("give Cai "))).toBe(false);
        expect(world.sent.some((line) => line.startsWith("give Ben "))).toBe(false);
        expect(world.sent).toContain("time set 23500");
        // And the server gets back what it had.
        expect(world.sent).toContain("gamerule doDaylightCycle true");
        expect(world.sent).toContain("gamerule doWeatherCycle true");
        expect(world.sent.filter((line) => line.startsWith("gamerule mobGriefing ")).at(-1)).toBe(
            "gamerule mobGriefing true"
        );
        expect(world.sent).toContain("kill @e[tag=pe_mob]");
        // Its night is the event: phantoms are left as the server has them.
        expect(world.sent.some((line) => line.startsWith("gamerule doInsomnia"))).toBe(false);
        expect(world.sent).not.toContain("time set 6000");
    });
});

describe("the others", () => {
    it("a race is won by whoever reaches the finish first", async () => {
        const race = {
            ...newPreset("explorer", "race"),
            minutes: 10,
            options: { mode: "race" as const, distance: 500, place: { mode: "players" as const } }
        };
        setUp([race]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "race",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(state().run?.place).not.toBeNull();
        world.arrived = true;
        await play(2_100);
        const after = state();
        expect(after.history[0]?.note).toBe("Ben reached the finish first");
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ben", score: 1 }]);
        // No side panel for a race: there is nothing to rank until somebody arrives.
        expect(held).not.toContain(SERVER);
    });

    it("the hill counts the time spent inside the circle", async () => {
        const hill = { ...walkInHill(), minutes: 3 };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        // On its platform, floating over whatever is under it.
        expect(
            world.sent.some((line) =>
                /positioned 300\.5 \d+ 0\.5 as @a\[distance=\.\.6,gamemode=!spectator\] run scoreboard players add @s pe_score 2/.test(
                    line
                )
            )
        ).toBe(true);
        world.scores = { Ana: 95 };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 95 }]);
    });

    it("draws the circle's edge and a column of light, and tells each player the way", async () => {
        world.online = ["Ana"];
        const hill = {
            ...walkInHill(),
            minutes: 3,
            minPlayers: 1
        };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        expect(
            world.sent.filter((line) => line.includes("particle minecraft:flame")).length
        ).toBeGreaterThanOrEqual(24);
        expect(world.sent.some((line) => line.includes("particle minecraft:end_rod"))).toBe(true);
        // Ana is a little way west of the circle, which is at X 300.
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("title Ana actionbar") &&
                    /"\d+ m "/.test(line) &&
                    line.includes('"east"')
            )
        ).toBe(true);
    });

    it("gives up a place on somebody's build and says it could not find one", async () => {
        world.built = true;
        setUp([{ ...newPreset("supply-drop", "drop"), minutes: 3 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(150_000);
        expect(world.sent.some((line) => /setblock .* minecraft:chest/.test(line))).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
        // Where it looked and what stopped it.
        const search = state().history[0]?.search;
        expect(search?.tries).toBeGreaterThan(0);
        expect(search?.from?.near).toMatch(/^(Ana|Ben)$/);
        // This world answers that every column stands on a tree: rough ground, every try.
        expect(search?.why).toEqual([{ why: "uneven", count: search?.tries }]);
    });

    it("judges the ground by older names on a server that refuses the newest", async () => {
        world.built = true;
        world.refusedGround = ["leaf_litter"];
        setUp([{ ...newPreset("supply-drop", "drop"), minutes: 3 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(150_000);
        expect(world.sent.some((line) => /setblock .* minecraft:chest/.test(line))).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
    });

    it("keeps judging the ground after a column that could not be read", async () => {
        world.built = true;
        world.unsureGround = 2;
        setUp([{ ...newPreset("supply-drop", "drop"), minutes: 3 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(150_000);
        expect(world.sent.some((line) => /setblock .* minecraft:chest/.test(line))).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
    });

    it("takes the fixed point an operator chose as it is", async () => {
        world.built = true;
        const hill = {
            ...walkInHill(),
            minutes: 3,
            options: {
                place: { mode: "fixed" as const, x: 300, z: 0 },
                radius: 6,
                fistsOnly: false
            }
        };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        expect(
            world.sent.some((line) => line.includes("run scoreboard players add @s pe_score 2"))
        ).toBe(true);
    });

    it("does not keep away from a player's anchor in the Nether", async () => {
        // Everybody stands at the origin, over their homes; every bearing is the
        // same one, so without the homes the first point tried is the one used.
        vi.spyOn(Math, "random").mockReturnValue(0);
        world.at = { Ana: [0, 64, 0], Ben: [0, 64, 0] };
        world.homes = { Ana: [0, 0], Ben: [0, 0] };
        world.homeWorlds = { Ana: "minecraft:the_nether", Ben: "minecraft:the_nether" };
        const hill = { ...walkInHill(), minutes: 3 };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        vi.mocked(Math.random).mockRestore();
        const first = world.sent
            .find((line) => /run forceload add -?\d+ -?\d+$/.test(line))
            ?.split(" ")
            .slice(-2)
            .map(Number) as [number, number] | undefined;
        expect(first).toBeDefined();
        expect(Math.hypot(...first!)).toBeLessThan(48);
    });

    it("looks past a player's bed for somewhere to put it", async () => {
        world.homes = { Ana: [0, 0], Ben: [0, 0] };
        const hill = { ...walkInHill(), minutes: 3 };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        const loaded = world.sent
            .filter((line) => /run forceload add -?\d+ -?\d+$/.test(line))
            .map((line) => line.split(" ").slice(-2).map(Number) as [number, number]);
        expect(loaded.length).toBeGreaterThan(0);
        for (const [x, z] of loaded) expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(48);
    });

    it("a happy hour gives its effects for exactly as long as it lasts, and no prizes", async () => {
        const happy = { ...newPreset("happy-hour", "happy"), minutes: 20 };
        setUp([happy]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "happy",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        expect(
            world.sent.some((line) =>
                /^effect give @a minecraft:haste (119\d|1200) 1 true$/.test(line)
            )
        ).toBe(true);
        expect(world.sent.some((line) => line.startsWith("effect give @a minecraft:luck"))).toBe(
            true
        );
        await play(20 * 60_000);
        const after = state();
        expect(after.history[0]).toMatchObject({ outcome: "finished", podium: [] });
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        expect(world.sent).toContain("effect clear @a minecraft:haste");
    });

    it("a happy hour called off takes its effects back", async () => {
        const happy = { ...newPreset("happy-hour", "happy"), minutes: 60 };
        setUp([happy]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "happy",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().history[0]).toMatchObject({ outcome: "cancelled" });
        expect(world.sent).toContain("effect clear @a minecraft:haste");
        expect(world.sent).toContain("effect clear @a minecraft:luck");
    });
});

describe("when things go wrong", () => {
    it("gives up on a place after a few tries, and tells the players", async () => {
        world.allWater = true;
        const drop = { ...newPreset("supply-drop", "drop"), minutes: 10 };
        setUp([drop]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(70_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({
            outcome: "failed",
            note: "No dry ground was found for it near the players"
        });
        expect(
            world.sent.some((line) => line.startsWith("tellraw @a") && line.includes("called off"))
        ).toBe(true);
        expect(world.sent.some((line) => line.includes("minecraft:chest"))).toBe(false);
    });

    it("picks an event back up after a restart, the side panel still its own", async () => {
        const rush = { ...newPreset("mining-rush", "rush"), minutes: 10 };
        setUp([rush]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed",
                trigger: "scheduled",
                startedBy: null,
                preset: rush,
                phase: "running",
                createdAt: now - 60_000,
                startsAt: now - 60_000,
                endsAt: now + 60_000,
                participants: ["Ana", "Ben"]
            }
        };
        await events.sweepEvents();
        expect(events.runningEvents()).toContain(SERVER);
        expect(held).toContain(SERVER);
        world.scores = { Ana: 13 };
        await play(62_000);
        expect(state().history[0]).toMatchObject({ id: "resumed", outcome: "finished" });
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 13 }]);
    });

    it("never plays a run again whose end had already begun", async () => {
        const rush = { ...newPreset("mining-rush", "rush"), minutes: 10 };
        setUp([rush]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "half-ended",
                trigger: "manual",
                startedBy: null,
                preset: rush,
                phase: "running",
                createdAt: now - 11 * 60_000,
                startsAt: now - 10 * 60_000,
                endsAt: now - 1_000,
                participants: ["Ana"],
                finishing: true
            }
        };
        world.scores = { Ana: 9 };
        await events.sweepEvents();
        await play(10_000);
        expect(events.runningEvents()).not.toContain(SERVER);
        expect(state().run).toBeNull();
        expect(state().history[0]).toMatchObject({ id: "half-ended", outcome: "failed" });
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        expect(world.sent).toContain("scoreboard objectives remove pe_score");
    });

    it("is not picked up again by the sweep while its end is being written", async () => {
        const rush = { ...newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 14 };
        const say = server.say;
        let swept = false;
        server.say = async (argv) => {
            if (argv.join(" ").startsWith("give ") && !swept) {
                swept = true;
                expect(state().run?.finishing).toBe(true);
                await events.sweepEvents();
                await events.cancelEvent("owner", SERVER).catch(() => undefined);
            }
            return say(argv);
        };
        try {
            await play(3 * 60_000);
        } finally {
            server.say = say;
        }
        expect(swept).toBe(true);
        expect(world.sent.filter((line) => line === "give Ana minecraft:diamond 5")).toHaveLength(
            1
        );
        const id = state().history[0]?.id;
        expect(state().history.filter((one) => one.id === id)).toHaveLength(1);
        expect(state().run).toBeNull();
        expect(events.runningEvents()).not.toContain(SERVER);
    });

    it("stays called off, and says so, when Polaris stopped while calling it off", async () => {
        const rush = { ...newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "stopped",
                trigger: "manual",
                startedBy: null,
                preset: rush,
                phase: "running",
                createdAt: now - 60_000,
                startsAt: now - 50_000,
                endsAt: now + 120_000,
                participants: ["Ana"],
                finishing: true,
                cancelled: true
            }
        };
        await events.sweepEvents();
        expect(state().run).toBeNull();
        expect(state().history[0]).toMatchObject({
            id: "stopped",
            outcome: "cancelled",
            note: "Called off"
        });
        expect(
            world.sent.some(
                (line) => line.startsWith("tellraw @a") && line.includes("was called off")
            )
        ).toBe(true);
    });
});

describe("the least to be ranked", () => {
    it("keeps a token score off the podium and out of the prizes", async () => {
        const hunt = { ...newPreset("mob-hunt", "hunt"), minutes: 3 };
        expect(catalog.minScoreOf(hunt)).toBe(5);
        setUp([hunt]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 7, Ben: 1 };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 7 }]);
        expect(world.sent.some((line) => line.startsWith("give Ben"))).toBe(false);
    });

    it("means nobody wins when nobody reaches it", async () => {
        const hunt = { ...newPreset("mob-hunt", "hunt"), minutes: 3 };
        setUp([hunt]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 2, Ben: 1 };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([]);
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
    });
});

describe("where the players are, and what they are doing", () => {
    const draw = (presetId: string) => ({
        minActive: 1,
        random: {
            enabled: true,
            days: [],
            from: "00:00",
            to: "23:59",
            minGap: 15,
            maxGap: 15,
            pool: [{ presetId, weight: 1 }]
        }
    });

    it("waits to draw an event while somebody is in a fight", async () => {
        setUp([{ ...newPreset("fishing", "fish"), minutes: 5 }], draw("fish"));
        await events.sweepEvents();
        await play(15 * 60_000);
        world.dealt = { Ana: 40 };
        await events.sweepEvents();
        world.dealt = { Ana: 55 };
        const held = await events.sweepEvents();
        expect(held.started).toBe(0);
        expect(gameMessageIn("en-US", state().waiting ?? "")).toBe(
            "Waiting: Ana is in a fight or in the End"
        );
        expect(gameMessageIn("es-ES", state().waiting ?? "")).toBe(
            "Esperando: Ana está en un combate o en el End"
        );
        // A minute and a half after the last blow, it goes ahead.
        await play(100_000);
        const started = await events.sweepEvents();
        expect(started.started).toBe(1);
    });

    it("forgets the fighting an event did itself once it is over, and counts the next blow", async () => {
        world.online = ["Ana"];
        const fighting = () => playing.seenOn(SERVER)?.get("ana")?.fightingAt ?? null;
        await playing.lookAt(SERVER, fakeServer());
        world.dealt = { Ana: 40 };
        await playing.lookAt(SERVER, fakeServer());
        expect(fighting()).not.toBeNull();
        // The rest of the event's blows, then its end.
        world.dealt = { Ana: 90 };
        await playing.forgetEventFights(SERVER, fakeServer(), ["Ana"]);
        expect(fighting()).toBeNull();
        // A blow after the event is a fight again.
        world.dealt = { Ana: 95 };
        await playing.lookAt(SERVER, fakeServer());
        expect(fighting()).not.toBeNull();
    });

    it("does not take damage taken alone for a fight", async () => {
        setUp([{ ...newPreset("fishing", "fish"), minutes: 5 }], draw("fish"));
        world.hurt = { Ana: 40 };
        await events.sweepEvents();
        await play(14 * 60_000);
        await events.sweepEvents();
        await play(60_000);
        // Hurt since the last look - hunger, a fall - and the draw still goes.
        world.hurt = { Ana: 55 };
        expect((await events.sweepEvents()).started).toBe(1);
        expect(plan.busy(playing.seenOn(SERVER)!.get("ana")!, Date.now())).toBe(false);
    });

    it("waits one more look after the players it was short of come, then starts", async () => {
        setUp([{ ...newPreset("fishing", "fish"), minutes: 5 }], { ...draw("fish"), minActive: 3 });
        await events.sweepEvents();
        await play(15 * 60_000);
        expect((await events.sweepEvents()).started).toBe(0);
        expect(state().short).toBe(true);
        world.online = ["Ana", "Ben", "Cai"];
        // Cai is seen, then seen to move: only then is the draw ready.
        await play(60_000);
        expect((await events.sweepEvents()).started).toBe(0);
        await play(60_000);
        expect((await events.sweepEvents()).started).toBe(0);
        expect(gameMessageIn("en-US", state().waiting ?? "")).toMatch(/one more check/);
        await play(100_000);
        expect((await events.sweepEvents()).started).toBe(1);
        expect(state().short).toBe(false);
    });

    it("draws one now from the screen, and says why the others could not", async () => {
        const duel = { ...newPreset("team-duel", "duel"), minPlayers: 4 };
        setUp([{ ...newPreset("fishing", "fish"), minutes: 5 }, duel], {
            ...draw("fish"),
            random: {
                ...draw("fish").random,
                pool: [
                    { presetId: "fish", weight: 1 },
                    { presetId: "duel", weight: 1 }
                ]
            }
        });
        await events.sweepEvents();
        await play(60_000);
        await events.sweepEvents();
        const drawn = await events.runRandomNow({
            ownerId: "owner",
            installedAppId: SERVER,
            startedBy: "user"
        });
        expect(drawn.run?.preset.id).toBe("fish");
        expect(drawn.run?.trigger).toBe("random");
        expect(drawn.skipped.map((one) => one.presetId)).toEqual(["duel"]);
        expect(state().nextRandomAt).not.toBeNull();
        const view = await events.eventsView(SERVER);
        expect(view.lastRandom?.name).toBe(drawn.run?.preset.name);
        await expect(
            events.runRandomNow({ ownerId: "owner", installedAppId: SERVER, startedBy: "user" })
        ).rejects.toThrow();
    });

    it("counts only the Overworld for an event that happens there", async () => {
        world.dims = { Ana: "minecraft:the_nether", Ben: "minecraft:the_nether" };
        setUp([{ ...newPreset("supply-drop", "drop"), minutes: 5 }], draw("drop"));
        await events.sweepEvents();
        await play(15 * 60_000);
        await events.sweepEvents();
        expect(state().run).toBeNull();
        expect(gameMessageIn("en-US", state().waiting ?? "")).toBe(
            "Waiting for 2 active players in the Overworld (0 now)"
        );
    });

    it("does not hold a mining rush back for players in the Nether", async () => {
        world.dims = { Ana: "minecraft:the_nether", Ben: "minecraft:the_nether" };
        setUp([{ ...newPreset("mining-rush", "rush"), minutes: 5 }], draw("rush"));
        await events.sweepEvents();
        await play(15 * 60_000);
        const started = await events.sweepEvents();
        expect(started.started).toBe(1);
    });

    it("does not count a night sat out in the Nether as surviving it", async () => {
        const moon = { ...newPreset("blood-moon", "moon"), minutes: 3, minScore: 1 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        world.scores = { Ana: 4, Ben: 9 };
        world.dims = { Ben: "minecraft:the_nether" };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 4 }]);
    });
});

describe("what the audit found", () => {
    it("refuses an event of hostile mobs on Peaceful, and says how to fix it", async () => {
        world.difficulty = "Peaceful";
        setUp([{ ...newPreset("blood-moon", "moon"), minutes: 5 }]);
        const refused = await refusal(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "moon",
                trigger: "manual",
                startedBy: null
            })
        );
        expect(refused).toMatch(/Peaceful.*Easy or harder under Rules/);
    });

    it("runs one that needs no hostile mobs on Peaceful", async () => {
        world.difficulty = "Peaceful";
        setUp([{ ...newPreset("fishing", "fish"), minutes: 5 }]);
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "fish",
                trigger: "manual",
                startedBy: null
            })
        ).resolves.toBeDefined();
    });

    it("leaves somebody who played it in creative off the podium", async () => {
        const rush = { ...newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.creative = ["Ana"];
        await play(20_000);
        world.creative = [];
        world.scores = { Ana: 900, Ben: 15 };
        await play(3 * 60_000);
        const entry = state().history[0];
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 15 }]);
        expect(entry?.disqualified).toEqual(["Ana"]);
    });

    it("reads a podium out of a crowd too big for one answer, with an accent in the title", async () => {
        world.online = Array.from(
            { length: 100 },
            (_, index) => `Pescador${String(index).padStart(2, "0")}`
        );
        world.glued = true;
        world.scoreTitle = "Gran concurso de pesca en el r\u00edo del norte";
        const fish = { ...newPreset("fishing", "fish"), minutes: 3 };
        setUp([fish]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "fish",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = Object.fromEntries(
            world.online.map((name, index) => [name, index === 95 ? 90 : 1])
        );
        await play(3 * 60_000);
        expect(state().history[0]?.podium[0]).toEqual({ place: 1, name: "Pescador95", score: 90 });
        // The page tags are gone again.
        expect(world.tags.pe_seen?.size ?? 0).toBe(0);
        expect(world.tags.pe_page?.size ?? 0).toBe(0);
    });

    it("reads each player by name through a team's prefix and suffix, and a Bedrock player as themselves", async () => {
        world.online = ["Ana", "Ben", ".Cy", "Cy"];
        world.glued = true;
        world.display = { Ana: ["[VIP] ", ""], Ben: ["", " [AFK]"] };
        const fish = { ...newPreset("fishing", "fish"), minutes: 3 };
        setUp([fish]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "fish",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 7, Ben: 5, ".Cy": 9, Cy: 1 };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([
            { place: 1, name: ".Cy", score: 9 },
            { place: 2, name: "Ana", score: 7 },
            { place: 3, name: "Ben", score: 5 }
        ]);
    });

    it("leaves somebody AFK the whole time off a fishing podium", async () => {
        world.still = ["Ana"];
        const fish = { ...newPreset("fishing", "fish"), minutes: 3 };
        setUp([fish]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "fish",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 40, Ben: 6 };
        await play(3 * 60_000);
        const entry = state().history[0];
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 6 }]);
        expect(entry?.disqualified).toEqual(["Ana"]);
    });

    it("leaves somebody AFK at a mob farm off a blood moon podium, however much they are hit", async () => {
        world.still = ["Ana"];
        const moon = { ...newPreset("blood-moon", "moon"), minutes: 3 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        for (let tick = 1; tick <= 8; tick += 1) {
            world.hurt = { Ana: tick * 4 };
            await play(15_000);
        }
        world.scores = { Ana: 30, Ben: 3 };
        await play(3 * 60_000);
        const entry = state().history[0];
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 3 }]);
        expect(entry?.disqualified).toEqual(["Ana"]);
    });

    it("holds the night on a version that renamed the game rules", async () => {
        world.renamedRules = true;
        world.daylightCycle = "false";
        const moon = { ...newPreset("blood-moon", "moon"), minutes: 3 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(world.sent).toContain("gamerule advance_time false");
        expect(world.sent).toContain("gamerule advance_weather false");
        expect(world.sent).not.toContain("gamerule doDaylightCycle false");
        await play(3 * 60_000);
        expect(world.sent).toContain("time set 6000");
        expect(world.sent.filter((line) => line.startsWith("gamerule advance_time")).at(-1)).toBe(
            "gamerule advance_time false"
        );
    });

    it.each(["1.21.4", "1.19.4", "1.19.2", "1.16.5"])(
        "keeps the blood moon's storm for the whole event on %s",
        async (version) => {
            world.version = version;
            const moon = { ...newPreset("blood-moon", "moon"), minutes: 3 };
            setUp([moon]);
            await events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "moon",
                trigger: "manual",
                startedBy: null
            });
            await play(4_100);
            // What is left of the three minutes once it has started, in ticks.
            expect(world.stormTicks).toBeGreaterThanOrEqual(170 * 20);
            // Rain, never thunder: its lightning burns houses and turns villagers.
            expect(world.sent.some((line) => line.startsWith("weather thunder"))).toBe(false);
        }
    );

    it.each(["1.21.4", "26.1"])(
        "gives a server on %s whose clock stands still its own time back after a blood moon",
        async (version) => {
            world.version = version;
            world.renamedRules = events.atLeast(version, [1, 21, 11]);
            world.daylightCycle = "false";
            const moon = { ...newPreset("blood-moon", "moon"), minutes: 3 };
            setUp([moon]);
            await events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "moon",
                trigger: "manual",
                startedBy: null
            });
            await play(3 * 60_000 + 4_000);
            expect(world.sent).toContain("time set 6000");
            expect(world.sent).not.toContain("time set 23500");
        }
    );

    it("gives a server whose clock stands still its own time back after a blood moon", async () => {
        world.daylightCycle = "false";
        const moon = { ...newPreset("blood-moon", "moon"), minutes: 3 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(3 * 60_000 + 4_000);
        expect(world.sent).toContain("time set 6000");
        expect(world.sent).not.toContain("time set 23500");
        expect(world.sent).toContain("gamerule doDaylightCycle false");
    });
});
/** Every item a line would take from a player: a `clear` without a count of 0. */
function takesItems(lines: readonly string[]): string[] {
    return lines.filter((line) => /(^|run )clear /.test(line) && !/ 0$/.test(line));
}

/** Every block a line puts down that is not an event chest into air, or takes
 *  away anything but an unopened event chest. */
function touchesBlocks(lines: readonly string[]): string[] {
    return lines.filter(
        (line) =>
            /\b(setblock|fill|clone)\b/.test(line) &&
            !/if block (\S+ \S+ \S+) minecraft:air run setblock \1 minecraft:chest\{LootTable:"[^"]+"\} keep$/.test(
                line
            ) &&
            !/if block (\S+ \S+ \S+) minecraft:chest if data block \1 LootTable run setblock \1 minecraft:air replace$/.test(
                line
            ) &&
            !/if block (\S+ \S+ \S+) minecraft:chest\{LootTable:"[^"]+"\} run setblock \1 minecraft:air replace$/.test(
                line
            ) &&
            // A small wild plant a chest took the place of, and the plant put back.
            !/if block (\S+ \S+ \S+) minecraft:(short_grass|fern) run setblock \1 minecraft:chest\{LootTable:"[^"]+"\} replace$/.test(
                line
            ) &&
            !/if block (\S+ \S+ \S+) minecraft:chest if data block \1 LootTable run setblock \1 minecraft:(short_grass|fern) replace$/.test(
                line
            )
    );
}

describe("a treasure hunt", () => {
    const start = async (
        options: Partial<catalog.EventOptions<"treasure-hunt">> = {},
        minutes = 9
    ) => {
        const made = newPreset("treasure-hunt", "hunt");
        setUp([{ ...made, minutes, options: { ...made.options, chests: 3, ...options } }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
    };
    const at = (chest: { x: number; y: number; z: number }) => `${chest.x} ${chest.y} ${chest.z}`;

    it("hides one rich treasure only into air, shows where it is to everybody, and scores whoever opens it", async () => {
        world.markFollows = true;
        // A preset saved with several chests is played with one.
        await start();
        await play(30_000);
        const run = state().run!;
        expect(run.hidden).toBe(true);
        expect(run.chests).toHaveLength(1);
        const chest = run.chests[0]!;
        expect(world.chests).toEqual([at(chest)]);
        // The richest table by default.
        expect(world.sent.some((line) => line.includes("minecraft:chests/bastion_treasure"))).toBe(
            true
        );
        expect(world.sent).toContain(
            `execute in minecraft:overworld run forceload add ${chest.x} ${chest.z}`
        );
        expect(touchesBlocks(world.sent)).toEqual([]);
        // One line saying it is out there, a column of light over it, and the way in
        // every action bar, always.
        const told = world.sent.filter(
            (line) => line.startsWith("tellraw @a") && visible(line).includes("treasure is hidden")
        );
        expect(told).toHaveLength(1);
        expect(world.sent).toContain(
            `execute in minecraft:overworld run particle minecraft:end_rod ${chest.x + 0.5} ${chest.y + 8} ${chest.z + 0.5} 0 8 0 0.01 60 force`
        );
        const bar = world.sent.find((line) => line.startsWith("title Ana actionbar"));
        expect(visible(bar ?? "")).toMatch(/Treasure: \d+ m \S+ \(1\/1\)/);

        world.opened.push(at(chest));
        await play(2_100);
        const after = readEventState(config);
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("All 1 treasure found");
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 1 }]);
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        // The opened chest is Ana's and stays.
        expect(world.chests).toEqual([at(chest)]);
        expect(world.sent).toContain(
            `execute in minecraft:overworld run forceload remove ${chest.x} ${chest.z}`
        );
    });

    it("ends as soon as every chest is open", async () => {
        world.markFollows = true;
        await start({ chests: 2 });
        await play(20_000);
        world.opened.push(...state().run!.chests.map(at));
        await play(2_100);
        const entry = state().history[0];
        expect(entry?.note).toBe("All 1 treasure found");
        expect(entry?.podium).toEqual([{ place: 1, name: "Ana", score: 1 }]);
        expect(world.chests).toHaveLength(1);
    });

    it("called off, takes away exactly the chests it put down and nothing else", async () => {
        world.markFollows = true;
        world.chests = ["1 64 1"];
        await start();
        await play(30_000);
        const placed = state().run!.chests.map(at);
        expect(placed).toHaveLength(1);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().history[0]).toMatchObject({ outcome: "cancelled", podium: [] });
        // Somebody's own chest, which the event never put down, is still there.
        expect(world.chests).toEqual(["1 64 1"]);
        expect(touchesBlocks(world.sent)).toEqual([]);
        expect(world.sent.some((line) => line.includes("setblock 1 64 1"))).toBe(false);
    });

    it("puts a chest in place of short grass, and puts the grass back when nobody opened it", async () => {
        world.markFollows = true;
        world.grass = true;
        await start({ chests: 2 });
        await play(30_000);
        const run = state().run!;
        expect(run.hidden).toBe(true);
        expect(run.chests.map((one) => one.was)).toEqual(["short_grass"]);
        expect(world.chests).toEqual(run.chests.map(at));
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(world.chests).toEqual([]);
        for (const chest of run.chests)
            expect(world.sent).toContain(
                `execute in minecraft:overworld if block ${at(chest)} minecraft:chest if data block ${at(chest)} LootTable run setblock ${at(chest)} minecraft:short_grass replace`
            );
        expect(touchesBlocks(world.sent)).toEqual([]);
    });

    it("never takes a chest already standing where it lands for one of its own", async () => {
        world.markFollows = true;
        world.markAt = [0, 0];
        const made = newPreset("treasure-hunt", "hunt");
        setUp([{ ...made, minutes: 9, options: { ...made.options, chests: 1 } }]);
        // Every place it finds already has somebody's unopened loot chest on it.
        const answer = server.say;
        server.say = async (argv) => {
            const line = argv.join(" ");
            const at = /^execute in minecraft:overworld if block (\S+ \S+ \S+) minecraft:air$/.exec(
                line
            );
            if (at && !world.chests.includes(at[1]!)) world.chests.push(at[1]!);
            return answer(argv);
        };
        try {
            await events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "hunt",
                trigger: "manual",
                startedBy: null
            });
            await play(90_000);
        } finally {
            server.say = answer;
        }
        expect(world.sent.some((line) => line.includes("minecraft:chest{LootTable"))).toBe(false);
        expect(state().history[0]).toMatchObject({ outcome: "failed" });
        // Theirs are all still there: nothing it did not put down was taken away.
        expect(world.chests.length).toBeGreaterThan(0);
        expect(world.sent.some((line) => /setblock \S+ \S+ \S+ minecraft:air/.test(line))).toBe(
            false
        );
    });

    it("puts nothing down where there is no air, and says it found nowhere", async () => {
        world.markFollows = true;
        world.solid = true;
        await start();
        await play(90_000);
        expect(world.chests).toEqual([]);
        expect(state().history[0]).toMatchObject({
            outcome: "failed",
            note: "No dry ground was found for it near the players"
        });
    });

    it("after a restart, still takes away its unopened chests and lets their chunks go", async () => {
        world.markFollows = true;
        world.chests = ["500 70 500", "-400 70 20"];
        world.opened = ["-400 70 20"];
        const made = newPreset("treasure-hunt", "hunt");
        setUp([made]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed-hunt",
                trigger: "manual",
                startedBy: null,
                preset: made,
                phase: "running",
                createdAt: now - 11 * 60_000,
                startsAt: now - 10 * 60_000,
                endsAt: now - 1_000,
                participants: ["Ana", "Ben"],
                finishing: true,
                hidden: true,
                chests: [
                    { x: 500, y: 70, z: 500 },
                    { x: -400, y: 70, z: 20, opened: true, by: "Ben" }
                ],
                held: [{ x: 498, z: 503 }]
            }
        };
        await events.sweepEvents();
        await play(4_000);
        expect(state().run).toBeNull();
        expect(world.chests).toEqual(["-400 70 20"]);
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove 500 500");
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove -400 20");
    });

    it("picked up after a restart mid-hunt, it goes on and still cleans up at the end", async () => {
        world.markFollows = true;
        world.chests = ["500 70 500"];
        const made = { ...newPreset("treasure-hunt", "hunt"), minutes: 10 };
        setUp([made]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed-live",
                trigger: "manual",
                startedBy: null,
                preset: made,
                phase: "running",
                createdAt: now - 5 * 60_000,
                startsAt: now - 5 * 60_000,
                endsAt: now + 60_000,
                participants: ["Ana", "Ben"],
                hidden: true,
                origin: { x: 0, z: 0 },
                reveals: 1,
                chests: [{ x: 500, y: 70, z: 500 }],
                held: [{ x: 500, z: 500 }]
            }
        };
        await events.sweepEvents();
        await play(4_100);
        expect(world.sent).toContain("execute in minecraft:overworld run forceload add 500 500");
        await play(60_000);
        expect(state().history[0]).toMatchObject({ id: "resumed-live", outcome: "finished" });
        expect(world.chests).toEqual([]);
    });

    it("after a restart between writing a chest down and placing it, never counts it as found", async () => {
        world.markFollows = true;
        const made = { ...newPreset("treasure-hunt", "hunt"), minutes: 10 };
        setUp([{ ...made, options: { ...made.options, chests: 2 } }]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed-hiding",
                trigger: "manual",
                startedBy: null,
                preset: { ...made, options: { ...made.options, chests: 2 } },
                phase: "running",
                createdAt: now - 60_000,
                startsAt: now - 30_000,
                endsAt: now + 9 * 60_000,
                participants: ["Ana", "Ben"],
                hidden: false,
                origin: { x: 0, z: 0 },
                chests: [{ x: 500, y: 70, z: 500 }],
                held: [{ x: 500, z: 500 }],
                place: { x: 500, y: 70, z: 500 },
                target: { x: 500, z: 500 }
            }
        };
        await events.sweepEvents();
        await play(30_000);
        const run = state().run!;
        expect(run.hidden).toBe(true);
        expect(run.chests.some((one) => one.opened)).toBe(false);
        expect(run.points).toEqual({});
        expect(world.chests).toEqual(run.chests.map(at));
    });
});

describe("a gathering", () => {
    it("announces the material, counts only what is gathered, and never takes an item", async () => {
        const made = newPreset("gathering", "gather");
        setUp([
            {
                ...made,
                minutes: 3,
                options: { material: "wheat" as const, rounds: 1, roundMinutes: 3 }
            }
        ]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "gather",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw @a") &&
                    visible(line).includes("Round 1/1: gather Wheat. Each is worth 2 points.")
            )
        ).toBe(true);
        expect(world.sent).toContain(
            "execute as @a unless score @s pe_seen matches 1 store result score @s pe_base run clear @s minecraft:wheat 0"
        );
        world.progress = { Ana: 20, Ben: 3 };
        await play(2_100);
        expect(
            world.sent.some(
                (line) => line.startsWith("title Ana actionbar") && line.includes('"20 "')
            )
        ).toBe(true);
        world.scores = { Ana: 20, Ben: 3 };
        await play(3 * 60_000);
        const entry = state().history[0];
        // Ben's three are under the least to be ranked.
        expect(entry?.podium).toEqual([{ place: 1, name: "Ana", score: 20 }]);
        expect(takesItems(world.sent)).toEqual([]);
        expect(world.sent).toContain("scoreboard objectives remove pe_base");
        expect(world.sent).toContain("scoreboard objectives remove pe_gp0");
    });

    it("says nothing of the material in the countdown, and draws a new one for every round", async () => {
        const made = newPreset("gathering", "gather");
        setUp([made], { countdownSeconds: 30 });
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "gather",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        expect(state().run?.phase).toBe("countdown");
        expect(state().run?.material).toBeNull();
        // No material is named before the start: nothing to wait beside.
        const names = catalog.GATHER_MATERIALS.map((one) => eventMessages.materialName(one, "en"));
        const told = (line: string) =>
            (line.startsWith("tellraw @a") || line.startsWith("title @a")) &&
            names.some((name) => visible(line).includes(name));
        expect(world.sent.some(told)).toBe(false);
        await play(30_000);
        const first = state().run!;
        expect(first.phase).toBe("running");
        expect(catalog.GATHER_MATERIALS).toContain(first.material);
        expect(first.round).toBe(0);
        expect(
            world.sent.some(
                (line) => line.startsWith("title @a title") && visible(line).includes("Round 1/3")
            )
        ).toBe(true);
        // Two minutes on: the round banked, and the next begun with another material.
        const banked = world.sent.length;
        await play(2 * 60_000 + 2_100);
        const second = state().run!;
        expect(second.round).toBe(1);
        expect(second.material).not.toBe(first.material);
        expect(second.materials).toEqual([first.material, second.material]);
        const since = world.sent.slice(banked);
        const bank = since.indexOf(
            "execute as @a run scoreboard players operation @s pe_gtot += @s pe_gpts"
        );
        expect(bank).toBeGreaterThan(-1);
        // Banked before the next round's counts are made afresh.
        expect(bank).toBeLessThan(since.indexOf("scoreboard objectives remove pe_prog"));
        expect(
            since.some(
                (line) => line.startsWith("title @a title") && visible(line).includes("Round 2/3")
            )
        ).toBe(true);
        // The bar is the round's own clock.
        expect(
            since.some(
                (line) =>
                    line.startsWith("bossbar set polaris:event name") &&
                    visible(line).includes("Round 2/3")
            )
        ).toBe(true);
        await play(4 * 60_000 + 5_000);
        expect(state().run).toBeNull();
        expect(state().history[0]?.note).toBe("Ran its full time");
    });
});

describe("a rare catch", () => {
    it("is won by the first to reel the treasure in, who keeps it", async () => {
        const made = newPreset("rare-catch", "catch");
        setUp([{ ...made, minutes: 20, options: { treasure: "name_tag" as const } }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "catch",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(world.sent).toContain(
            "scoreboard objectives add pe_rp0 minecraft.picked_up:minecraft.name_tag"
        );
        expect(
            world.sent.some(
                (line) => line.startsWith("title @a actionbar") && line.includes("name tag")
            )
        ).toBe(true);
        expect(state().run).not.toBeNull();
        world.caught = ["Ben"];
        await play(2_100);
        const entry = state().history[0];
        expect(entry?.note).toBe("Caught by Ben");
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 1 }]);
        expect(world.sent).toContain("give Ben minecraft:diamond 5");
        // Nothing of anybody's taken - not even the name tag.
        expect(takesItems(world.sent)).toEqual([]);
        expect(world.sent).toContain("scoreboard objectives remove pe_rod");
    });

    it("has no winner when nobody catches it", async () => {
        const made = newPreset("rare-catch", "catch");
        setUp([{ ...made, minutes: 3 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "catch",
            trigger: "manual",
            startedBy: null
        });
        await play(3 * 60_000 + 4_000);
        expect(state().history[0]?.podium).toEqual([]);
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        expect(world.sent.some((line) => line.includes("Nobody fished it up"))).toBe(true);
    });
});

describe("an experience boost", () => {
    it("pays extra experience while it lasts, takes nothing, and gives no prizes", async () => {
        const made = { ...newPreset("xp-boost", "boost"), minutes: 5 };
        setUp([made]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boost",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(world.sent).toContain(
            "scoreboard objectives add pe_xk minecraft.custom:minecraft.mob_kills"
        );
        expect(world.sent).toContain("execute as @a[scores={pe_xd=1..}] run xp add @s 5 points");
        expect(world.sent).toContain("execute as @a[scores={pe_xd=1..}] run xp add @s 3 points");
        await play(5 * 60_000);
        const entry = state().history[0];
        expect(entry).toMatchObject({ outcome: "finished", podium: [] });
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        expect(world.sent.some((line) => /xp (set|remove)/.test(line))).toBe(false);
        expect(world.sent.some((line) => line.includes("experience boost is over"))).toBe(true);
        expect(world.sent).toContain("scoreboard objectives remove pe_xk");
    });

    it("called off, pays what is owed before its counts are taken away", async () => {
        const made = { ...newPreset("xp-boost", "boost"), minutes: 20 };
        setUp([made]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boost",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        const before = world.sent.length;
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        const end = world.sent.slice(before);
        const paid = end.findLastIndex((line) => line.includes("xp add"));
        const removed = end.indexOf("scoreboard objectives remove pe_xk");
        expect(paid).toBeGreaterThanOrEqual(0);
        expect(removed).toBeGreaterThan(paid);
        expect(state().history[0]).toMatchObject({ outcome: "cancelled" });
    });
});

describe("a horde defense", () => {
    const start = () =>
        events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "waves",
            trigger: "manual",
            startedBy: null
        });
    const summoned = () =>
        world.sent.filter(
            (line) => line.includes(" run summon minecraft:") && line.includes('"pe_wnew"')
        );
    /** The chunks held round the point, as the lines that held them. */
    const holds = () =>
        (state().run?.chunks ?? []).map(
            (chunk) =>
                `execute in minecraft:overworld run forceload add ${chunk.x * 16} ${chunk.z * 16}`
        );

    it("waits for defenders, sends every wave, and rewards everybody who held the point", async () => {
        setUp([newPreset("waves", "waves")]);
        await start();
        await play(10_100);
        // Nothing is lost to a death: keepInventory on, the server's own
        // value written down first.
        expect(world.sent).toContain("gamerule keepInventory true");
        expect(world.sent).toContain("gamerule mobGriefing false");
        // And night, held, with clear weather: mobs that burn in the sun would
        // never reach the defenders.
        expect(state().run?.gamerules).toEqual({
            keepInventory: "false",
            mobGriefing: "true",
            sendCommandFeedback: "true",
            doDaylightCycle: "true",
            doWeatherCycle: "true"
        });
        expect(world.sent).toContain("time set 18000");
        expect(world.sent.some((line) => /^weather clear \d+s$/.test(line))).toBe(true);
        expect(state().run?.place).toEqual({ x: 300, y: 70, z: 0 });
        expect(state().run?.chunks).toHaveLength(25);
        const held = holds();
        for (const line of held) expect(world.sent).toContain(line);
        // Nobody at the point yet: no wave, however long it waits.
        await play(60_000);
        expect(summoned()).toHaveLength(0);

        world.defenders = ["Ana", "Ben"];
        await play(2_100);
        // Four for one defender, half as many again for the second.
        expect(summoned()).toHaveLength(6);
        expect(summoned().every((line) => line.includes('"pe_mob"'))).toBe(true);
        expect(
            world.sent.some(
                (line) => line.startsWith("title @a title") && line.includes("Wave 1/5")
            )
        ).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("bossbar set polaris:event name") && line.includes("Wave 1/5")
            )
        ).toBe(true);

        world.scores = { Ana: 9, Ben: 2 };
        world.hits = { Ben: 30 };
        // Every monster down as soon as it comes, wave after wave.
        await play(5 * 30_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("All 5 waves were fought");
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 9 }]);
        // Ben fell short of the podium, but held the point and fought: he
        // gets the prize for taking part.
        expect(world.sent).toContain("give Ben minecraft:experience_bottle 8");
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        expect(summoned().length).toBeGreaterThanOrEqual(6 * 5);
        // Everything undone: the monsters, the rule, the chunks it held.
        expect(world.sent).toContain("kill @e[tag=pe_mob]");
        expect(world.sent).toContain("gamerule keepInventory false");
        for (const line of held)
            expect(world.sent).toContain(line.replace(" forceload add ", " forceload remove "));
    });

    it("never takes on a chunk somebody already keeps loaded", async () => {
        world.forced =
            "2 force loaded chunks were found in minecraft:overworld at: [18, 0], [19, 1]";
        setUp([newPreset("waves", "waves")]);
        await start();
        await play(10_100);
        expect(state().run?.chunks).toHaveLength(23);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(world.sent).not.toContain(
            "execute in minecraft:overworld run forceload remove 304 16"
        );
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove 272 0");
    });

    it("takes away a wave that ran out of time, and a cancel takes everything back", async () => {
        world.defenders = ["Ana"];
        world.waveAlive = 3;
        setUp([newPreset("waves", "waves")]);
        await start();
        await play(10_100 + 46_000);
        expect(summoned()).toHaveLength(4);
        const held = holds();
        await play(121_000);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("title @a title") &&
                    visible(line).includes("Wave 1 ran out of time")
            )
        ).toBe(true);
        const kills = world.sent.filter((line) => line === "kill @e[tag=pe_mob]").length;
        expect(kills).toBeGreaterThan(0);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().history[0]).toMatchObject({ outcome: "cancelled" });
        expect(world.sent.filter((line) => line === "kill @e[tag=pe_mob]").length).toBeGreaterThan(
            kills
        );
        expect(world.sent).toContain("gamerule keepInventory false");
        expect(world.sent).toContain("scoreboard objectives remove pe_wkill");
        expect(held).toHaveLength(25);
        for (const line of held)
            expect(world.sent).toContain(line.replace(" forceload add ", " forceload remove "));
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
    });

    it("gives the server back its own keepInventory when it already had it on", async () => {
        world.keepInventory = "true";
        setUp([newPreset("waves", "waves")]);
        await start();
        await play(4_100);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(world.sent.filter((line) => line.startsWith("gamerule keepInventory ")).at(-1)).toBe(
            "gamerule keepInventory true"
        );
    });

    it("does not go ahead where it cannot keep inventories on", async () => {
        world.keepInventory = "unknown";
        world.defenders = ["Ana"];
        setUp([newPreset("waves", "waves")]);
        await start();
        await play(60_000);
        expect(state().history[0]).toMatchObject({
            outcome: "failed",
            note: "The server would not say whether it keeps inventories on death"
        });
        expect(world.sent.some((line) => line.includes('"pe_wnew"'))).toBe(false);
    });

    it("is refused on Peaceful", async () => {
        world.difficulty = "Peaceful";
        setUp([newPreset("waves", "waves")]);
        expect(await refusal(start())).toMatch(/Peaceful/);
    });

    it("puts the point well away from every bed", async () => {
        world.homes = { Ana: [0, 0], Ben: [0, 0] };
        setUp([newPreset("waves", "waves")]);
        await start();
        await play(4_100);
        const loaded = world.sent
            .filter((line) => /run forceload add -?\d+ -?\d+$/.test(line))
            .map((line) => line.split(" ").slice(-2).map(Number) as [number, number]);
        expect(loaded.length).toBeGreaterThan(0);
        for (const [x, z] of loaded) expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(96);
    });

    it("cleans up after a restart that caught it handing out its results", async () => {
        const preset = newPreset("waves", "waves");
        setUp([preset]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "interrupted",
                trigger: "manual",
                startedBy: null,
                preset,
                phase: "running",
                createdAt: now - 60_000,
                startsAt: now - 60_000,
                endsAt: now + 60_000,
                participants: ["Ana"],
                place: { x: 300, y: 70, z: 0 },
                round: 1,
                roundEndsAt: now + 30_000,
                gamerules: { keepInventory: "false" },
                chunks: [{ x: 18, z: 0 }],
                finishing: true
            }
        };
        await events.sweepEvents();
        await play(4_000);
        expect(state().run).toBeNull();
        expect(world.sent).toContain("kill @e[tag=pe_mob]");
        expect(world.sent).toContain("gamerule keepInventory false");
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove 288 0");
    });

    it("picks a wave back up after a restart and still ends it cleanly", async () => {
        const preset = newPreset("waves", "waves");
        setUp([preset]);
        const now = Date.now();
        world.defenders = ["Ana"];
        world.waveAlive = 2;
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed",
                trigger: "manual",
                startedBy: null,
                preset,
                phase: "running",
                createdAt: now - 60_000,
                startsAt: now - 60_000,
                endsAt: now + 20_000,
                participants: ["Ana"],
                place: { x: 300, y: 70, z: 0 },
                round: 0,
                roundEndsAt: now + 60_000,
                gamerules: { keepInventory: "false" },
                chunks: [{ x: 18, z: 0 }]
            }
        };
        await events.sweepEvents();
        await play(4_100);
        // Ana is far off: the bar says where the wave stands, her action bar the way.
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("bossbar set polaris:event name") && line.includes("Wave 1/5")
            )
        ).toBe(true);
        expect(
            world.sent.some(
                (line) => line.startsWith("title Ana actionbar") && line.includes("Point to hold")
            )
        ).toBe(true);
        await play(20_000);
        expect(state().run).toBeNull();
        expect(state().history[0]).toMatchObject({ id: "resumed", outcome: "finished" });
        expect(world.sent).toContain("kill @e[tag=pe_mob]");
        expect(world.sent).toContain("gamerule keepInventory false");
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove 288 0");
    });
});

describe("a meteor shower", () => {
    const start = () =>
        events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "meteors",
            trigger: "manual",
            startedBy: null
        });
    /** Four meteors of six blocks, as these runs were written against. */
    const shower = (minutes = 10) => {
        const made = newPreset("meteor-shower", "meteors");
        return {
            ...made,
            minutes,
            options: {
                ...(made.options as catalog.EventOptions<"meteor-shower">),
                meteors: 4,
                size: 6
            }
        };
    };
    const ore = (key: string) => (world.blocks.get(key) ?? "").endsWith("_ore");

    it("lands ore only in air, forgets what is mined, and takes back only what is left of it", async () => {
        // Something of somebody's where one block of the meteor would go.
        world.blocks.set("301 70 0", "minecraft:oak_planks");
        setUp([shower()]);
        await start();
        await play(8_100);
        const first = state().run?.meteors[0];
        expect(first?.blocks).toHaveLength(5);
        expect(
            first?.blocks.some((block) => block.x === 301 && block.y === 70 && block.z === 0)
        ).toBe(false);
        expect(world.blocks.get("301 70 0")).toBe("minecraft:oak_planks");
        expect(world.sent.some((line) => line.includes("setblock 301 70 0"))).toBe(false);
        expect(world.sent.filter((line) => line.endsWith(" keep"))).toHaveLength(5);
        expect(
            world.sent.some(
                (line) => line.startsWith("title @a title") && line.includes("A meteor has fallen")
            )
        ).toBe(true);
        expect(world.sent.some((line) => line.includes("particle minecraft:end_rod"))).toBe(true);
        expect(
            world.sent.some(
                (line) => line.startsWith("title Ana actionbar") && line.includes("Meteor:")
            )
        ).toBe(true);

        // Ana mines two blocks, then puts one of them back: hers now.
        world.at.Ana = [301, 70, 1];
        const [mined, back] = first!.blocks;
        world.blocks.delete(`${mined!.x} ${mined!.y} ${mined!.z}`);
        world.blocks.delete(`${back!.x} ${back!.y} ${back!.z}`);
        await play(2_100);
        expect(state().run?.meteors[0]?.blocks).toHaveLength(3);
        const hers = `${back!.x} ${back!.y} ${back!.z}`;
        world.blocks.set(hers, back!.block);
        await play(2_100);
        expect(state().run?.meteors[0]?.blocks).toHaveLength(3);
        delete world.at.Ana;

        world.scores = { Ana: 4, Ben: 1 };
        await play(10 * 60_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 4 }]);
        // What was left of every meteor is gone; her block and the planks stay.
        expect(world.blocks.get(hers)).toBe(back!.block);
        expect(world.blocks.get("301 70 0")).toBe("minecraft:oak_planks");
        expect([...world.blocks.keys()].filter((key) => key !== hers && ore(key))).toEqual([]);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith(`execute in minecraft:overworld if block ${hers} `) &&
                    line.includes("run setblock")
            )
        ).toBe(false);
        expect(world.sent).toContain("scoreboard objectives remove pe_mtot");
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove 288 0");
    });

    it("called off mid-way, takes back exactly what it placed", async () => {
        world.blocks.set("300 71 0", "minecraft:torch");
        setUp([shower()]);
        await start();
        await play(8_100);
        const placed = state().run?.meteors[0]?.blocks ?? [];
        expect(placed).toHaveLength(5);
        const held = state().run?.chunks ?? [];
        expect(held.length).toBeGreaterThan(0);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().history[0]).toMatchObject({ outcome: "cancelled" });
        expect([...world.blocks.entries()]).toEqual([["300 71 0", "minecraft:torch"]]);
        const removed = world.sent.filter(
            (line) => line.includes("run setblock") && line.endsWith("minecraft:air")
        );
        expect(removed).toHaveLength(placed.length);
        for (const chunk of held) {
            expect(world.sent).toContain(
                `execute in minecraft:overworld run forceload remove ${chunk.x * 16} ${chunk.z * 16}`
            );
        }
    });

    it("cleans up after a restart that caught it handing out its results", async () => {
        const preset = shower();
        setUp([preset]);
        world.blocks.set("300 70 0", "minecraft:gold_ore");
        world.blocks.set("301 70 0", "minecraft:diamond_ore");
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "interrupted",
                trigger: "manual",
                startedBy: null,
                preset,
                phase: "running",
                createdAt: now - 60_000,
                startsAt: now - 60_000,
                endsAt: now + 60_000,
                participants: ["Ana"],
                meteors: [
                    {
                        x: 300,
                        y: 70,
                        z: 0,
                        blocks: [
                            { x: 300, y: 70, z: 0, block: "minecraft:gold_ore" },
                            { x: 300, y: 71, z: 0, block: "minecraft:gold_ore" }
                        ]
                    }
                ],
                landings: 1,
                chunks: [{ x: 18, z: 0 }],
                finishing: true
            }
        };
        await events.sweepEvents();
        await play(4_000);
        expect(state().run).toBeNull();
        // Its gold is gone; a diamond ore it never placed is not.
        expect([...world.blocks.entries()]).toEqual([["301 70 0", "minecraft:diamond_ore"]]);
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove 288 0");
    });

    it("picks up again after a restart and still takes its ore back at the end", async () => {
        const preset = shower(3);
        setUp([preset]);
        world.blocks.set("300 70 0", "minecraft:gold_ore");
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed",
                trigger: "manual",
                startedBy: null,
                preset,
                phase: "running",
                createdAt: now - 170_000,
                startsAt: now - 170_000,
                endsAt: now + 10_000,
                participants: ["Ana"],
                meteors: [
                    {
                        x: 300,
                        y: 70,
                        z: 0,
                        blocks: [{ x: 300, y: 70, z: 0, block: "minecraft:gold_ore" }]
                    }
                ],
                landings: 4,
                chunks: [{ x: 18, z: 0 }]
            }
        };
        await events.sweepEvents();
        await play(4_100);
        expect(
            world.sent.some(
                (line) => line.startsWith("title Ana actionbar") && line.includes("blocks left")
            )
        ).toBe(true);
        await play(12_000);
        expect(state().history[0]).toMatchObject({ id: "resumed", outcome: "finished" });
        expect(world.blocks.size).toBe(0);
    });

    it("lands round set coordinates rather than on them, and away from every bed", async () => {
        world.homes = { Ana: [0, 0] };
        setUp([
            {
                ...shower(),
                options: {
                    ...shower().options,
                    place: { mode: "fixed" as const, x: 0, z: 0 },
                    distance: 50
                }
            }
        ]);
        await start();
        // Begun at once, the column is chosen on the first tick after.
        await play(2_100);
        const first = world.sent
            .map((line) =>
                /^execute in minecraft:overworld run forceload add (-?\d+) (-?\d+)$/.exec(line)
            )
            .find((match) => match !== null);
        expect(first).toBeTruthy();
        expect(Math.hypot(Number(first![1]), Number(first![2]))).toBeGreaterThanOrEqual(48);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
    });

    it("comes down on an island when all round it is sea", async () => {
        world.sea = true;
        world.markFollows = true;
        world.at = { Ana: [0, 64, 0], Ben: [3, 64, 2] };
        // The island: dry ground within 20 blocks of the middle, sea beyond.
        world.dryWithin = 20;
        setUp([shower(6)]);
        await start();
        await play(60_000);
        const landed = state().run?.meteors ?? [];
        expect(landed.length).toBeGreaterThan(0);
        for (const meteor of landed) expect(Math.hypot(meteor.x, meteor.z)).toBeLessThanOrEqual(20);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
    });

    it("comes in to an island for a chest when all round it is sea", async () => {
        world.sea = true;
        // The players stand by 0 0, wherever the clock has walked the others to.
        world.at = { Ana: [0, 64, 0], Ben: [5, 64, 5] };
        const drop = { ...newPreset("supply-drop", "drop"), minutes: 10 };
        setUp([drop]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(70_000);
        expect(state().history[0]?.outcome).toBe("failed");
        // How each try looks: its own distance first, then in, as near as a home allows.
        expect(commands.searchReach(600, 1, 3, true, 48)).toEqual({ reach: 600, clearance: 48 });
        expect(commands.searchReach(600, 1, 4, true, 48)).toEqual({ reach: 300, clearance: 9 });
        expect(commands.searchReach(600, 1, 9, true, 48)).toEqual({ reach: 9, clearance: 9 });
        expect(commands.searchReach(600, 1, 9, false, 48)).toEqual({ reach: 600, clearance: 48 });
        const tried = world.sent
            .map((line) =>
                /^execute in minecraft:overworld run forceload add (-?\d+) (-?\d+)$/.exec(line)
            )
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => [Number(match[1]), Number(match[2])] as const)
            // Where the simulated marker always comes down, held as it lands: not a try.
            .filter(([x, z]) => !(x === world.markAt[0] && z === world.markAt[1]));
        expect(tried.length).toBeGreaterThan(5);
        // Looked round one of the players, drawn at random - the history says which:
        // the first tries keep a home's clearance, the last ones come in next to
        // them. A try's distance inside its reach is drawn at random too, so only
        // the clearance is a promise.
        const from = state().history[0]!.search!.from!;
        const far = (point: readonly [number, number]) =>
            Math.hypot(point[0] - from.x, point[1] - from.z);
        expect(Math.min(...tried.slice(0, 3).map(far))).toBeGreaterThanOrEqual(48 - 20);
        expect(far(tried[tried.length - 1]!)).toBeLessThan(48);
    });

    it("gives up when there is nowhere dry for any meteor, and places nothing", async () => {
        world.allWater = true;
        setUp([shower(3)]);
        await start();
        await play(3 * 60_000 + 4_000);
        expect(state().history[0]).toMatchObject({
            outcome: "failed",
            note: "No dry ground was found for it near the players"
        });
        expect(world.blocks.size).toBe(0);
        expect(world.sent.some((line) => line.endsWith(" keep"))).toBe(false);
    });
});

// ------------------------------------------------------------------ parkour and spleef

const parkour = await import("@polaris-app/game-servers/src/lib/minecraft/events/kinds/parkour");
const spleef = await import("@polaris-app/game-servers/src/lib/minecraft/events/kinds/spleef");
const snowballPack = await import(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack"
);

/** Players typing in the chat, as the server log records it. */
function chat(...said: [string, string][]): void {
    for (const [name, line] of said)
        world.log += `[20:00:05] [Server thread/INFO]: <${name}> ${line}\n`;
}

async function startArena(presetId: string): Promise<void> {
    await events.startEvent({
        ownerId: "owner",
        installedAppId: SERVER,
        presetId,
        trigger: "manual",
        startedBy: null
    });
}

/** Every block put up, and every block taken down, as `box -> block`. */
function builtAndRemoved(): { built: string[]; removed: string[] } {
    const box = (line: string) => /fill (.+?) (minecraft:\S+)(?: replace (\S+)| keep)$/.exec(line);
    const built = world.sent
        .filter((line) => line.includes(" fill ") && line.endsWith(" keep"))
        .map((line) => {
            const found = box(line)!;
            return `${found[1]} -> ${found[2]}`;
        });
    const removed = world.sent
        .filter((line) => line.includes(" fill ") && line.includes("minecraft:air replace"))
        .map((line) => {
            const found = box(line)!;
            return `${found[1]} -> ${found[3]}`;
        });
    return { built, removed };
}

/** The rules every one of these must keep, whatever happened: blocks go up only
 *  into air and come down only where they are still the event's; nothing is
 *  cleared but the event's marked items; nothing that burns or floods. */
function keptTheRules(): void {
    const fills = world.sent.filter((line) => line.includes(" fill "));
    // The ring is drawn again as it shrinks and moves: its floor's own block
    // painted over its own ring block and back, never anything else.
    const repaint = new RegExp(
        ` (${hill.PLATFORM_BLOCK}|${hill.RING_BLOCK}) replace (${hill.RING_BLOCK}|${hill.PLATFORM_BLOCK})$`
    );
    for (const line of fills)
        expect(
            line.endsWith(" keep") ||
                / minecraft:air replace minecraft:\S+$/.test(line) ||
                (repaint.test(line) &&
                    !line.includes(`${hill.RING_BLOCK} replace ${hill.RING_BLOCK}`))
        ).toBe(true);
    // Everything built is taken out again: by its own box, or by a larger one
    // of the same block that holds it (an arena comes down a block at a time
    // over its whole box).
    const { built, removed } = builtAndRemoved();
    const parse = (one: string) => {
        const [coords, block] = one.split(" -> ");
        return { at: coords!.split(" ").map(Number), block };
    };
    const holds = (outer: number[], inner: number[]) =>
        [0, 1, 2].every(
            (axis) =>
                Math.min(outer[axis]!, outer[axis + 3]!) <=
                    Math.min(inner[axis]!, inner[axis + 3]!) &&
                Math.max(outer[axis]!, outer[axis + 3]!) >= Math.max(inner[axis]!, inner[axis + 3]!)
        );
    for (const one of built) {
        const b = parse(one);
        expect(
            removed.some((other) => {
                const r = parse(other);
                return r.block === b.block && holds(r.at, b.at);
            }),
            one
        ).toBe(true);
    }
    for (const line of takesItems(world.sent).filter((one) => one.startsWith("clear ")))
        expect(line).toContain("custom_data={polaris_event:1b}");
    // Never put down; asking whether a column is open water is only asking.
    expect(
        world.sent.some(
            (line) =>
                /minecraft:(lava|fire|tnt|water)\b/.test(line) &&
                !/ if block -?\d+ -?\d+ -?\d+ minecraft:water$/.test(line) &&
                !/ if block ~ ~-1 ~ minecraft:water run data get entity @s Pos$/.test(line)
        )
    ).toBe(false);
}

describe("a parkour race", () => {
    const race = () => ({
        ...newPreset("parkour", "race"),
        minutes: 5,
        options: {
            place: { mode: "players" as const },
            jumps: 12,
            difficulty: "medium" as const,
            height: 30
        }
    });

    it("takes only who joins, builds in the air, sends a fall back to its checkpoint and everybody home", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        setUp([race()]);
        await startArena("race");
        // The countdown is long enough to join in, whatever the settings say.
        expect(state().run!.startsAt - state().run!.createdAt).toBe(30_000);
        await play(2_100);
        expect(
            world.sent.some((line) => line.startsWith("tellraw @a") && line.includes("join"))
        ).toBe(true);
        chat(["Ana", "join"], ["Ben", "!Unirse"], ["Cy", "join me later"]);
        await play(2_100);
        expect(state().run?.stage?.joined).toEqual(["Ana", "Ben"]);
        await play(40_000);

        const run = state().run!;
        const arenaState = run.stage!;
        expect(arenaState.built).toBe(true);
        expect(arenaState.saved.map((one) => one.name)).toEqual(["Ana", "Ben"]);
        // Proved empty before anything went up, the probe taken out again.
        expect(world.sent.some((line) => line.endsWith("minecraft:structure_void keep"))).toBe(
            true
        );
        expect(
            world.sent.some((line) =>
                line.endsWith("minecraft:air replace minecraft:structure_void")
            )
        ).toBe(true);
        // Cy never asked, and is never moved.
        expect(world.sent.some((line) => / tp Cy /.test(line))).toBe(false);
        expect(world.sent).toContain("gamemode adventure Ana");
        expect(world.sent).toContain("effect give @a[tag=pe_in] minecraft:resistance 10 4 true");
        expect(arenaState.origin?.y).toBe(100);

        const course = parkour.course(
            race().options,
            run.id,
            arenaState.origin!,
            arenaState.origin!.y
        );
        const top = (index: number): [number, number, number] => {
            const one = course.platforms[index]!;
            return [one.x + one.size / 2, one.y + 1, one.z + one.size / 2];
        };
        // Each racer's checkpoint is kept in the game, for the quick look.
        expect(world.checkpoint).toEqual({ Ana: 0, Ben: 0 });
        world.at.Ana = top(course.checkpoints[0]!);
        world.at.Ben = [top(3)[0], course.floor - 3, top(3)[2]];
        const from = world.sent.length;
        // Under half a second, not a tick: Ana's checkpoint marked and told, and
        // Ben - who fell onto the net - back at the start, unhurt.
        await play(450);
        const quick = world.sent.slice(from);
        const start = parkour.spotOn(course, 0);
        expect(world.checkpoint.Ana).toBe(course.checkpoints[0]);
        expect(world.at.Ben).toEqual([start.x, start.y, start.z]);
        expect(
            quick.some(
                (line) =>
                    line.startsWith(
                        "execute in minecraft:overworld as @a[tag=pe_in,scores={pe_cp=.."
                    ) &&
                    line.includes(" run title @s title ") &&
                    line.includes("Checkpoint 1/")
            )
        ).toBe(true);
        expect(
            quick.some((line) =>
                /^execute in minecraft:overworld as @a\[tag=pe_in,scores=\{pe_cp=0\},.* run tp @s /.test(
                    line
                )
            )
        ).toBe(true);
        // Nothing read per player to do it.
        expect(quick.some((line) => line.includes("data get entity"))).toBe(false);
        await play(2_100);
        const said = world.sent.slice(from);
        expect(state().run?.stage?.racers.find((one) => one.name === "Ana")?.checkpoint).toBe(
            course.checkpoints[0]
        );
        // Told once, by the quick look - not again by the tick.
        expect(said.some((line) => line.startsWith("title Ana title"))).toBe(false);
        expect(
            said.some((line) => line.startsWith("execute in minecraft:overworld run tp Ben"))
        ).toBe(false);

        const savedBen = state().run!.stage!.saved.find((one) => one.name === "Ben")!;
        world.at.Ana = top(course.platforms.length - 1);
        chat(["Ben", "leave"]);
        await play(4_100);
        // Her time is to the moment she stepped on the finish, not the next tick.
        expect(world.finishTick.Ana).toBeGreaterThan(0);

        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("Everybody finished or dropped out");
        expect(after.history[0]?.podium.map((one) => one.name)).toEqual(["Ana"]);
        expect(world.sent).toContain(
            `execute in minecraft:overworld run tp Ben ${savedBen.x.toFixed(3)} ${savedBen.y.toFixed(3)} ${savedBen.z.toFixed(3)} ${savedBen.yaw.toFixed(1)} ${savedBen.pitch.toFixed(1)}`
        );
        expect(world.sent).toContain("gamemode survival Ana");
        expect(world.sent).toContain("gamemode survival Ben");
        // Fall-proof before being moved off the course.
        const proof = world.sent.indexOf("effect give Ben minecraft:slow_falling 10 0 true");
        expect(proof).toBeGreaterThan(0);
        expect(
            world.sent.findIndex(
                (line, index) =>
                    index > proof && line.startsWith("execute in minecraft:overworld run tp Ben ")
            )
        ).toBeGreaterThan(proof);
        expect(world.inside.size).toBe(0);
        expect(after.stageLeftovers).toEqual([]);
        keptTheRules();
    });

    it("holds everybody on the start pad until all are in, counts down, and starts every clock at Go", async () => {
        world.online = ["Ana", "Ben"];
        world.stuck = ["Ben"];
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        for (let tick = 0; tick < 200 && !state().run?.stage?.racers.length; tick += 1)
            await play(500);
        await play(4_000);
        const run = state().run!;
        const stageNow = run.stage!;
        expect(stageNow.racers.map((one) => one.name)).toEqual(["Ana", "Ben"]);
        // Ben is still loading in: nothing has started, and those in are told why.
        expect(run.readyAt).toBeNull();
        expect(stageNow.goAt).toBeNull();
        expect(world.sent.some((line) => line.includes("Waiting for everybody"))).toBe(true);
        expect(world.sent.some((line) => line.includes("Go!"))).toBe(false);
        const course = parkour.course(race().options, run.id, stageNow.origin!, stageNow.origin!.y);
        const start = parkour.spotOn(course, 0);
        expect(world.at.Ana).toEqual([start.x, start.y, start.z]);
        // A step onto the first platform before the start: back on the pad at once.
        const first = course.platforms[1]!;
        world.at.Ana = [first.x + first.size / 2, first.y + 1, first.z + first.size / 2];
        await play(450);
        expect(world.at.Ana).toEqual([start.x, start.y, start.z]);
        // Ben arrives: the countdown, then "Go!" for both at once.
        world.stuck = [];
        world.at.Ben = [start.x, start.y, start.z];
        const before = world.sent.length;
        await play(8_000);
        const after = world.sent.slice(before);
        const shown = (text: string) =>
            after.findIndex(
                (line) => line.includes(" title ") && visible(line).endsWith(` title ${text}`)
            );
        expect(shown("3")).toBeGreaterThan(-1);
        expect(shown("2")).toBeGreaterThan(shown("3"));
        expect(shown("1")).toBeGreaterThan(shown("2"));
        expect(shown("Go!")).toBeGreaterThan(shown("1"));
        const started = state().run!;
        expect(started.readyAt).not.toBeNull();
        expect(started.stage!.goAt).not.toBeNull();
        const [ana, ben] = started.stage!.racers;
        // Both clocks from the same moment, after the countdown.
        expect(ana!.since).toBe(ben!.since);
        expect(ana!.since).toBeGreaterThanOrEqual(started.stage!.goAt! + 3_000);
        expect(world.sent.some((line) => line.includes("Started without"))).toBe(false);
    });

    it("starts without a racer still not in when the wait runs out, and says who", async () => {
        world.online = ["Ana", "Ben"];
        world.stuck = ["Ben"];
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        for (let tick = 0; tick < 200 && !state().run?.stage?.racers.length; tick += 1)
            await play(500);
        expect(state().run!.readyAt).toBeNull();
        await play(arrival.ARRIVAL_MS + 8_000);
        expect(state().run!.readyAt).not.toBeNull();
        const without = world.sent.find((line) =>
            line.includes("Started without waiting longer for")
        );
        expect(without).toContain("Ben");
        expect(without).not.toContain("Ana");
    });

    it("holds the day and keeps phantoms and hostiles off while it runs, and gives both rules back exactly", async () => {
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        expect(state().run?.stage?.built).toBe(true);
        // Written down before either is changed, so a restart gives them back too.
        expect(state().run?.gamerules).toMatchObject({
            doDaylightCycle: "true",
            doInsomnia: "true"
        });
        expect(world.sent).toContain("gamerule doDaylightCycle false");
        expect(world.sent).toContain("gamerule doInsomnia false");
        expect(world.sent).toContain("time set 6000");
        expect(world.daylightCycle).toBe("false");
        expect(world.insomnia).toBe("false");
        // Hostiles inside its own box and the air over it, never a named one.
        const volume = parkour.course(
            race().options,
            state().run!.id,
            state().run!.stage!.origin!,
            state().run!.stage!.origin!.y
        ).volume;
        const kill = world.sent.find((line) => line.includes("kill @e[type=minecraft:phantom,"));
        expect(kill).toBe(
            `execute in minecraft:overworld run kill @e[type=minecraft:phantom,x=${volume.x1},y=${volume.y1},z=${volume.z1},dx=${volume.x2 - volume.x1},dy=${volume.y2 - volume.y1 + 16},dz=${volume.z2 - volume.z1},nbt=!{PersistenceRequired:1b}]`
        );
        // Only its own marks are killed any other way; every kill in the air
        // names a hostile type and spares a named mob.
        for (const line of world.sent.filter((one) => / kill @e\[.*dx=/.test(one)))
            expect(line).toMatch(
                /kill @e\[type=minecraft:[a-z_]+,.*,nbt=!\{PersistenceRequired:1b\}\]$/
            );
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        const end = world.sent.lastIndexOf("gamerule doDaylightCycle true");
        expect(end).toBeGreaterThan(-1);
        expect(world.sent).toContain("gamerule doInsomnia true");
        expect(world.daylightCycle).toBe("true");
        expect(world.insomnia).toBe("true");
        // The time of day it had before is put back.
        expect(world.sent.slice(end)).toContain("time set 6000");
    });

    it("leaves a day already held, and phantoms already off, just as they were - under their 1.21.11 names too", async () => {
        world.renamedRules = true;
        world.daylightCycle = "false";
        world.insomnia = "false";
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        expect(state().run?.gamerules).toMatchObject({
            advance_time: "false",
            spawn_phantoms: "false"
        });
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(world.sent).not.toContain("gamerule advance_time true");
        expect(world.sent).not.toContain("gamerule spawn_phantoms true");
        expect(world.daylightCycle).toBe("false");
        expect(world.insomnia).toBe("false");
    });

    it("takes everybody in empty-handed and gives them back all they carried, one who left halfway at once", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map([[7, { id: "minecraft:torch", count: 32 }]]) };
        const ana = copyOf(world.inv.Ana!);
        const ben = copyOf(world.inv.Ben!);
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        const run = state().run!;
        expect(run.stage?.built).toBe(true);
        expect(world.inv.Ana!.size).toBe(0);
        expect(world.inv.Ben!.size).toBe(0);
        const kept = run.stage!.saved.find((one) => one.name === "Ana")!.stash!;
        // Kept in the database, nothing built for it.
        expect(kept.barrels).toEqual([]);
        expect(stashRows.size).toBe(2);
        // Ben leaves halfway: his things come straight back.
        chat(["Ben", "leave"]);
        await play(2_100);
        expect(world.inv.Ben).toEqual(ben);
        expect(state().run!.stage!.saved.map((one) => one.name)).toEqual(["Ana"]);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().run).toBeNull();
        expect(world.inv.Ana).toEqual(ana);
        expect(stashRows.size).toBe(0);
        keptTheRules();
    });

    it("called off halfway takes down exactly what it built and brings everybody back", async () => {
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        expect(state().run?.stage?.built).toBe(true);
        const saved = state().run!.stage!.saved;
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().history[0]).toMatchObject({ outcome: "cancelled" });
        for (const one of saved) {
            expect(world.sent).toContain(
                `execute in ${one.dimension} run tp ${one.name} ${one.x.toFixed(3)} ${one.y.toFixed(3)} ${one.z.toFixed(3)} ${one.yaw.toFixed(1)} ${one.pitch.toFixed(1)}`
            );
            expect(world.sent).toContain(`tag ${one.name} remove pe_in`);
        }
        expect(
            world.sent.some((line) => /run forceload remove -?\d+ -?\d+ -?\d+ -?\d+$/.test(line))
        ).toBe(true);
        keptTheRules();
        expect(builtAndRemoved().built.length).toBeGreaterThan(10);
        expect(state().stageLeftovers).toEqual([]);
    });

    it("keeps somebody offline at the end owed their trip back, and sends them the minute they are on", async () => {
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        world.online = ["Ana"];
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        const owed = state().stageLeftovers;
        expect(owed).toHaveLength(1);
        expect(owed[0]?.saved.map((one) => one.name)).toEqual(["Ben"]);
        expect(owed[0]?.boxes).toEqual([]);
        expect(world.sent).not.toContain("gamemode survival Ben");
        world.online = ["Ana", "Ben"];
        await events.sweepEvents();
        expect(world.sent).toContain("gamemode survival Ben");
        expect(state().stageLeftovers).toEqual([]);
    });

    it("gives up a site whose air is not empty, takes its probe back out, and never builds there", async () => {
        world.skyTaken = true;
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(600_000);
        const after = state();
        expect(after.history[0]).toMatchObject({ outcome: "failed" });
        expect(after.history[0]?.note).toBe("No open air was found for it near the players");
        expect(
            world.sent.some((line) => line.endsWith(" keep") && !line.includes("structure_void"))
        ).toBe(false);
        expect(world.sent.some((line) => / tp (Ana|Ben) /.test(line))).toBe(false);
        keptTheRules();
    });
});

describe("an event built in the air", () => {
    const race = () => ({
        ...newPreset("parkour", "race"),
        minutes: 5,
        options: {
            place: { mode: "players" as const },
            jumps: 12,
            difficulty: "medium" as const,
            height: 30
        }
    });

    it("goes up over a densely built area: only the air it takes counts", async () => {
        // Every column answers that it stands on something built.
        world.built = true;
        world.online = ["Ana", "Ben"];
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(42_100);
        expect(state().run?.stage?.built).toBe(true);
        // Measured over the highest thing in its footprint, roofs and crowns included.
        expect(
            world.sent.some((line) => line.includes("positioned over motion_blocking run summon"))
        ).toBe(true);
        expect(state().run?.placeLog.some((one) => one.why === "built")).toBe(false);
    });

    it("is held near the players in the Overworld when another is in the Nether", async () => {
        world.online = ["Ana", "Ben"];
        world.dims = { Ben: "minecraft:the_nether" };
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(42_100);
        expect(state().run?.stage?.built).toBe(true);
        expect(state().run?.placeFrom?.near).toBe("Ana");
        // Ben is brought in from the Nether, his things kept for him like anybody's.
        expect(
            state()
                .run?.stage?.saved.map((one) => one.name)
                .sort()
        ).toEqual(["Ana", "Ben"]);
        expect(
            world.sent.some((line) => /^execute in minecraft:overworld run tp Ben /.test(line))
        ).toBe(true);
    });

    it("says nobody is in the Overworld rather than that there was no ground", async () => {
        world.online = ["Ana", "Ben"];
        world.dims = { Ana: "minecraft:the_nether", Ben: "minecraft:the_end" };
        setUp([race()]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(60_000);
        expect(state().history[0]?.outcome).toBe("failed");
        expect(state().history[0]?.note).toBe("Nobody is in the Overworld to hold it near");
    });
});

describe("a parkour race on a server before 1.16", () => {
    it("admits whoever joins, the world they are in read as a number", async () => {
        world.version = "1.15.2";
        world.online = ["Ana", "Ben"];
        setUp([
            {
                ...newPreset("parkour", "race"),
                minutes: 5,
                options: {
                    place: { mode: "players" as const },
                    jumps: 12,
                    difficulty: "medium" as const,
                    height: 30
                }
            }
        ]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(42_100);
        expect(state().run?.stage?.saved.map((one) => one.name)).toEqual(["Ana", "Ben"]);
        expect(
            state().run?.stage?.saved.every((one) => one.dimension === "minecraft:overworld")
        ).toBe(true);
    });
});

describe("spleef", () => {
    const floor = (variant: "random" | "shovel" | "decay" | "snowballs" = "shovel") => ({
        ...newPreset("spleef", "floor"),
        minutes: 5,
        options: { place: { mode: "players" as const }, size: 6, height: 30, variant }
    });

    it("hands the shovels out only once everybody is on the floor, after the countdown", async () => {
        world.online = ["Ana", "Ben"];
        world.stuck = ["Ben"];
        setUp([floor()]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        for (let tick = 0; tick < 200 && !state().run?.stage?.racers.length; tick += 1)
            await play(500);
        await play(6_000);
        const shovel = (name: string) =>
            world.sent.findIndex((line) => line.startsWith(`give ${name} minecraft:iron_shovel`));
        // Ben is not on the floor yet: nobody digs.
        expect(shovel("Ana")).toBe(-1);
        expect(state().run!.readyAt).toBeNull();
        const run = state().run!;
        const arenaAt = spleef.arena(floor().options, run.stage!.origin!, run.stage!.origin!.y);
        world.stuck = [];
        world.at.Ben = [arenaAt.center.x + 0.5, arenaAt.floor + 1, arenaAt.center.z + 0.5];
        await play(8_000);
        const one = world.sent.findIndex(
            (line) => line.includes(" title ") && visible(line).endsWith(" title 1")
        );
        expect(one).toBeGreaterThan(-1);
        expect(shovel("Ana")).toBeGreaterThan(one);
        expect(shovel("Ben")).toBeGreaterThan(one);
        expect(state().run!.readyAt).not.toBeNull();
    });

    it("hands out a marked shovel, sends whoever falls through home, and the last one standing wins", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        setUp([floor()]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"], ["Cy", "unirse"]);
        await play(44_000);
        const run = state().run!;
        expect(run.stage?.racers.map((one) => one.name)).toEqual(["Ana", "Ben", "Cy"]);
        await play(8_000);
        expect(
            world.sent.some((line) =>
                line.startsWith(
                    "give Ana minecraft:iron_shovel[minecraft:custom_data={polaris_event:1b}"
                )
            )
        ).toBe(true);
        // No snowballs of any kind.
        expect(world.sent.some((line) => line.includes("snowball"))).toBe(false);

        const arenaAt = spleef.arena(floor().options, run.stage!.origin!, run.stage!.origin!.y);
        // A drop to the floor below is not out; through the lowest one is.
        world.at.Ben = [arenaAt.center.x, arenaAt.floors[1]! + 1, arenaAt.center.z];
        await play(2_100);
        expect(world.inside.has("Ben")).toBe(true);
        world.at.Ben = [arenaAt.center.x, arenaAt.floors.at(-1)! - 3, arenaAt.center.z];
        await play(2_100);
        expect(world.inside.has("Ben")).toBe(false);
        expect(
            world.sent.some(
                (line) => line.startsWith("tellraw @a") && visible(line).includes("Ben is out")
            )
        ).toBe(true);
        world.at.Cy = [arenaAt.center.x, arenaAt.floors.at(-1)! - 3, arenaAt.center.z];
        await play(4_100);

        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("Ana was the last one standing");
        expect(after.history[0]?.podium).toEqual([
            { place: 1, name: "Ana", score: 3 },
            { place: 2, name: "Cy", score: 2 },
            { place: 3, name: "Ben", score: 1 }
        ]);
        expect(world.sent).toContain("clear Ana *[minecraft:custom_data={polaris_event:1b}]");
        expect(world.inside.size).toBe(0);
        keptTheRules();
        expect(after.stageLeftovers).toEqual([]);
    });

    it("in the decay game, turns the snow underfoot red and takes it, and clears every red block at the end", async () => {
        world.online = ["Ana", "Ben"];
        setUp([floor("decay")]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        await play(8_000);
        const run = state().run!;
        // No tool at all: the floor goes by itself.
        expect(world.sent.some((line) => line.includes("iron_shovel"))).toBe(false);
        expect(run.stage?.boxes.some((box) => box.block === spleef.WARN)).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.includes(`if block ~ ~-1 ~ ${spleef.FLOOR}`) &&
                    line.endsWith(`run setblock ~ ~-1 ~ ${spleef.WARN}`)
            )
        ).toBe(true);
        await events.cancelEvent("owner", SERVER);
        await play(4_200);
        expect(
            world.sent.some((line) => line.endsWith(`minecraft:air replace ${spleef.WARN}`))
        ).toBe(true);
        expect(state().stageLeftovers).toEqual([]);
    });

    it("in the snowball game, hands out marked snowballs and no shovel", async () => {
        world.online = ["Ana", "Ben"];
        setUp([floor("snowballs")]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        await play(8_000);
        expect(world.sent).toContain(
            "give Ana minecraft:snowball[minecraft:custom_data={polaris_event:1b}] 16"
        );
        expect(world.sent.some((line) => line.includes("iron_shovel"))).toBe(false);
        await events.cancelEvent("owner", SERVER);
        await play(4_200);
        expect(world.sent).toContain("clear Ana *[minecraft:custom_data={polaris_event:1b}]");
    });

    it("in the snowball game, puts the data pack on before the throwing starts, arms it for the arena, and switches it off at the end", async () => {
        world.online = ["Ana", "Ben"];
        setUp([floor("snowballs")]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        await play(8_000);
        const run = state().run!;
        const arenaAt = spleef.arena(
            floor("snowballs").options,
            run.stage!.origin!,
            run.stage!.origin!.y
        );
        const root = `/data/world/datapacks/${snowballPack.PACK_DIR}`;
        // Every file of the pack, in the world the settings name.
        expect([...world.files.keys()].sort()).toEqual(
            [...snowballPack.packFiles().keys()].map((path) => `${root}/${path}`).sort()
        );
        expect(world.packsOn.has(snowballPack.PACK_ID)).toBe(true);
        // Taken in with /datapack, never with a bare /reload (Bukkit's, on Paper).
        expect(world.sent.some((line) => /^(minecraft:)?reload\b/.test(line))).toBe(false);
        // On before the snowballs are handed out, and armed for this arena.
        const enabledAt = world.sent.indexOf(`datapack enable "${snowballPack.PACK_ID}"`);
        const givenAt = world.sent.findIndex((line) =>
            line.startsWith("give Ana minecraft:snowball")
        );
        expect(enabledAt).toBeGreaterThan(-1);
        expect(enabledAt).toBeLessThan(givenAt);
        for (const line of snowballPack.armLines(arenaAt)) expect(world.sent).toContain(line);

        await events.cancelEvent("owner", SERVER);
        await play(4_200);
        for (const line of snowballPack.stopLines(arenaAt.boxes))
            expect(world.sent).toContain(line);
        expect(state().stageLeftovers).toEqual([]);

        // The next game finds the pack as it was: nothing written, nothing reloaded.
        world.writes = [];
        const enables = world.sent.filter((line) => line.startsWith("datapack enable")).length;
        setUp([floor("snowballs")]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(52_000);
        expect(
            world.sent.filter((line) => line.startsWith("give Ana minecraft:snowball")).length
        ).toBeGreaterThan(1);
        expect(world.writes).toEqual([]);
        expect(world.sent.filter((line) => line.startsWith("datapack enable")).length).toBe(
            enables
        );
    });

    it("is called off before anything is built when too few join, and moves nobody", async () => {
        setUp([floor()]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "join"]);
        await play(34_000);
        expect(state().history[0]).toMatchObject({
            outcome: "cancelled",
            note: "Only 1 joined; it needs 2"
        });
        expect(world.sent.some((line) => line.includes(" fill "))).toBe(false);
        expect(world.sent.some((line) => line.includes(" tp "))).toBe(false);
    });

    it("leaves a player in creative out, and calls it off with everything undone when that leaves too few", async () => {
        world.modes = { Ben: 1 };
        setUp([floor()]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(44_000);
        const after = state();
        expect(after.history[0]).toMatchObject({ outcome: "cancelled" });
        expect(world.sent.some((line) => / tp Ben /.test(line))).toBe(false);
        // Written down, never moved: nothing of hers is touched on the way out.
        expect(world.sent.some((line) => / tp Ana /.test(line))).toBe(false);
        expect(world.sent.some((line) => /^gamemode \w+ Ana$/.test(line))).toBe(false);
        keptTheRules();
        expect(after.stageLeftovers).toEqual([]);
    });

    it("undoes an arena whose end was interrupted by a restart, on the next sweeps", async () => {
        const preset = floor();
        setUp([preset]);
        const now = Date.now();
        const site = { x: 300, y: 100, z: 0 };
        const boxes = spleef.arena(preset.options, site, site.y).boxes;
        world.inside = new Set(["Ana"]);
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "interrupted",
                trigger: "manual",
                startedBy: null,
                preset,
                phase: "running",
                createdAt: now - 120_000,
                startsAt: now - 90_000,
                endsAt: now + 60_000,
                participants: ["Ana"],
                finishing: true,
                stage: {
                    origin: site,
                    area: { x1: 293, z1: -7, x2: 307, z2: 7 },
                    boxes,
                    built: true,
                    saved: [
                        {
                            name: "Ana",
                            dimension: "minecraft:the_nether",
                            x: 10.5,
                            y: 64,
                            z: -3.25,
                            yaw: 90,
                            pitch: 0,
                            mode: "survival"
                        }
                    ],
                    racers: [{ name: "Ana", since: now - 90_000 }]
                }
            }
        };
        await events.sweepEvents();
        expect(state().run).toBeNull();
        expect(state().stageLeftovers.map((one) => one.runId)).toEqual(["interrupted"]);
        await events.sweepEvents();
        expect(world.sent).toContain(
            "execute in minecraft:the_nether run tp Ana 10.500 64.000 -3.250 90.0 0.0"
        );
        expect(world.sent).toContain("clear Ana *[minecraft:custom_data={polaris_event:1b}]");
        // Anything standing on it floats down before a block of it goes.
        const floated = world.sent.findIndex((line) => line.includes("minecraft:slow_falling 60"));
        expect(floated).toBeGreaterThanOrEqual(0);
        expect(floated).toBeLessThan(
            world.sent.findIndex((line) => line.includes("minecraft:air replace"))
        );
        for (const box of boxes) {
            expect(world.sent).toContain(
                `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace ${box.block}`
            );
        }
        expect(world.sent).toContain(
            "execute in minecraft:overworld run forceload remove 293 -7 307 7"
        );
        expect(state().stageLeftovers).toEqual([]);
    });

    it("never moves again somebody an end stopped by a restart had already sent back", async () => {
        const preset = floor();
        setUp([preset]);
        const now = Date.now();
        const site = { x: 300, y: 100, z: 0 };
        const boxes = spleef.arena(preset.options, site, site.y).boxes;
        const saved = (name: string, x: number) => ({
            name,
            dimension: "minecraft:overworld",
            x,
            y: 64,
            z: 5,
            yaw: 0,
            pitch: 0,
            mode: "survival"
        });
        // Ben was sent back - and his tag taken - before the end was stopped;
        // Ana is still up on the floor.
        world.inside = new Set(["Ana"]);
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "interrupted",
                trigger: "manual",
                startedBy: null,
                preset,
                phase: "running",
                createdAt: now - 120_000,
                startsAt: now - 90_000,
                endsAt: now + 60_000,
                participants: ["Ana", "Ben"],
                finishing: true,
                stage: {
                    origin: site,
                    area: { x1: 293, z1: -7, x2: 307, z2: 7 },
                    boxes,
                    built: true,
                    saved: [saved("Ana", 10.5), saved("Ben", 20.5)],
                    racers: [
                        { name: "Ana", since: now - 90_000 },
                        { name: "Ben", since: now - 90_000 }
                    ]
                }
            }
        };
        await events.sweepEvents();
        await events.sweepEvents();
        expect(world.sent).toContain(
            "execute in minecraft:overworld run tp Ana 10.500 64.000 5.000 0.0 0.0"
        );
        expect(world.sent.some((line) => / tp Ben /.test(line))).toBe(false);
        expect(world.sent).not.toContain("gamemode survival Ben");
        expect(world.inside.size).toBe(0);
        expect(state().stageLeftovers).toEqual([]);
    });

    it("picks a running one back up after a restart and still brings everybody back", async () => {
        const preset = floor();
        setUp([preset]);
        const now = Date.now();
        const site = { x: 300, y: 100, z: 0 };
        const boxes = spleef.arena(preset.options, site, site.y).boxes;
        world.inside = new Set(["Ana", "Ben"]);
        world.at = { Ana: [301, 101, 1], Ben: [299, 101, -1] };
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed-floor",
                trigger: "manual",
                startedBy: null,
                preset,
                phase: "running",
                createdAt: now - 60_000,
                startsAt: now - 30_000,
                endsAt: now + 60_000,
                participants: ["Ana", "Ben"],
                place: { x: 300, y: 70, z: 0 },
                stage: {
                    origin: site,
                    area: { x1: 293, z1: -7, x2: 307, z2: 7 },
                    boxes,
                    built: true,
                    armed: true,
                    saved: [
                        {
                            name: "Ana",
                            dimension: "minecraft:overworld",
                            x: 1,
                            y: 64,
                            z: 2,
                            yaw: 0,
                            pitch: 0,
                            mode: "survival"
                        },
                        {
                            name: "Ben",
                            dimension: "minecraft:overworld",
                            x: 5,
                            y: 64,
                            z: 6,
                            yaw: 0,
                            pitch: 0,
                            mode: "adventure"
                        }
                    ],
                    racers: [
                        { name: "Ana", since: now - 30_000 },
                        { name: "Ben", since: now - 30_000 }
                    ]
                }
            }
        };
        await events.sweepEvents();
        expect(events.runningEvents()).toContain(SERVER);
        await play(2_100);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(world.sent).toContain(
            "execute in minecraft:overworld run tp Ana 1.000 64.000 2.000 0.0 0.0"
        );
        expect(world.sent).toContain("gamemode adventure Ben");
        for (const box of boxes) {
            expect(world.sent).toContain(
                `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace ${box.block}`
            );
        }
        expect(state().stageLeftovers).toEqual([]);
    });
});

// ------------------------------------------------------------------ events players join

/** Every block an event put in or took out, and how. */
const fills = () => world.sent.filter((line) => line.includes(" run fill "));

/** Nothing was ever filled but into air, or emptied but of our own blocks. */
function onlyOurBlocks(): void {
    for (const line of fills()) {
        expect(
            line.endsWith(" keep") || / minecraft:air replace minecraft:[a-z_]+$/.test(line)
        ).toBe(true);
    }
    for (const line of takesItems(world.sent).filter((one) => one.startsWith("clear "))) {
        expect(line).toContain("polaris_event:1b");
    }
}

/** A run that joined, built and brought everybody in: countdown, joins, setup. */
async function joinAndStart(presetId: string, joiners = ["Ana", "Ben"]): Promise<void> {
    await events.startEvent({
        ownerId: "owner",
        installedAppId: SERVER,
        presetId,
        trigger: "manual",
        startedBy: null
    });
    // The countdown is at least half a minute, whatever the settings say, to
    // give time to type join.
    expect(state().run!.startsAt - state().run!.createdAt).toBe(catalog.JOIN_SECONDS * 1000);
    await play(2_100);
    chat(...joiners.map((name): [string, string] => [name, name === "Ben" ? "unirse" : "join"]), [
        "Dee",
        "hello"
    ]);
    await play(30_000);
    expect(state().run?.joined).toEqual(joiners);
    await play(20_000);
}

/** A king of the hill anybody walks to: fists only off. */
function walkInHill() {
    const preset = newPreset("king-of-the-hill", "hill");
    return { ...preset, options: { ...preset.options, fistsOnly: false } };
}

// ------------------------------------------------------------------ players' own things

/** A bag worth keeping: an enchanted sword, a shulker full of diamonds, a
 *  helmet worn and a shield in the offhand. */
function stuffed(): Map<number, Stack> {
    return new Map<number, Stack>([
        [
            0,
            {
                id: "minecraft:diamond_sword",
                count: 1,
                components: '{"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}}'
            }
        ],
        [
            9,
            {
                id: "minecraft:shulker_box",
                count: 1,
                components:
                    '{"minecraft:container": [{slot: 0, item: {id: "minecraft:diamond", count: 64}}]}'
            }
        ],
        [20, { id: "minecraft:cooked_beef", count: 12 }],
        [103, { id: "minecraft:diamond_helmet", count: 1 }],
        [-106, { id: "minecraft:shield", count: 1 }]
    ]);
}

const copyOf = (bag: Map<number, Stack>) =>
    new Map([...bag].map(([slot, stack]) => [slot, { ...stack }]));

describe("players' own things through an arena", () => {
    const duelOf = () => ({ ...newPreset("team-duel", "duel"), minutes: 3 });

    it("keeps everything in the database, and gives it back home and down before the prizes", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        world.dealt = { Ana: 10 };
        world.inv = { Ana: stuffed(), Ben: new Map([[4, { id: "minecraft:bread", count: 5 }]]) };
        world.levels = { Ana: 12 };
        world.points = { Ana: 7 };
        const ana = copyOf(world.inv.Ana!);
        const ben = copyOf(world.inv.Ben!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        const run = state().run!;
        // Everything off them, and kept - experience too.
        expect(ownStacks(world.inv.Ana!)).toBe(0);
        expect(ownStacks(world.inv.Ben!)).toBe(0);
        expect(world.levels.Ana).toBe(0);
        expect(world.points.Ana).toBe(0);
        const anaStash = run.entrants.find((one) => one.name === "Ana")!.stash!;
        expect(anaStash.kept.map((one) => one.slot).sort((a, b) => a - b)).toEqual([
            -106, 0, 9, 20, 103
        ]);
        expect(anaStash.experience).toEqual({ levels: 12, points: 7 });
        // No barrel, no block of any kind: the database holds every stack whole.
        expect(anaStash.barrels).toEqual([]);
        expect(world.sent.some((line) => line.includes("minecraft:barrel"))).toBe(false);
        const rows = [...stashRows.values()];
        expect(rows.map((row) => row.player).sort()).toEqual(["Ana", "Ben"]);
        const items = JSON.parse(String(rows.find((row) => row.player === "Ana")!.items)) as {
            slot: number;
            data: { snbt: string } | null;
        }[];
        expect(items.find((one) => one.slot === 0)?.data?.snbt).toContain("sharpness");
        // Written down, then emptied; all before the kit and the move in.
        const kit = world.sent.findIndex((line) =>
            line.startsWith("give Ana minecraft:stone_sword")
        );
        const emptied = world.sent.indexOf("item replace entity Ana hotbar.0 with minecraft:air");
        expect(emptied).toBeGreaterThan(-1);
        expect(kit).toBeGreaterThan(emptied);

        world.at = { Ana: [300, 102, -8], Ben: [300, 102, 8] };
        await play(6_100);
        world.dealt = { Ana: 60 };
        world.hp = { Ben: 4 };
        await play(2_100);
        world.hp = {};
        const from = world.sent.length;
        await play(3 * 60_000);
        expect(state().run).toBeNull();
        // Byte for byte what they carried, and their experience, and nothing kept.
        expect(world.inv.Ana).toEqual(ana);
        expect(world.inv.Ben).toEqual(ben);
        expect(world.levels.Ana).toBeGreaterThanOrEqual(12);
        expect(world.points.Ana).toBe(7);
        expect(stashRows.size).toBe(0);
        // The kit off, home, down, their things back - and only then the prize.
        const end = world.sent.slice(from);
        const kitOff = end.findIndex((line) => line.startsWith("clear Ana minecraft:stone_sword"));
        const home = end.findIndex((line) =>
            line.startsWith("execute in minecraft:overworld run tp Ana ")
        );
        const down = end.findIndex((line) =>
            line.startsWith("execute as Ana at @s if block ~ ~-0.2 ~")
        );
        const back = end.findIndex((line) =>
            line.startsWith("item replace entity Ana hotbar.0 with minecraft:diamond_sword[")
        );
        const prize = end.indexOf("give Ana minecraft:diamond 5");
        expect(kitOff).toBeGreaterThan(-1);
        expect(home).toBeGreaterThan(kitOff);
        expect(down).toBeGreaterThan(home);
        expect(back).toBeGreaterThan(down);
        expect(prize).toBeGreaterThan(back);
        // keepInventory held until everybody was home and down, then put back.
        const kept = end.indexOf("gamerule keepInventory false");
        expect(kept).toBeGreaterThan(back);
        expect(state().arenaLeftovers).toEqual([]);
    });

    it("gives their game mode back once home, even when the give-back stops after", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        setUp([duelOf()]);
        await joinAndStart("duel");
        stashDeleteFails = true;
        await play(3 * 60_000 + 10_000);
        expect(state().arenaLeftovers.flatMap((one) => one.entrants.map((e) => e.name))).toContain(
            "Ana"
        );
        const home = world.sent.findLastIndex((line) =>
            line.startsWith("execute in minecraft:overworld run tp Ana ")
        );
        expect(home).toBeGreaterThan(-1);
        expect(world.sent.indexOf("gamemode survival Ana", home)).toBeGreaterThan(home);
    });

    it("drops a stack at their feet, whole and as theirs, when its slot is taken by the end", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        // Something picked up in the sword's slot while it ran.
        world.inv.Ana!.set(0, { id: "minecraft:dirt", count: 3 });
        await play(3 * 60_000 + 10_000);
        expect(state().run).toBeNull();
        expect(world.inv.Ana!.get(0)).toEqual({ id: "minecraft:dirt", count: 3 });
        for (const slot of [9, 20, 103, -106])
            expect(world.inv.Ana!.get(slot)).toEqual(ana.get(slot));
        const lying = [...world.drops.values()];
        expect(lying).toEqual([{ stack: ana.get(0), owner: "Ana" }]);
        // Dropped once home, never in the arena.
        const home = world.sent.findLastIndex((line) =>
            line.startsWith("execute in minecraft:overworld run tp Ana ")
        );
        const drop = world.sent.findIndex((line) =>
            / at Ana run summon minecraft:item /.test(line)
        );
        expect(home).toBeGreaterThan(-1);
        expect(drop).toBeGreaterThan(home);
        expect(stashRows.size).toBe(0);
    });

    it("drops it the way an older game writes items, before 1.20.5", async () => {
        world.version = "1.20.1";
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        // Snowballs picked up in the beef's slot while it ran, as a spleef's snow gives.
        world.inv.Ana!.set(20, { id: "minecraft:snowball", count: 4 });
        await play(3 * 60_000 + 10_000);
        expect(state().run).toBeNull();
        expect([...world.drops.values()]).toEqual([{ stack: ana.get(20), owner: "Ana" }]);
        expect(
            world.sent.some((line) => line.includes('{Item:{id:"minecraft:cooked_beef",Count:12b}'))
        ).toBe(true);
        expect(stashRows.size).toBe(0);
    });

    it("counts a dropped stack picked up the moment it lands as given back", async () => {
        world.online = ["Ana", "Ben"];
        world.pickUp = true;
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        world.inv.Ana!.set(0, { id: "minecraft:dirt", count: 3 });
        await play(3 * 60_000 + 10_000);
        expect(state().run).toBeNull();
        expect([...world.inv.Ana!.values()]).toContainEqual(ana.get(0));
        expect(world.drops.size).toBe(0);
        expect(stashRows.size).toBe(0);
    });

    it("gives nothing twice when it stopped between writing a stash down and emptying the slots", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        const kept = state().run!.entrants.find((one) => one.name === "Ana")!.stash!;
        // As if the slots were never emptied.
        world.inv.Ana = copyOf(ana);
        const stashService = await import(
            "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
        );
        const how = await stashService.giveBack(
            fakeServer(),
            "Ana",
            { ...kept, state: "taking" },
            async () => undefined
        );
        expect(how).toBe("done");
        expect(world.inv.Ana).toEqual(ana);
        expect(world.drops.size).toBe(0);
        expect(
            world.sent.some((line) =>
                /^item replace entity Ana \S+ with minecraft:(?!air)(?!.*polaris_event)/.test(line)
            )
        ).toBe(false);
    });

    it("keeps an offline player's things until they are back, then gives them back before their prize", async () => {
        world.online = ["Ana", "Ben"];
        world.dealt = { Ana: 10 };
        world.inv = { Ana: new Map(), Ben: stuffed() };
        const ben = copyOf(world.inv.Ben!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        world.at = { Ana: [300, 102, -8], Ben: [300, 102, 8] };
        await play(6_100);
        world.dealt = { Ana: 60 };
        world.hp = { Ben: 4 };
        await play(2_100);
        world.hp = {};
        // Ben logs off before the end.
        world.online = ["Ana"];
        await play(3 * 60_000);
        expect(state().run).toBeNull();
        const owed = state().arenaLeftovers;
        expect(owed).toHaveLength(1);
        expect(owed[0]!.entrants.map((one) => one.name)).toEqual(["Ben"]);
        expect(owed[0]!.entrants[0]!.stash?.kept).toHaveLength(5);
        expect(ownStacks(world.inv.Ben!)).toBe(0);
        expect(stashRows.size).toBe(1);
        // Back on: the sweep gives it all back.
        world.online = ["Ana", "Ben"];
        await events.sweepEvents();
        expect(world.inv.Ben).toEqual(ben);
        expect(state().arenaLeftovers).toEqual([]);
        expect(stashRows.size).toBe(0);
    });

    it("never gives anything back twice, even when a give-back stopped halfway", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        const kept = state().run!.entrants.find((one) => one.name === "Ana")!.stash!;
        const stashService = await import(
            "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
        );
        // The kit off first, as an end takes it before anything is given back.
        await fakeServer().say(["clear Ana *[minecraft:custom_data={polaris_event:1b}]"]);
        // A give-back that ran to the end once...
        expect(await stashService.giveBack(fakeServer(), "Ana", kept, async () => undefined)).toBe(
            "done"
        );
        expect(world.inv.Ana).toEqual(ana);
        // ...and again from the same stale record: nothing more is given.
        world.inv.Ana!.clear();
        const again = await stashService.giveBack(fakeServer(), "Ana", kept, async () => undefined);
        expect(again).toBe("done");
        expect(world.inv.Ana!.size).toBe(0);
    });

    it("gives back a restart's worth: a stack already in its own slot is not given again", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        const kept = state().run!.entrants.find((one) => one.name === "Ana")!.stash!;
        // Two stacks written back before the restart; the rest still owed.
        world.inv.Ana = new Map([
            [0, { ...ana.get(0)! }],
            [103, { ...ana.get(103)! }]
        ]);
        stashRows.get(kept.record!)!.writing = JSON.stringify(kept.kept.map((one) => one.slot));
        const stashService = await import(
            "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
        );
        const from = world.sent.length;
        expect(await stashService.giveBack(fakeServer(), "Ana", kept, async () => undefined)).toBe(
            "done"
        );
        expect(world.inv.Ana).toEqual(ana);
        expect(world.drops.size).toBe(0);
        const writes = world.sent
            .slice(from)
            .filter((line) => /^item replace entity Ana (hotbar\.0|armor\.head) with/.test(line));
        expect(writes).toEqual([]);
    });

    it("does not take a stack of their own since for the one kept, however alike", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        const kept = state().run!.entrants.find((one) => one.name === "Ana")!.stash!;
        // The same stack again in the same slot, of their own since: nothing was
        // ever written there by a give-back.
        world.inv.Ana = new Map([[0, { ...ana.get(0)! }]]);
        world.pickUp = true;
        const stashService = await import(
            "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
        );
        expect(await stashService.giveBack(fakeServer(), "Ana", kept, async () => undefined)).toBe(
            "done"
        );
        expect(
            [...world.inv.Ana!.values()].filter((stack) => stack.id === ana.get(0)!.id)
        ).toHaveLength(2);
    });

    it("adds their experience to what they earned since, and never sets it over it", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        world.levels = { Ana: 12 };
        world.points = { Ana: 7 };
        setUp([duelOf()]);
        await joinAndStart("duel");
        const kept = state().run!.entrants.find((one) => one.name === "Ana")!.stash!;
        expect(kept.experience).toEqual({ levels: 12, points: 7 });
        // A prize delivered before the give-back.
        world.levels.Ana = 5;
        const stashService = await import(
            "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
        );
        const from = world.sent.length;
        expect(await stashService.giveBack(fakeServer(), "Ana", kept, async () => undefined)).toBe(
            "done"
        );
        expect(world.levels.Ana).toBe(17);
        expect(world.points.Ana).toBe(7);
        expect(world.sent.slice(from).some((line) => line.startsWith("xp set Ana"))).toBe(false);
    });

    it("gives nothing back to somebody still falling, and gives it once they are down", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        world.aloft = ["Ana"];
        await play(3 * 60_000 + 30_000);
        expect(state().run).toBeNull();
        expect(world.inv.Ana!.size).toBe(0);
        expect(state().arenaLeftovers.flatMap((one) => one.entrants.map((e) => e.name))).toContain(
            "Ana"
        );
        expect(stashRows.size).toBe(1);
        // Down: the sweep gives it all back.
        world.aloft = [];
        await events.sweepEvents();
        expect(world.inv.Ana).toEqual(ana);
        expect(state().arenaLeftovers).toEqual([]);
        expect(stashRows.size).toBe(0);
    });

    it("gives worn armor back into the armor slots, checked", async () => {
        world.online = ["Ana", "Ben"];
        const armor = new Map<number, Stack>([
            [
                100,
                {
                    id: "minecraft:leather_boots",
                    count: 1,
                    components: '{"minecraft:dyed_color": {rgb: 16711680}}'
                }
            ],
            [
                101,
                {
                    id: "minecraft:golden_leggings",
                    count: 1,
                    components: '{"minecraft:damage": 10}'
                }
            ],
            [102, { id: "minecraft:elytra", count: 1 }],
            [
                103,
                {
                    id: "minecraft:diamond_helmet",
                    count: 1,
                    components: '{"minecraft:enchantments": {levels: {"minecraft:protection": 4}}}'
                }
            ]
        ]);
        world.inv = { Ana: copyOf(armor), Ben: new Map() };
        setUp([duelOf()]);
        await joinAndStart("duel");
        expect(ownStacks(world.inv.Ana!)).toBe(0);
        await play(3 * 60_000 + 10_000);
        expect(state().run).toBeNull();
        expect(world.inv.Ana).toEqual(armor);
        for (const slot of ["armor.feet", "armor.legs", "armor.head"])
            expect(
                world.sent.some((line) =>
                    line.startsWith(`item replace entity Ana ${slot} with minecraft:`)
                )
            ).toBe(true);
        expect(stashRows.size).toBe(0);
    });

    it("keeps out a player carrying a stack no number of commands can carry, with all of it, and calls off a duel left too small", async () => {
        world.online = ["Ana", "Ben"];
        const huge = {
            id: "minecraft:written_book",
            count: 1,
            components: `{"minecraft:custom_name": '"${"x".repeat(1200)}"'}`
        };
        const bread = { id: "minecraft:bread", count: 2 };
        world.inv = {
            Ana: new Map<number, Stack>([
                [3, huge],
                [4, bread]
            ]),
            Ben: new Map([[4, { id: "minecraft:bread", count: 5 }]])
        };
        setUp([duelOf()]);
        await joinAndStart("duel");
        await play(20_000);
        // Nothing of hers was taken, and she was never moved.
        expect(world.inv.Ana!.get(3)).toEqual(huge);
        expect(world.inv.Ana!.get(4)).toEqual(bread);
        expect(world.sent.some((line) => /^item replace entity Ana /.test(line))).toBe(false);
        expect(world.sent.some((line) => / tp Ana /.test(line))).toBe(false);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({
            outcome: "cancelled",
            keptOut: [{ name: "Ana", why: "untakeable", items: ["minecraft:written_book"] }]
        });
        // Ben, brought in, is back with everything.
        expect(world.inv.Ben!.get(4)).toEqual({ id: "minecraft:bread", count: 5 });
        expect(stashRows.size).toBe(0);
    });

    it("never counts or plays somebody kept out who could not be sent back, and still sends them home at the end", async () => {
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        const sayAll = server.sayAll;
        let gone = false;
        // Off the server the moment she is moved in: her bag cannot be looked
        // at again, and she cannot be sent back.
        server.sayAll = async (lines) => {
            await sayAll(lines);
            if (!gone && lines.some((line) => / tp Ana /.test(line))) {
                gone = true;
                world.online = ["Ben"];
            }
        };
        try {
            setUp([duelOf()]);
            await joinAndStart("duel");
        } finally {
            server.sayAll = sayAll;
        }
        expect(gone).toBe(true);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({
            outcome: "cancelled",
            keptOut: [{ name: "Ana", why: "unread" }]
        });
        expect(after.arenaLeftovers.flatMap((one) => one.entrants.map((e) => e.name))).toEqual([
            "Ana"
        ]);
        // Back on: sent home by the sweep, with everything.
        world.online = ["Ana", "Ben"];
        await events.sweepEvents();
        expect(world.inv.Ana).toEqual(ana);
        expect(state().arenaLeftovers).toEqual([]);
        expect(stashRows.size).toBe(0);
    });

    it("gives back a stash kept in barrels before this, and takes away only the blocks it placed", async () => {
        world.online = ["Ana"];
        world.inv = { Ana: new Map() };
        const sword = stuffed().get(0)!;
        const barrel = { x: 10, y: 90, z: 10 };
        const casing = [
            { x: 10, y: 89, z: 10 },
            { x: 9, y: 90, z: 10 }
        ];
        world.blocks.set("10 90 10", "minecraft:barrel");
        world.containers.set("10 90 10", new Map([[0, { ...sword }]]));
        world.blocks.set("10 89 10", "minecraft:barrier");
        // Somebody built over one of the casing's places since: not ours to take.
        world.blocks.set("9 90 10", "minecraft:stone");
        stashRows.set("00000000-0000-7000-8000-000000000099", {
            id: "00000000-0000-7000-8000-000000000099",
            installedAppId: SERVER,
            player: "Ana",
            event: "Build battle",
            items: JSON.stringify([
                {
                    slot: 0,
                    id: sword.id,
                    count: 1,
                    data: { era: "components", snbt: sword.components }
                }
            ]),
            barrels: JSON.stringify([barrel, { x: 11, y: 90, z: 10 }]),
            casing: JSON.stringify(casing),
            status: "failed",
            note: "3 stack(s) could not be given back and checked",
            missing: JSON.stringify([0]),
            experience: null,
            dismissedAt: null,
            updatedAt: new Date()
        });
        const stashService = await import(
            "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
        );
        const failed = await stashService.failedStashes(SERVER);
        expect(failed[0]).toMatchObject({
            player: "Ana",
            missing: 1,
            barrels: [barrel, { x: 11, y: 90, z: 10 }]
        });
        expect(
            await stashService.retryStash(
                fakeServer(),
                SERVER,
                "00000000-0000-7000-8000-000000000099"
            )
        ).toBe("done");
        expect(world.inv.Ana!.get(0)).toEqual(sword);
        expect(stashRows.size).toBe(0);
        expect(world.blocks.has("10 90 10")).toBe(false);
        expect(world.blocks.has("10 89 10")).toBe(false);
        expect(world.blocks.get("9 90 10")).toBe("minecraft:stone");
    });

    it("keeps nothing on a server before 1.17, which has no item command: the kit goes beside", async () => {
        world.version = "1.16.5";
        world.online = ["Ana", "Ben"];
        world.inv = { Ana: stuffed(), Ben: new Map() };
        const ana = copyOf(world.inv.Ana!);
        setUp([duelOf()]);
        await joinAndStart("duel");
        expect(world.inv.Ana).toEqual(ana);
        expect(world.sent.some((line) => line.includes("item replace"))).toBe(false);
        // The shield beside the rest, where the off hand may not be free.
        expect(world.sent.some((line) => line.startsWith("give Ana minecraft:shield{"))).toBe(true);
        expect(state().run!.entrants.every((one) => one.stash === null)).toBe(true);
    });
});

/** The game as the stash service sees it, outside a running event. */
function fakeServer() {
    return {
        installedAppId: SERVER,
        say: async (argv: readonly string[]) => answer(argv.join(" ")),
        sayAll: async (lines: readonly string[]) => {
            for (const line of lines) answer(line);
        }
    } as unknown as Parameters<
        (typeof import("@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"))["giveBack"]
    >[0];
}

describe("a king of the hill", () => {
    const fists = () => ({ ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 });

    it("is three minutes long and fists only unless the operator says otherwise", () => {
        const fresh = catalog.newPreset("king-of-the-hill", "hill");
        expect(fresh.minutes).toBe(catalog.HILL_MINUTES);
        expect(catalog.HILL_MINUTES).toBe(3);
        expect((fresh.options as { fistsOnly: boolean }).fistsOnly).toBe(true);
        expect(catalog.playsInArena(fresh)).toBe(true);
        expect(catalog.takesJoiners(fresh)).toBe(true);
        expect(catalog.needsPvp(fresh)).toBe(true);
        expect(catalog.playsInArena(walkInHill())).toBe(false);
    });

    it("reads one saved on the old ten or four minutes as three, and leaves any other length alone", () => {
        const old = (
            minutes: number,
            options: Record<string, unknown> = { place: { mode: "players" }, radius: 6 }
        ) => ({
            ...catalog.newPreset("king-of-the-hill", `hill-${minutes}`),
            minutes,
            options
        });
        const read = catalog.readEventsConfig({
            [catalog.EVENTS_KEY]: {
                settings: {},
                presets: [
                    old(10),
                    old(4),
                    old(15),
                    old(10, { place: { mode: "players" }, radius: 6, fistsOnly: false }),
                    { ...catalog.newPreset("mining-rush", "rush"), minutes: 10 }
                ],
                schedules: []
            }
        });
        expect(read.presets.map((one) => [one.id, one.minutes])).toEqual([
            ["hill-10", 3],
            ["hill-4", 3],
            ["hill-15", 15],
            ["hill-10", 10],
            // Any other kind still on the old ten minutes takes its own default.
            ["rush", 5]
        ]);
        expect((read.presets[0]!.options as { fistsOnly: boolean }).fistsOnly).toBe(true);
    });

    it("is called King of the ring now, and one saved under the old default name reads as the new one", () => {
        expect(catalog.KIND_NAMES["king-of-the-hill"]).toEqual({
            en: "King of the ring",
            es: "Rey del ring"
        });
        const named = (id: string, name: string) => ({
            ...catalog.newPreset("king-of-the-hill", id),
            name
        });
        const read = catalog.readEventsConfig({
            [catalog.EVENTS_KEY]: {
                settings: {},
                presets: [
                    named("en", "King of the hill"),
                    named("es", "Rey de la colina"),
                    named("own", "Friday hill"),
                    { ...catalog.newPreset("mining-rush", "rush"), name: "King of the hill" }
                ],
                schedules: []
            }
        });
        // A name the operator typed, or another kind's, is left as it is.
        expect(read.presets.map((one) => [one.id, one.name])).toEqual([
            ["en", "King of the ring"],
            ["es", "Rey del ring"],
            ["own", "Friday hill"],
            ["rush", "King of the hill"]
        ]);
    });

    it("with fists only: who joined is brought to the circle empty-handed, cannot die, and gets it all back", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        world.inv = {
            Ana: stuffed(),
            Ben: new Map([[4, { id: "minecraft:iron_sword", count: 1 }]])
        };
        const ana = copyOf(world.inv.Ana!);
        const ben = copyOf(world.inv.Ben!);
        setUp([fists()]);
        await joinAndStart("hill");
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        expect(run.entrants.map((one) => one.name).sort()).toEqual(["Ana", "Ben"]);
        // Nothing in their hands - no weapon, no armor - and no kit either.
        expect(world.inv.Ana!.size).toBe(0);
        expect(world.inv.Ben!.size).toBe(0);
        expect(world.sent.some((line) => /^give (Ana|Ben) /.test(line))).toBe(false);
        // Round the circle, in adventure mode.
        expect(world.sent).toContain("gamemode adventure Ana");
        expect(
            world.sent.some((line) =>
                / positioned over motion_blocking_no_leaves run tp Ana ~ ~ ~ /.test(line)
            )
        ).toBe(true);
        // keepInventory held.
        expect(world.sent).toContain("gamerule keepInventory true");
        await play(2_100);
        // The hill wears down whoever is off it - only while they have more than
        // three hearts - and mends whoever holds it; a punch is softened, its
        // knockback left whole; a fall off it is slow.
        expect(world.sent).toContain("effect give @a[tag=pe_arena] minecraft:resistance 10 3 true");
        expect(world.sent).toContain("scoreboard objectives add pe_khp health");
        expect(world.sent).toContain(
            "effect give @a[tag=pe_arena,scores={pe_khp=7..}] minecraft:poison 3 1 true"
        );
        expect(
            world.sent.some(
                (line) =>
                    line.includes("minecraft:slow_falling 3 0 true") &&
                    line.includes("@a[tag=pe_arena,x=")
            )
        ).toBe(true);
        const place0 = state().run!.place!;
        expect(world.sent).toContain(
            `execute in minecraft:overworld positioned ${place0.x + 0.5} ${place0.y} ${place0.z + 0.5} as @a[tag=pe_arena,distance=..6] run effect give @s minecraft:regeneration 3 1 true`
        );
        expect(world.sent.some((line) => line.includes("resistance 10 4"))).toBe(false);
        // The side panel reads each time held as a time.
        world.scores = { Ana: 75 };
        await play(2_100);
        expect(world.sent).toContain(
            'scoreboard players display numberformat Ana pe_score fixed {"text":"1.3 min"}'
        );
        // Only those it brought score, and only one standing in the ring alone.
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("execute if score #inside pe_kin matches 1 ") &&
                    line.endsWith(
                        "as @a[tag=pe_arena,distance=..6,gamemode=!spectator] run scoreboard players add @s pe_score 2"
                    )
            )
        ).toBe(true);
        // Knocked off, far down: brought back to the edge.
        const place = state().run!.place!;
        world.at = { Ana: [place.x, place.y - 20, place.z], Ben: [place.x + 1, place.y, place.z] };
        const from = world.sent.length;
        await play(2_100);
        expect(world.sent.slice(from).some((line) => / run tp Ana ~ ~ ~ /.test(line))).toBe(true);
        expect(world.sent.slice(from).some((line) => / run tp Ben ~ ~ ~ /.test(line))).toBe(false);
        world.scores = { Ana: 60, Ben: 30 };
        await play(3 * 60_000);
        expect(state().run).toBeNull();
        expect(world.inv.Ana).toEqual(ana);
        expect(world.inv.Ben).toEqual(ben);
        expect(stashRows.size).toBe(0);
        expect(state().history[0]?.podium).toEqual([
            { place: 1, name: "Ana", score: 60 },
            { place: 2, name: "Ben", score: 30 }
        ]);
        expect(world.sent).toContain("gamerule keepInventory false");
        expect(state().arenaLeftovers).toEqual([]);
        keptTheRules();
    });

    it("with fists only: counts nothing until everybody stands on the platform, then says Go", async () => {
        world.online = ["Ana", "Ben"];
        setUp([fists()]);
        await joinAndStart("hill");
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        const entered = world.sent.findIndex((line) => / run tp Ben ~ ~ ~ /.test(line));
        const go = world.sent.findIndex((line) => line.includes(" title ") && line.includes("Go!"));
        expect(entered).toBeGreaterThan(-1);
        // Nothing counted before the start, and the start after everybody is in.
        expect(go).toBeGreaterThan(entered);
        expect(
            world.sent
                .slice(0, go)
                .some((line) => line.includes("scoreboard players add @s pe_score"))
        ).toBe(false);
        // Each put back on their own spot at the start: nobody closer for being first.
        expect(world.sent.slice(go - 10, go).some((line) => / run tp Ana ~ ~ ~ /.test(line))).toBe(
            true
        );
        expect(world.sent.some((line) => line.includes("Started without"))).toBe(false);
        // Brought up to it, nobody is told where it floats.
        expect(world.sent.some((line) => line.includes("The circle is at"))).toBe(false);
        // The clock starts at the "Go!", with the whole of its time ahead.
        expect(run.endsAt - run.readyAt!).toBe(3 * 60_000);
    });

    it("with fists only: starts without whoever is not up when the wait runs out, and says so", async () => {
        world.online = ["Ana", "Ben"];
        world.stuck = ["Ben"];
        setUp([fists()]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(30_000);
        // Up to the moment Ben is sent up, a little at a time.
        for (
            let tick = 0;
            tick < 200 && !world.sent.some((line) => / run tp Ben ~ ~ ~ /.test(line));
            tick += 1
        )
            await play(250);
        const entered = Date.now();
        expect(state().run!.readyAt).toBeNull();
        await play(hillService.ARRIVAL_MS - 4_000);
        // Still waiting: nothing counted, and those up told so.
        expect(state().run!.readyAt).toBeNull();
        expect(world.sent.some((line) => line.includes("scoreboard players add @s pe_score"))).toBe(
            false
        );
        expect(world.sent.some((line) => line.includes("Waiting for everybody"))).toBe(true);
        await play(8_000);
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        // Sent up within the last look before `entered`.
        expect(run.readyAt! - entered).toBeGreaterThanOrEqual(hillService.ARRIVAL_MS - 250);
        expect(world.sent.some((line) => line.includes("Started without waiting longer for"))).toBe(
            true
        );
        expect(world.sent.some((line) => line.includes(" title ") && line.includes("Go!"))).toBe(
            true
        );
    });

    it("with fists only: brings back whoever falls off while the rest are waited for", async () => {
        world.online = ["Ana", "Ben"];
        world.stuck = ["Ben"];
        setUp([fists()]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(30_000);
        for (
            let tick = 0;
            tick < 200 && !world.sent.some((line) => / run tp Ben ~ ~ ~ /.test(line));
            tick += 1
        )
            await play(250);
        await play(3_000);
        expect(state().run!.readyAt).toBeNull();
        const up = world.at.Ana!;
        world.at.Ana = [up[0], up[1] - 15, up[2]];
        const fell = world.sent.length;
        await play(2_000);
        expect(world.sent.slice(fell).some((line) => / run tp Ana ~ ~ ~ /.test(line))).toBe(true);
        expect(world.at.Ana![1]).toBe(up[1]);
        expect(state().run!.readyAt).toBeNull();
        await play(hillService.ARRIVAL_MS);
        expect(state().run!.readyAt).not.toBeNull();
        const without = world.sent.find((line) =>
            line.includes("Started without waiting longer for")
        );
        expect(without).toContain("Ben");
        expect(without).not.toContain("Ana");
    });

    it("with fists only: plays in rounds, the ring shrinking and moving, double at the end, the leader crowned", async () => {
        world.online = ["Ana", "Ben"];
        world.sea = true;
        setUp([fists()]);
        await joinAndStart("hill");
        await play(30_000);
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        expect(run.kit).toEqual([hill.CROWN]);
        const from = world.sent.length;
        world.scores = { Ana: 10, Ben: 4 };
        await play(2_100);
        // Ana is ahead: she glows, wears the crown, and everybody is told.
        expect(world.sent.slice(from)).toContain("effect give Ana minecraft:glowing 3 0 true");
        expect(
            world.sent
                .slice(from)
                .some((line) =>
                    /^item replace entity Ana armor\.head with minecraft:golden_helmet/.test(line)
                )
        ).toBe(true);
        expect(world.sent.slice(from).some((line) => line.includes("wears the crown"))).toBe(true);
        // Overtaken: the crown changes heads.
        world.scores = { Ana: 10, Ben: 20 };
        const overtaken = world.sent.length;
        await play(2_100);
        const after = world.sent.slice(overtaken);
        expect(after).toContain("effect clear Ana minecraft:glowing");
        expect(after.some((line) => /^clear Ana minecraft:golden_helmet/.test(line))).toBe(true);
        expect(
            after.some((line) =>
                /^item replace entity Ben armor\.head with minecraft:golden_helmet/.test(line)
            )
        ).toBe(true);
        // Through the first round: the ring drawn again smaller, and double at its end.
        const first = world.sent.length;
        await play(50_000);
        expect(state().run!.ring!.radius).toBeLessThan(6);
        expect(world.sent.some((line) => line.includes("Double points!"))).toBe(true);
        expect(
            world.sent.some((line) =>
                / minecraft:yellow_concrete replace minecraft:smooth_stone$/.test(line)
            )
        ).toBe(true);
        expect(
            world.sent.some((line) => / run scoreboard players add @s pe_score 4$/.test(line))
        ).toBe(true);
        // The second round: everybody back on their spot, nothing counted for a moment.
        await play(10_000);
        expect(state().run!.ring!.round).toBe(2);
        const later = world.sent.slice(first);
        const round = later.findIndex((line) => line.includes("Round 2/3"));
        expect(round).toBeGreaterThan(-1);
        expect(later.slice(0, round).some((line) => / run tp Ana ~ ~ ~ /.test(line))).toBe(true);
        await play(3 * 60_000);
        expect(state().run).toBeNull();
        expect(world.sent.some((line) => /^clear Ben minecraft:golden_helmet/.test(line))).toBe(
            true
        );
        expect(world.sent).toContain("scoreboard objectives remove pe_kin");
        keptTheRules();
    });

    it("with no untouched ground for the circle, stands on a platform of its own over the sea, taken away after", async () => {
        world.online = ["Ana", "Ben"];
        world.sea = true;
        setUp([fists()]);
        await joinAndStart("hill");
        await play(30_000);
        const run = state().run!;
        expect(run.arena?.blocks).toEqual([...hill.PLATFORM_BLOCKS]);
        expect(run.readyAt).not.toBeNull();
        // Only into air proven empty.
        const build = world.sent.find((line) => line.includes(" minecraft:smooth_stone keep"));
        expect(build).toBeDefined();
        await play(4 * 60_000);
        expect(state().run).toBeNull();
        expect(
            world.sent.some((line) => / minecraft:air replace minecraft:smooth_stone$/.test(line))
        ).toBe(true);
        keptTheRules();
    });

    it("walked to, on a platform over the sea when the island has no room, taken away at the end", async () => {
        world.online = ["Ana", "Ben"];
        world.sea = true;
        setUp([{ ...walkInHill(), minutes: 3 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(80_000);
        const run = state().run!;
        expect(run.arena?.blocks).toEqual([...hill.PLATFORM_BLOCKS]);
        expect(run.place!.y).toBe(run.arena!.box.y1 + 1);
        expect(
            world.sent.some((line) => line.includes("run scoreboard players add @s pe_score 2"))
        ).toBe(true);
        await play(4 * 60_000);
        expect(state().run).toBeNull();
        expect(
            world.sent.some((line) => / minecraft:air replace minecraft:smooth_stone$/.test(line))
        ).toBe(true);
        keptTheRules();
    });
});

describe("a team duel", () => {
    const duelOf = (minutes = 3) => ({ ...newPreset("team-duel", "duel"), minutes });

    it("finds its place over the open sea round an island, where it is built in the air", async () => {
        world.online = ["Ana", "Ben"];
        world.sea = true;
        setUp([duelOf()]);
        await joinAndStart("duel");
        await play(10_000);
        expect(state().run?.arena).toBeTruthy();
        expect(state().run?.readyAt).not.toBeNull();
        expect(world.sent.some((line) => line.endsWith(" keep"))).toBe(true);
    });

    it("hands out the kit only at Go, after the countdown, to everybody at once", async () => {
        world.online = ["Ana", "Ben"];
        setUp([duelOf()]);
        await joinAndStart("duel");
        await play(10_000);
        expect(state().run?.readyAt).not.toBeNull();
        const shown = (text: string) =>
            world.sent.findIndex(
                (line) => line.includes(" title ") && visible(line).endsWith(` title ${text}`)
            );
        const sword = (name: string) =>
            world.sent.findIndex((line) => line.startsWith(`give ${name} minecraft:stone_sword`));
        const entered = world.sent.findIndex((line) => / tp Ben /.test(line));
        expect(entered).toBeGreaterThan(-1);
        // Everybody in first, then 3-2-1, and only then a sword in anybody's hand.
        expect(shown("3")).toBeGreaterThan(entered);
        expect(shown("1")).toBeGreaterThan(shown("3"));
        expect(sword("Ana")).toBeGreaterThan(shown("1"));
        expect(sword("Ben")).toBeGreaterThan(shown("1"));
        expect(state().run!.readyAt! - state().run!.startsAt).toBe(0);
    });

    it("never runs its clock back up while the arena goes up", async () => {
        world.online = ["Ana", "Ben"];
        setUp([duelOf()]);
        await joinAndStart("duel");
        await play(10_000);
        expect(state().run?.readyAt).not.toBeNull();
        // The clock as the bar's name shows it, from the end of the countdown on.
        const start = world.sent.findLastIndex(
            (line) =>
                line.startsWith("bossbar set polaris:event name") && line.includes("starts in")
        );
        const shown = world.sent
            .slice(start + 1)
            .map((line) => /^bossbar set polaris:event name .*- (\d+):(\d\d)"/.exec(line))
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => Number(match[1]) * 60 + Number(match[2]));
        expect(shown.length).toBeGreaterThan(3);
        for (let index = 1; index < shown.length; index += 1)
            expect(shown[index]).toBeLessThanOrEqual(shown[index - 1]!);
    });

    it("builds its arena in the air, fights with a marked kit, and puts everything back", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        world.dealt = { Ana: 10 };
        setUp([duelOf()]);
        await joinAndStart("duel");
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        // Counted as nothing but air before anything was built, 30 blocks up.
        const box = run.arena!.box;
        expect(box.y1).toBe(70 + 30);
        expect(world.sent).toContain(
            `execute in minecraft:overworld if blocks ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} ${box.x1} ${box.y1} ${box.z1} masked`
        );
        expect(fills().length).toBeGreaterThan(0);
        expect(fills().every((line) => line.endsWith(" keep"))).toBe(true);
        // Where each was, written down before they were moved; Cy never typed join.
        expect(run.entrants.map((one) => [one.name, one.side, one.gamemode])).toEqual([
            ["Ana", 0, "survival"],
            ["Ben", 1, "survival"]
        ]);
        expect(
            world.sent.some((line) => /^execute in minecraft:overworld run tp Cy /.test(line))
        ).toBe(false);
        expect(world.sent).toContain("gamemode adventure Ana");
        expect(world.sent).toContain(
            "give Ana minecraft:stone_sword[minecraft:custom_data={polaris_event:1b}] 1"
        );
        expect(world.sent).toContain(
            "execute if entity @a[name=Ana,team=] run team join pe_red Ana"
        );
        expect(world.sent).toContain("team modify pe_blue friendlyFire false");
        // Nobody loses what they carry, even to a death.
        expect(world.sent).toContain("gamerule keepInventory true");
        // Nobody heals on a full belly, and the shield is already in the off hand.
        expect(world.sent).toContain("gamerule naturalRegeneration false");
        expect(world.sent).toContain(
            "item replace entity Ana weapon.offhand with minecraft:shield[minecraft:custom_data={polaris_event:1b}] 1"
        );
        expect(world.sent.some((line) => line.startsWith("give Ana minecraft:shield"))).toBe(false);

        // In the arena; Ben is brought low right after Ana strikes.
        // (Pulled in until now, so shielded a few seconds more.)
        world.at = { Ana: [300, 102, -8], Ben: [300, 102, 8] };
        await play(6_100);
        world.dealt = { Ana: 60 };
        world.hp = { Ben: 4 };
        await play(2_100);
        world.hp = {};
        expect(state().run?.points).toEqual({ Ana: 1 });
        expect(state().run?.tally).toEqual({ 0: 1 });
        expect(world.sent).toContain("scoreboard players set Ana pe_score 1");
        expect(
            world.sent.some((line) => line.startsWith("effect give Ben minecraft:resistance 5 4"))
        ).toBe(true);

        await play(3 * 60_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({ outcome: "finished" });
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 1 }]);
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        // What Ana dealt in the duel does not hold the next event up as a fight.
        expect(playing.seenOn(SERVER)?.get("ana")?.fightingAt ?? null).toBeNull();
        // Back exactly where each stood, their kit - only it - taken back.
        for (const one of run.entrants) {
            expect(world.sent).toContain(
                `execute in minecraft:overworld run tp ${one.name} ${one.x.toFixed(3)} ${one.y.toFixed(3)} ${one.z.toFixed(3)} ${one.yaw.toFixed(1)} ${one.pitch.toFixed(1)}`
            );
            expect(world.sent).toContain(`gamemode survival ${one.name}`);
            expect(world.sent).toContain(
                `clear ${one.name} minecraft:shield[minecraft:custom_data={polaris_event:1b}]`
            );
        }
        // The arena down, block kind by block kind, the rule and the teams put back.
        for (const block of run.arena!.blocks) {
            expect(world.sent).toContain(
                `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace ${block}`
            );
        }
        expect(world.sent.filter((line) => line.startsWith("gamerule keepInventory")).at(-1)).toBe(
            "gamerule keepInventory false"
        );
        expect(
            world.sent.filter((line) => line.startsWith("gamerule naturalRegeneration")).at(-1)
        ).toBe("gamerule naturalRegeneration true");
        expect(world.sent).toContain("team remove pe_red");
        expect(world.sent).toContain(
            `execute in minecraft:overworld run forceload remove ${box.x1} ${box.z1} ${box.x2} ${box.z2}`
        );
        expect(after.arenaLeftovers).toEqual([]);
        onlyOurBlocks();
    });

    it("turns healing on a full belly off under its 1.21.11 name, and puts it back after", async () => {
        world.online = ["Ana", "Ben"];
        world.renamedRules = true;
        setUp([duelOf()]);
        await joinAndStart("duel");
        expect(world.sent).toContain("gamerule natural_health_regeneration false");
        expect(world.sent).not.toContain("gamerule naturalRegeneration false");
        await play(3 * 60_000 + 10_000);
        expect(state().run).toBeNull();
        expect(
            world.sent
                .filter((line) => line.startsWith("gamerule natural_health_regeneration "))
                .at(-1)
        ).toBe("gamerule natural_health_regeneration true");
    });

    it("refuses to start on a server with PvP blocked, and says where to allow it", async () => {
        world.properties = "difficulty=normal\npvp=false\n";
        setUp([duelOf()]);
        const refused = await refusal(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "duel",
                trigger: "manual",
                startedBy: null
            })
        );
        expect(refused).toMatch(/Player versus player is Blocked.*Allow it under Settings/);
        expect(state().run).toBeNull();
    });

    it("is called off, with the reason, when fewer join than the event's own minimum", async () => {
        world.online = ["Ana", "Ben", "Cai"];
        setUp([{ ...duelOf(), minPlayers: 3 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "duel",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(40_000);
        expect(state().run).toBeNull();
        expect(state().history[0]).toMatchObject({
            outcome: "cancelled",
            note: "Only 2 joined; it needs 3"
        });
        expect(fills()).toEqual([]);
    });

    it("is off, with nothing built and nobody moved, when fewer than two join", async () => {
        setUp([duelOf()]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "duel",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        chat(["Ana", "join"]);
        await play(40_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({
            outcome: "cancelled",
            note: "Only 1 joined; it needs 2"
        });
        expect(fills()).toEqual([]);
        expect(world.sent.some((line) => / run tp (Ana|Ben) /.test(line))).toBe(false);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw @a") &&
                    visible(line).includes("Only 1 joined and it needs 2")
            )
        ).toBe(true);
    });

    it("does not start a fight on a server that will not say how it keeps inventories", async () => {
        world.keepInventory = "unknown";
        setUp([duelOf()]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "duel",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(40_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.outcome).toBe("failed");
        expect(after.history[0]?.note).toMatch(/keeps inventories/);
        expect(fills()).toEqual([]);
        expect(world.sent.some((line) => / run tp (Ana|Ben) /.test(line))).toBe(false);
    });

    it("never builds where the air is not empty, and gives the place up", async () => {
        world.solidCount = 3;
        setUp([duelOf()]);
        await joinAndStart("duel");
        await play(120_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.outcome).toBe("failed");
        expect(fills()).toEqual([]);
        expect(world.sent.some((line) => / run tp (Ana|Ben) /.test(line))).toBe(false);
        // Every area it loaded to look, let go of again.
        const added = world.sent.filter((line) =>
            / forceload add -?\d+ -?\d+ -?\d+ -?\d+$/.test(line)
        );
        expect(added.length).toBeGreaterThan(0);
        for (const line of added) expect(world.sent).toContain(line.replace(" add ", " remove "));
    });

    it("called off mid-fight, takes back exactly what it placed and handed out", async () => {
        setUp([duelOf(10)]);
        await joinAndStart("duel");
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        const built = fills().length;
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({ outcome: "cancelled", podium: [] });
        expect(world.sent.some((line) => line.startsWith("give Ana minecraft:diamond"))).toBe(
            false
        );
        const removed = fills().slice(built);
        expect(removed).toHaveLength(run.arena!.blocks.length);
        expect(removed.every((line) => line.includes("minecraft:air replace"))).toBe(true);
        for (const one of run.entrants) {
            expect(world.sent).toContain(
                `execute in minecraft:overworld run tp ${one.name} ${one.x.toFixed(3)} ${one.y.toFixed(3)} ${one.z.toFixed(3)} ${one.yaw.toFixed(1)} ${one.pitch.toFixed(1)}`
            );
        }
        expect(world.sent).toContain("gamerule keepInventory false");
        onlyOurBlocks();
    });

    it("keeps the arena up for somebody offline at the end, and sends them back when they are on", async () => {
        setUp([duelOf()]);
        await joinAndStart("duel");
        const run = state().run!;
        const ben = run.entrants.find((one) => one.name === "Ben")!;
        world.online = ["Ana"];
        await play(3 * 60_000);
        let after = state();
        expect(after.run).toBeNull();
        expect(after.arenaLeftovers).toHaveLength(1);
        expect(after.arenaLeftovers[0]?.entrants.map((one) => one.name)).toEqual(["Ben"]);
        // Still standing: logging in, he is inside it rather than in the air.
        expect(world.sent.some((line) => line.includes("minecraft:air replace"))).toBe(false);

        world.online = ["Ana", "Ben"];
        await events.sweepEvents();
        after = state();
        expect(after.arenaLeftovers).toEqual([]);
        expect(world.sent).toContain(
            `execute in minecraft:overworld run tp Ben ${ben.x.toFixed(3)} ${ben.y.toFixed(3)} ${ben.z.toFixed(3)} ${ben.yaw.toFixed(1)} ${ben.pitch.toFixed(1)}`
        );
        expect(world.sent).toContain("gamemode survival Ben");
        expect(
            world.sent.some((line) => line.includes("minecraft:air replace minecraft:barrier"))
        ).toBe(true);
        onlyOurBlocks();
    });

    it("is not joined by somebody still owed a trip back from the last one", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        setUp([duelOf()]);
        config[catalog.EVENT_STATE_KEY] = {
            arenaLeftovers: [
                {
                    id: "old",
                    kind: "team-duel",
                    arena: null,
                    marker: "components",
                    kit: [],
                    entrants: [
                        {
                            name: "Ana",
                            uuid: null,
                            dimension: "minecraft:overworld",
                            x: 1,
                            y: 64,
                            z: 1,
                            yaw: 0,
                            pitch: 0,
                            gamemode: "survival",
                            side: 0
                        }
                    ],
                    createdAt: Date.now()
                }
            ]
        };
        world.online = ["Ben", "Cy"];
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "duel",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.online = ["Ana", "Ben", "Cy"];
        chat(["Ana", "join"], ["Ben", "join"], ["Cy", "join"]);
        await play(50_000);
        expect(state().run?.entrants.map((one) => one.name)).toEqual(["Ben", "Cy"]);
    });
});

describe("a server whose version is not in today's log", () => {
    const duel = () => ({ ...newPreset("team-duel", "duel"), minutes: 3 });
    const kitGiven = () =>
        world.sent.filter((line) => line.startsWith("give ") && line.includes("polaris_event"));

    it("reads it out of the log rolled over at midnight", async () => {
        world.version = "1.20.1";
        world.versionIn = "archive";
        world.online = ["Ana", "Ben"];
        setUp([duel()]);
        await joinAndStart("duel");
        await play(10_000);
        expect(kitGiven().length).toBeGreaterThan(0);
        expect(world.refused.filter((line) => line.startsWith("give "))).toEqual([]);
    });

    it.each(["1.20.1", "1.21.4"])(
        "gives a duel's kit the way %s reads it when no log says which that is",
        async (version) => {
            world.version = version;
            world.versionIn = "none";
            world.online = ["Ana", "Ben"];
            setUp([duel()]);
            await joinAndStart("duel");
            await play(10_000);
            expect(kitGiven().length).toBeGreaterThan(0);
            expect(world.refused.filter((line) => line.startsWith("give "))).toEqual([]);
        }
    );

    it("does not start a duel on a server older than 1.16, known only by what it answers", async () => {
        world.version = "1.15.2";
        world.versionIn = "none";
        setUp([duel()]);
        const refused = await refusal(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "duel",
                trigger: "manual",
                startedBy: null
            })
        );
        expect(refused).toMatch(/needs Minecraft 1.16/);
    });
});

describe("a server with EssentialsX on it", () => {
    beforeEach(() => {
        world.bukkit = true;
        world.essentials = true;
    });

    it("runs a duel with the game's own commands: kit given and taken back, everybody home", async () => {
        world.online = ["Ana", "Ben"];
        setUp([{ ...newPreset("team-duel", "duel"), minutes: 3 }]);
        await joinAndStart("duel");
        await play(4 * 60_000);
        expect(world.pluginGot).toEqual([]);
        expect(world.sent.some((line) => line.startsWith("minecraft:give Ana "))).toBe(true);
        expect(world.sent.some((line) => /^minecraft:clear Ana \S+\[/.test(line))).toBe(true);
        expect(
            world.sent.some((line) => /^minecraft:execute in \S+ run minecraft:tp Ana /.test(line))
        ).toBe(true);
    });

    it("hands a prize over with the game's own give and xp", async () => {
        setUp([newPreset("fishing", "fish")], {
            random: { ...catalog.settingsSchema.parse({}).random }
        });
        config[catalog.EVENT_STATE_KEY] = {
            pending: [
                {
                    id: "p1",
                    player: "Ana",
                    reward: { items: [{ id: "minecraft:diamond", count: 2 }], levels: 5 },
                    event: "Fishing contest",
                    createdAt: Date.now()
                }
            ]
        };
        await events.sweepEvents();
        expect(world.pluginGot).toEqual([]);
        expect(world.sent).toContain("minecraft:give Ana minecraft:diamond 2");
        expect(world.sent).toContain("minecraft:xp add Ana 5 levels");
        expect(state().pending).toEqual([]);
    });

    it("sends vanilla and Fabric servers their lines as they are", async () => {
        world.bukkit = false;
        world.essentials = false;
        setUp([{ ...newPreset("blood-moon", "moon"), minutes: 3 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(4 * 60_000);
        expect(world.sent.filter((line) => line.startsWith("minecraft:"))).toEqual([
            "minecraft:difficulty"
        ]);
        expect(world.sent).toContain("kill @e[tag=pe_mob]");
    });
});

describe("a treasure hunt on 1.13, which has no `execute if data`", () => {
    it("finds its chests unopened, sees one opened, and takes the rest away at the end", async () => {
        world.version = "1.13.2";
        world.markFollows = true;
        world.online = ["Ana", "Ben"];
        setUp([
            {
                ...newPreset("treasure-hunt", "hunt"),
                minutes: 9,
                options: { ...newPreset("treasure-hunt", "hunt").options, chests: 2 }
            }
        ]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        for (let tick = 0; tick < 60 && (state().run?.chests.length ?? 0) < 1; tick += 1)
            await play(2_100);
        expect(state().run?.chests).toHaveLength(1);
        const [first] = state().run!.chests;
        await events.cancelEvent("owner", SERVER);
        await play(4_200);
        // Nobody opened it: it is gone again.
        expect(world.chests).toEqual([]);
        expect(first).toBeDefined();
    });
});

describe("a world boss's health", () => {
    it.each(["1.13.2", "1.15.2", "1.16.5", "1.21.4"])(
        "is what the event set on %s",
        async (version) => {
            world.version = version;
            setUp([groundBoss("boss", 3)]);
            await events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "boss",
                trigger: "manual",
                startedBy: null
            });
            await play(8_100);
            // 400 on Normal for one fighter.
            expect(state().run?.boss?.max).toBe(500);
            expect(world.bossMaxHealth).toBe(500);
        }
    );
});

describe("a world boss whose server's version is unknown", () => {
    it.each(["1.20.1", "1.21.4", "1.21.5", "26.1"])("wears its own name on %s", async (version) => {
        world.version = version;
        world.versionIn = "none";
        setUp([groundBoss("boss", 3)]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        expect(world.bossName).toMatch(/^[A-Z][\w ]+$/);
    });
});

describe("an arena after a restart", () => {
    const entrant = (name: string, side: number) => ({
        name,
        uuid: [side + 1, 2, 3, 4],
        dimension: "minecraft:the_nether",
        x: 12.5 + side,
        y: 70,
        z: -4.25,
        yaw: 45,
        pitch: 0,
        gamemode: "creative" as const,
        side,
        away: true
    });
    const box = { x1: 292, y1: 100, z1: -11, x2: 308, y2: 107, z2: 11 };
    const blocks = ["minecraft:barrier", "minecraft:red_stained_glass"];

    function stored(extra: Record<string, unknown>) {
        const duel = { ...newPreset("team-duel", "duel"), minutes: 10 };
        setUp([duel]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed",
                trigger: "manual",
                startedBy: null,
                preset: duel,
                phase: "running",
                createdAt: now - 120_000,
                startsAt: now - 90_000,
                endsAt: now + 30_000,
                participants: ["Ana", "Ben"],
                joined: ["Ana", "Ben"],
                enrolled: true,
                site: box,
                arena: { box, blocks },
                entrants: [entrant("Ana", 0), entrant("Ben", 1)],
                marker: "tag",
                kit: ["minecraft:stone_sword", "minecraft:shield"],
                readyAt: now - 80_000,
                gamerules: { keepInventory: "false" },
                ...extra
            }
        };
    }

    it("picked back up, still sends everybody back and takes the arena down", async () => {
        stored({});
        await events.sweepEvents();
        expect(events.runningEvents()).toContain(SERVER);
        await play(32_000);
        expect(state().run).toBeNull();
        expect(world.sent).toContain(
            "execute in minecraft:the_nether run tp Ana 12.500 70.000 -4.250 45.0 0.0"
        );
        expect(world.sent).toContain("gamemode creative Ana");
        expect(world.sent).toContain("clear Ana minecraft:stone_sword{polaris_event:1b}");
        expect(world.sent).toContain(
            "execute in minecraft:overworld run fill 292 100 -11 308 107 11 minecraft:air replace minecraft:red_stained_glass"
        );
        expect(world.sent).toContain("gamerule keepInventory false");
        onlyOurBlocks();
    });

    it("never moves again somebody an end stopped by a restart had already sent back", async () => {
        stored({
            finishing: true,
            endsAt: Date.now() - 1_000,
            entrants: [
                { ...entrant("Ana", 0), tagged: true },
                { ...entrant("Ben", 1), tagged: true }
            ]
        });
        // Ana was sent back, and her tag taken, before the end was stopped.
        world.tags = { pe_arena: new Set(["Ben"]) };
        await events.sweepEvents();
        await events.sweepEvents();
        expect(world.sent.some((line) => / tp Ana /.test(line))).toBe(false);
        expect(world.sent).not.toContain("gamemode creative Ana");
        expect(world.sent).toContain(
            "execute in minecraft:the_nether run tp Ben 13.500 70.000 -4.250 45.0 0.0"
        );
        expect(world.sent).toContain("tag Ben remove pe_arena");
        expect(world.tags.pe_arena?.size).toBe(0);
        expect(state().arenaLeftovers).toEqual([]);
        onlyOurBlocks();
    });

    it("still owes the trip to a tagged player who is offline, and sends them once they are on", async () => {
        stored({
            finishing: true,
            endsAt: Date.now() - 1_000,
            entrants: [
                { ...entrant("Ana", 0), tagged: true },
                { ...entrant("Ben", 1), tagged: true }
            ]
        });
        world.tags = { pe_arena: new Set(["Ana", "Ben"]) };
        world.online = ["Ana"];
        await events.sweepEvents();
        await events.sweepEvents();
        expect(state().arenaLeftovers[0]?.entrants.map((one) => one.name)).toEqual(["Ben"]);
        world.online = ["Ana", "Ben"];
        await events.sweepEvents();
        expect(world.sent).toContain(
            "execute in minecraft:the_nether run tp Ben 13.500 70.000 -4.250 45.0 0.0"
        );
        expect(state().arenaLeftovers).toEqual([]);
    });

    it("whose end had begun, is never played again but still undone by the sweep", async () => {
        stored({ finishing: true, endsAt: Date.now() - 1_000 });
        await events.sweepEvents();
        expect(state().run).toBeNull();
        expect(state().arenaLeftovers).toHaveLength(1);
        await events.sweepEvents();
        expect(state().arenaLeftovers).toEqual([]);
        expect(world.sent).toContain(
            "execute in minecraft:the_nether run tp Ben 13.500 70.000 -4.250 45.0 0.0"
        );
        expect(world.sent).toContain(
            "execute in minecraft:overworld run fill 292 100 -11 308 107 11 minecraft:air replace minecraft:barrier"
        );
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        onlyOurBlocks();
    });
});

describe("a build battle", () => {
    it("gives each builder a plot and a glass kit, tours the plots, and counts one vote each", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        const battle = {
            ...newPreset("build-battle", "build"),
            minutes: 3,
            options: {
                ...catalog.optionsSchemas["build-battle"].parse({}),
                voteSeconds: 30,
                themeMode: "mine" as const,
                themes: ["A lighthouse"]
            }
        };
        setUp([battle]);
        await joinAndStart("build", ["Ana", "Ben", "Cy"]);
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        expect(run.theme).toBe("A lighthouse");
        expect(fills().every((line) => line.endsWith(" keep"))).toBe(true);
        expect(
            fills().filter((line) => line.includes("minecraft:white_stained_glass keep"))
        ).toHaveLength(3);
        // Their own blocks cannot go down in adventure mode; the kit's blocks only on the plot.
        expect(world.sent).toContain("gamemode adventure Ben");
        const kit = world.sent.filter((line) => line.startsWith("give Ana "));
        const palette = build.PALETTES[build.paletteFor(run.id)];
        expect(kit).toHaveLength(palette.blocks.length + 1);
        expect(kit.every((line) => line.includes("minecraft:custom_data={polaris_event:1b}"))).toBe(
            true
        );
        // The brush first, into the hotbar; then the glass.
        expect(kit[0]).toContain("minecraft:stick[");
        expect(kit[1]).toContain('minecraft:can_place_on={blocks:["minecraft:white_stained_glass"');
        expect(kit[1]).toContain(palette.blocks[0]);
        // The theme, and the material the round is built in.
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("title Ana subtitle") &&
                    line.includes("A lighthouse") &&
                    line.includes(palette.name.en)
            )
        ).toBe(true);

        // Nobody can be hurt on a plot, or on the tour with the others.
        expect(world.sent).toContain("effect give Ben minecraft:resistance 3 4 true");
        // The glass is seen by day, and nothing hostile reaches the platform.
        expect(world.sent).toContain("gamerule doDaylightCycle false");
        expect(world.sent).toContain("gamerule doInsomnia false");
        const platform = run.arena!.box;
        expect(world.sent).toContain(
            `execute in minecraft:overworld run kill @e[type=minecraft:phantom,x=${platform.x1},y=${platform.y1},z=${platform.z1},dx=${platform.x2 - platform.x1},dy=${platform.y2 - platform.y1 + 16},dz=${platform.z2 - platform.z1},nbt=!{PersistenceRequired:1b}]`
        );

        // Building over: the kit comes back, none of it is left lying about,
        // and the vote opens.
        await play(3 * 60_000);
        expect(state().run?.voting).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.includes("run kill @e[type=minecraft:item,") &&
                    line.includes("polaris_event:1b")
            )
        ).toBe(true);
        expect(world.sent).toContain(
            "clear Ana minecraft:stick[minecraft:custom_data={polaris_event:1b}]"
        );
        await play(2_100);
        // The tour stands on the barrier roof over the wall beside a plot, looking
        // down into it - never on a plot, which may be built solid to its roof.
        const roof = state().run!.arena!.box.y2;
        const tours = world.sent
            .map((line) =>
                /^execute in minecraft:overworld run tp (Ana|Ben) (\S+) (\S+) (\S+) (-?\d+) 55$/.exec(
                    line
                )
            )
            .filter((match): match is RegExpExecArray => match !== null);
        expect(tours.length).toBeGreaterThan(0);
        for (const match of tours) expect(Number(match[3])).toBe(roof + 1);
        chat(["Ana", "1"], ["Ana", "2"], ["Ana", "2"], ["Ben", "1"], ["Cy", "#2"]);
        await play(2_100);
        expect(state().run?.votes).toEqual({ ana: "Ben", ben: "Ana", cy: "Ben" });
        expect(
            world.sent.some(
                (line) => line.startsWith("tellraw Ana") && line.includes("your own plot")
            )
        ).toBe(true);
        expect(
            world.sent.some(
                (line) => line.startsWith("tellraw Ana") && line.includes("already voted")
            )
        ).toBe(true);

        await play(40_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.podium).toEqual([
            { place: 1, name: "Ben", score: 2 },
            { place: 2, name: "Ana", score: 1 }
        ]);
        const box = run.arena!.box;
        for (const block of run.arena!.blocks) {
            expect(world.sent).toContain(
                `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace ${block}`
            );
        }
        // What the builders put up comes down with the platform.
        expect(run.arena!.blocks).toEqual(
            expect.arrayContaining(["minecraft:glass", "minecraft:red_stained_glass"])
        );
        expect(world.sent).toContain(
            `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace minecraft:red_stained_glass`
        );
        expect(world.sent).toContain("gamemode survival Ana");
        // Nobody falls at the end: fall-proof before anything moves them, their
        // own game mode only once they are home, and the platform down last.
        const sent = world.sent;
        const proof = sent.indexOf("effect give Ana minecraft:slow_falling 10 0 true");
        const home = sent.findIndex(
            (line, index) =>
                index > proof && /^execute in minecraft:overworld run tp Ana /.test(line)
        );
        expect(proof).toBeGreaterThan(0);
        expect(sent[proof + 1]).toBe("effect give Ana minecraft:resistance 10 4 true");
        expect(home).toBeGreaterThan(proof);
        expect(sent.lastIndexOf("gamemode survival Ana")).toBeGreaterThan(home);
        const teardown = sent.findIndex((line) =>
            line.includes(" minecraft:air replace minecraft:red_stained_glass")
        );
        const everyone = sent.findIndex(
            (line) =>
                line.startsWith("execute in minecraft:overworld run effect give @e[") &&
                line.endsWith("minecraft:slow_falling 10 0 true")
        );
        expect(everyone).toBeGreaterThan(home);
        expect(teardown).toBeGreaterThan(everyone);
        expect(after.arenaLeftovers).toEqual([]);
        onlyOurBlocks();
    });
});

describe("a build battle's [Done] button", () => {
    const battle = (minutes = 3) => ({
        ...newPreset("build-battle", "build"),
        minutes,
        options: { ...catalog.optionsSchemas["build-battle"].parse({}), voteSeconds: 30 }
    });
    const offers = (name: string) =>
        world.sent.filter(
            (line) => line.startsWith(`tellraw ${name} `) && line.includes("/trigger pe_join set 3")
        );
    const panel = () =>
        world.sent.filter((line) =>
            line.startsWith("scoreboard objectives modify pe_joined displayname ")
        );

    it("is offered a minute in, and ends the building at once when every builder pressed it", async () => {
        world.online = ["Ana", "Ben", "Cy", "Dee"];
        world.links = { Ben: "user-es" };
        world.locales = { "user-es": "es-ES" };
        setUp([battle()]);
        await joinAndStart("build", ["Ana", "Ben", "Cy"]);
        const readyAt = state().run!.readyAt!;
        // Not before a minute in: a third of three minutes is longer.
        await play(readyAt + 50_000 - Date.now());
        expect(offers("Ana")).toEqual([]);
        await play(12_000);
        expect(offers("Ana")).toHaveLength(1);
        expect(offers("Ana")[0]).toContain("[Done]");
        // In each builder's own language, and only to builders.
        expect(offers("Ben")[0]).toContain("[Terminado]");
        expect(offers("Dee")).toEqual([]);
        // Clicked in either spelling of the click the game has had.
        expect(offers("Ana")[0]).toContain(
            '"click_event":{"action":"run_command","command":"/trigger pe_join set 3"}'
        );
        expect(offers("Ana")[0]).toContain(
            '"clickEvent":{"action":"run_command","value":"/trigger pe_join set 3"}'
        );

        // Ana presses it, then takes it back; Ben types it.
        world.pressed = { Ana: 3 };
        await play(2_100);
        expect(state().run?.done).toEqual(["Ana"]);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw Ana ") &&
                    line.includes("/trigger pe_join set 4") &&
                    line.includes("[Undo]")
            )
        ).toBe(true);
        expect(panel().at(-1)).toContain("Done: 1/3");
        world.pressed = { Ana: 4 };
        await play(2_100);
        expect(state().run?.done).toEqual([]);
        expect(offers("Ana")).toHaveLength(2);
        chat(["Ben", "terminado"]);
        await play(2_100);
        expect(state().run?.done).toEqual(["Ben"]);
        expect(state().run?.voting).toBe(false);
        expect(
            world.sent.some(
                (line) => line.startsWith("tellraw Ben ") && line.includes("[Seguir construyendo]")
            )
        ).toBe(true);

        // The last ones done: the vote starts now, with its own time ahead.
        world.pressed = { Ana: 3, Cy: 3 };
        await play(2_100);
        const run = state().run!;
        expect(run.voting).toBe(true);
        expect(run.buildEndsAt).not.toBeNull();
        expect(run.endsAt - run.buildEndsAt!).toBe(30_000);
        expect(run.buildEndsAt! - readyAt).toBeLessThan(3 * 60_000);
        // The panel goes back to the votes, and the triggers are cleared at the end.
        expect(world.sent).toContain("scoreboard objectives remove pe_joined");
        expect(world.sent).toContain("scoreboard objectives setdisplay sidebar pe_score");
        await play(40_000);
        expect(state().run).toBeNull();
        expect(world.sent).toContain("scoreboard objectives remove pe_join");
    });

    it("is not held up by a builder who left", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        setUp([battle()]);
        await joinAndStart("build", ["Ana", "Ben", "Cy"]);
        await play(state().run!.readyAt! + 62_000 - Date.now());
        world.online = ["Ana"];
        world.pressed = { Ana: 3 };
        await play(2_100);
        expect(state().run?.voting).toBe(true);
    });

    it("runs its whole time when somebody never presses it", async () => {
        world.online = ["Ana", "Ben", "Cy"];
        setUp([battle()]);
        await joinAndStart("build", ["Ana", "Ben", "Cy"]);
        const readyAt = state().run!.readyAt!;
        await play(readyAt + 62_000 - Date.now());
        world.pressed = { Ana: 3 };
        await play(60_000);
        expect(state().run?.voting).toBe(false);
        expect(state().run?.buildEndsAt).toBeNull();
        await play(readyAt + 3 * 60_000 + 2_100 - Date.now());
        expect(state().run?.voting).toBe(true);
    });
});

describe("each player reads their own language", () => {
    const quiz = () => ({
        ...newPreset("trivia", "quiz"),
        options: { rounds: 3, seconds: 15, mode: "questions" as const, questions: [] }
    });
    const sentTo = (selector: string, words: string) =>
        world.sent.some(
            (line) => line.startsWith(`tellraw ${selector} `) && visible(line).includes(words)
        );

    it("asks a Spanish account's player in Spanish and everybody else in English, and takes either answer", async () => {
        world.links = { Ana: "user-es" };
        world.locales = { "user-es": "es-ES" };
        setUp([quiz()]);
        await startArena("quiz");
        await play(4_100);
        // Each player carries the tag of the language they read.
        expect(world.sent).toContain("tag Ana add pl_es");
        expect(world.sent).toContain("tag Ben add pl_en");
        // The same question of the bank, in each reader's language.
        const first = triviaBank.ordered(state().run!.id, state().run!.triviaSkip)[0]!;
        const spanish = first.es;
        const english = first.en;
        expect(sentTo("@a[tag=pl_es]", "Pregunta 1/3")).toBe(true);
        // As the game's JSON writes it: every accent an escape.
        const escaped = (words: string) =>
            words.replace(
                /[\u0080-\uffff]/g,
                (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
            );
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw @a[tag=pl_es] ") &&
                    line.includes(escaped(spanish.question))
            )
        ).toBe(true);
        expect(sentTo("@a[tag=pl_es]", spanish.question)).toBe(true);
        expect(sentTo("@a[tag=!pl_es]", "Question 1/3")).toBe(true);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw @a[tag=!pl_es] ") &&
                    line.includes(english.question.slice(0, 20))
            )
        ).toBe(true);
        // Nothing reaches everybody in one language any more.
        expect(
            world.sent.some((line) => line.startsWith("tellraw @a ") && line.includes("Question"))
        ).toBe(false);
        expect(
            world.sent.some(
                (line) => /^title @a\[tag=pl_es\] title /.test(line) && line.includes("Pregunta")
            )
        ).toBe(true);
        // Ana answers her own question, in Spanish.
        chat(["Ana", spanish.answers[0]!]);
        await play(2_100);
        expect(state().run?.points ?? state().history[0]?.podium).toBeTruthy();
        const won = world.sent.find(
            (line) =>
                line.startsWith("tellraw @a[tag=pl_es] ") && visible(line).includes("Ana acert")
        );
        expect(won).toBeDefined();
        expect(sentTo("@a[tag=!pl_es]", "Ana got it")).toBe(true);
    });

    it("talks to one player in that player's language", async () => {
        world.links = { Ana: "user-es" };
        world.locales = { "user-es": "es-ES" };
        const floor = {
            ...newPreset("spleef", "floor"),
            minutes: 5,
            options: { place: { mode: "players" as const }, size: 6, height: 30 }
        };
        setUp([floor]);
        await startArena("floor");
        await play(2_100);
        chat(["Ana", "unirse"], ["Ben", "join"]);
        await play(2_100);
        expect(sentTo("Ana", "s dentro. Te llevamos")).toBe(true);
        expect(sentTo("Ben", "You are in")).toBe(true);
        // The join buttons: each language its own labels.
        expect(sentTo("@a[tag=pl_es]", "[Unirse]")).toBe(true);
        expect(sentTo("@a[tag=!pl_es]", "[Join]")).toBe(true);
    });

    it("writes what nobody in particular reads in the server's own language", async () => {
        world.links = { Ana: "user-es" };
        world.locales = { "user-es": "es-ES" };
        setUp([quiz()]);
        await startArena("quiz");
        await play(4_100);
        const bar = world.sent.filter((line) => line.startsWith("bossbar set polaris:event name "));
        expect(bar.length).toBeGreaterThan(0);
        expect(bar.every((line) => line.includes("Trivia") && !line.includes('polaris":'))).toBe(
            true
        );
        // Nothing still carries a message in every language on its way out.
        expect(
            world.sent.some((line) => line.includes('{"polaris":"') || /\ue000/.test(line))
        ).toBe(false);
    });

    it("speaks its owner's language when the operator never chose one", async () => {
        world.locales = { owner: "es-ES" };
        setUp([quiz()]);
        const settings = (config[catalog.EVENTS_KEY] as { settings: Record<string, unknown> })
            .settings;
        delete settings.language;
        await startArena("quiz");
        await play(4_100);
        // Nobody linked: everybody reads the owner's language, sent to all at once.
        expect(sentTo("@a", "Pregunta 1/3")).toBe(true);
        expect(world.sent.some((line) => line.includes("Question 1/3"))).toBe(false);
    });
});

describe("the clock", () => {
    it("starts when the boss stands, with the whole of its time ahead, and says it is getting ready until then", async () => {
        const boss = groundBoss("boss", 10);
        setUp([boss]);
        await startArena("boss");
        await play(100);
        // Begun, the place still being looked for: no running time on the bar.
        expect(state().run?.readyAt).toBeNull();
        await play(2_000);
        const waiting = world.sent.filter((line) =>
            line.startsWith("bossbar set polaris:event name ")
        );
        expect(waiting.some((line) => line.includes("getting ready"))).toBe(true);
        await play(8_000);
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        expect(run.startsAt).toBe(run.readyAt);
        expect(run.endsAt - run.readyAt!).toBe(10 * 60_000);
        // A restart does not start it again.
        const before = { ...run };
        await events.sweepEvents();
        await play(2_100);
        expect(state().run?.readyAt).toBe(before.readyAt);
        expect(state().run?.endsAt).toBe(before.endsAt);
    });

    it("announces a run at once, without waiting for a tick", async () => {
        const hunt = { ...newPreset("mob-hunt", "hunt"), minutes: 3 };
        setUp([hunt], { countdownSeconds: 30 });
        await startArena("hunt");
        await play(50);
        expect(
            world.sent.some((line) => line.startsWith("tellraw @a") && line.includes("starts in"))
        ).toBe(true);
    });
});

describe("the list of who joined", () => {
    it("writes its count again as players join, not only the names under it", async () => {
        const race = {
            ...newPreset("parkour", "race"),
            minutes: 5,
            options: {
                place: { mode: "players" as const },
                jumps: 12,
                difficulty: "medium" as const,
                height: 30
            }
        };
        setUp([race]);
        await startArena("race");
        await play(2_100);
        chat(["Ana", "join"], ["Ben", "join"]);
        await play(2_100);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("scoreboard objectives modify pe_joined displayname ") &&
                    line.includes("(2 joined)")
            )
        ).toBe(true);
    });
});
