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

// ------------------------------------------------------------------ the world

interface World {
    online: string[];
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
    /** Where whoever has a kill of the boss's kind is standing. */
    killerAt: [number, number, number];
    /** Item ids the server does not know. */
    unknownItems: string[];
    /** Which world each player is in; the Overworld when not said. */
    dims: Record<string, string>;
    /** The game's running damage counts, per player. */
    hurt: Record<string, number>;
    /** Players standing perfectly still, looking the same way. */
    still: string[];
    /** Players in creative or spectator. */
    creative: string[];
    difficulty: string;
    daylightCycle: "true" | "false";
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
    /** Chests standing in the world, as `x y z`, and the ones opened. */
    chests: string[];
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
    /** Horde defence: who is at the point, and how many monsters are left. */
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
    /** Game modes by name: 0 survival, 1 creative, 2 adventure. */
    modes: Record<string, number>;
    /** Something already stands in the air over every site. */
    skyTaken: boolean;
    /** The server's settings file, or null when it cannot be read. */
    properties: string | null;
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
    /** How long the storm lasts, in ticks, as the last `weather thunder` left it. */
    stormTicks: number;
}

const world: World = {
    online: [],
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
    killerAt: [305, 70, 2],
    unknownItems: [],
    dims: {},
    hurt: {},
    still: [],
    creative: [],
    difficulty: "Normal",
    daylightCycle: "true",
    renamedRules: false,
    built: false,
    refusedGround: [],
    unsureGround: 0,
    homes: {},
    homeWorlds: {},
    markFollows: false,
    markAt: [300, 0],
    chests: [],
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
    modes: {},
    skyTaken: false,
    properties: "pvp=true\ndifficulty=normal\n",
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
    bukkit: false,
    essentials: false,
    pluginGot: [],
    glued: false,
    display: {},
    scoreTitle: "Event title",
    tags: {},
    stormTicks: 0
};
let config: Record<string, unknown> = {};
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
const ESSENTIALS = /(^|^execute .*? run )(kill|give|tp|teleport|gamemode|clear|xp|experience|time|weather|item) /;

function answer(sent: string): string {
    world.sent.push(sent);
    let line = sent;
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
    const cleared = /^clear (\S+) (\S+)(?: (\d+))?$/.exec(line);
    if (cleared) {
        if (!itemReadable(cleared[2]!))
            return refuse(line, "Expected whitespace to end one argument, but found trailing data");
        if (cleared[1]!.startsWith("@a[tag=pe_probe]")) return "No player was found";
        return world.online.includes(cleared[1]!)
            ? `Removed 1 item(s) from player ${cleared[1]}`
            : "No player was found";
    }
    const filled = fillAnswer(line);
    if (filled !== null) return filled;
    const moved = /^execute in (\S+) run tp (\w+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(line);
    if (moved) {
        const name = moved[2] as string;
        if (!world.online.includes(name)) return "No entity was found";
        world.at[name] = [Number(moved[3]), Number(moved[4]), Number(moved[5])];
        return `Teleported ${name} to ${moved[3]}, ${moved[4]}, ${moved[5]}`;
    }
    const tagged = /^tag (\w+) (add|remove) pe_in$/.exec(line);
    if (tagged) {
        if (tagged[2] === "add") world.inside.add(tagged[1] as string);
        else world.inside.delete(tagged[1] as string);
        return "";
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
            .map((name) => `${name} has the following entity data: ${dimension("minecraft:overworld")}`)
            .join("\n");
    }
    const air = /^execute in minecraft:overworld if block (-?\d+ -?\d+ -?\d+) minecraft:air$/.exec(
        line
    );
    if (air) {
        // Not air: a block of the world's or a meteor's, or a chest standing there.
        const at = air[1] as string;
        const taken = world.blocks.has(at) || world.solid || world.chests.includes(at);
        return taken ? "Test failed" : "Test passed";
    }
    const put = /^execute in minecraft:overworld run setblock (-?\d+ -?\d+ -?\d+) (\S+) keep$/.exec(
        line
    );
    if (put) {
        if (world.blocks.has(put[1] as string)) return "Could not set the block";
        world.blocks.set(put[1] as string, put[2] as string);
        return `Changed the block at ${put[1]}`;
    }
    const take =
        /^execute in minecraft:overworld if block (-?\d+ -?\d+ -?\d+) (\S+) run setblock \S+ \S+ \S+ minecraft:air$/.exec(
            line
        );
    if (take) {
        if (world.blocks.get(take[1] as string) !== take[2]) return "Test failed";
        world.blocks.delete(take[1] as string);
        return "Changed the block";
    }
    const ours = /^execute in minecraft:overworld if block (-?\d+ -?\d+ -?\d+) (\S+)$/.exec(line);
    // A block the world knows of, or a meteor's ore; any other test is answered
    // further down.
    if (ours && (world.blocks.has(ours[1] as string) || /(_ore|ancient_debris)$/.test(ours[2]!)))
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
    if (line === "gamerule keepInventory") {
        return world.keepInventory === "unknown"
            ? "Unknown or incomplete command, see below for error"
            : `Gamerule keepInventory is currently set to: ${world.keepInventory}`;
    }
    if (line === "execute in minecraft:overworld run forceload query") return world.forced;
    if (line === "execute if entity @e[tag=pe_mob]")
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
    if (line.startsWith("execute in minecraft:overworld unless block")) {
        const refused = world.refusedGround.find(
            (id) => line.includes(`minecraft:${id} `) || line.endsWith(`minecraft:${id}`)
        );
        if (refused) return `Unknown block type 'minecraft:${refused}'`;
        if (world.unsureGround > 0) {
            world.unsureGround -= 1;
            return "That position is not loaded";
        }
        // As Offgrid answers: a chain that holds says "Test passed"; one where any
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
    const storm = /^weather thunder (\d+)(s?)$/.exec(line);
    if (storm) {
        const seconds = storm[2] === "s";
        if (!events.atLeast(world.version, [1, 19, 4])) {
            if (seconds)
                return `Expected whitespace to end one argument, but found trailing data\n...r thunder ${storm[1]}<--[HERE]`;
            world.stormTicks = Number(storm[1]) * 20;
        } else world.stormTicks = Number(storm[1]) * (seconds ? 20 : 1);
        return "Changing to rain and thunder";
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
                    `${name} has ${counted[1] === "pe_hurt" ? (world.hurt[name] ?? 0) : 0} [${counted[1]}]`
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
    if (line.startsWith("data get entity @e[tag=pe_mark"))
        return `Armor Stand has the following entity data: [${world.markAt[0]}.5d, 70.0d, ${world.markAt[1]}.5d]`;
    if (line.includes("if data block") && line.includes("LootTable")) {
        world.chestChecks += 1;
        return world.chestChecks > world.chestOpenedAfter ? "Test failed" : "Test passed";
    }
    if (line.includes("sort=nearest"))
        return `${world.online[0]} has the following entity data: [301.0d, 70.0d, 1.0d]`;
    if (line.startsWith("give ")) {
        const [, name, item, count = "1"] = line.split(" ") as [string, string, string, string?];
        if (!itemReadable(item))
            return refuse(line, "Expected whitespace to end one argument, but found trailing data");
        if (world.unknownItems.includes(item)) return `Unknown item '${item}'`;
        if (!world.online.includes(name)) return "No player was found";
        // 1.17 on: at most a hundred stacks in one give; a sword stacks to one.
        if (item.endsWith("_sword") && Number(count) > 100)
            return "Can't give more than 100 of [Diamond Sword]";
        return `Gave ${count} [Item] to ${name}`;
    }
    const levels = /^xp add (\S+) (\d+) levels$/.exec(line);
    if (levels) {
        return world.online.includes(levels[1]!)
            ? `Gave ${levels[2]} experience levels to ${levels[1]}`
            : "No player was found";
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
            .map((name, index) => `${name} (00000000-0000-0000-0000-${String(index).padStart(12, "0")})`)
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
        out = out.replace(new RegExp(`(^|\\n)${name} has `, "g"), `$1${before}${name}${after} has `);
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
        return { code: 0, output: looks ? `Starting minecraft server version ${world.version}` : "" };
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
                name: "Offgrid",
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
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string | null) =>
                raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
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
    containerFileSize: async () => world.log.length
}));

const SERVER = "00000000-0000-4000-8000-000000000001";
const catalog = await import("@polaris-app/game-servers/src/lib/minecraft/events/catalog");
const events = await import("@polaris-app/game-servers/src/lib/minecraft/events/events-service");
const { readEventState } = await import("@polaris-app/game-servers/src/lib/minecraft/events/state");

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
    world.killerAt = [305, 70, 2];
    world.unknownItems = [];
    world.dims = {};
    world.hurt = {};
    world.still = [];
    world.creative = [];
    world.difficulty = "Normal";
    world.daylightCycle = "true";
    world.renamedRules = false;
    world.built = false;
    world.refusedGround = [];
    world.unsureGround = 0;
    world.homes = {};
    world.homeWorlds = {};
    world.markFollows = false;
    world.markAt = [300, 0];
    world.chests = [];
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
    world.modes = {};
    world.skyTaken = false;
    world.properties = "pvp=true\ndifficulty=normal\n";
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
    world.bukkit = false;
    world.essentials = false;
    world.pluginGot = [];
    world.glued = false;
    world.display = {};
    world.scoreTitle = "Event title";
    world.tags = {};
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
        setUp([{ ...catalog.newPreset("mining-rush", "rush"), minutes: 3 }], {
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
        setUp([{ ...catalog.newPreset("mining-rush", "rush"), minutes: 3 }], {
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
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 3 };
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
        // Ben is owed second place and taking part, kept for when he is back.
        expect(after.pending.map((one) => one.player)).toEqual(["Ben"]);
        expect(after.pending[0]?.reward.items.map((item) => item.id)).toEqual([
            "minecraft:diamond",
            "minecraft:experience_bottle"
        ]);
        // Everything the event made is taken down, and the side panel given back.
        expect(world.sent).toContain("scoreboard objectives remove pe_score");
        expect(world.sent).toContain("bossbar remove polaris:event");
        expect(released).toContain(SERVER);
    });

    it("leaves somebody the anti-cheat caught off the podium and the prizes", async () => {
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 3 };
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
        setUp([{ ...catalog.newPreset("supply-drop", "drop"), minutes: 10 }]);
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
        setUp([{ ...catalog.newPreset("supply-drop", "drop"), minutes: 10 }]);
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
        const drop = { ...catalog.newPreset("supply-drop", "drop"), minutes: 10 };
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
        expect(removals.every((line) => line.includes("if data block 300 70 0 LootTable"))).toBe(
            true
        );
    });

    it("lets go of the chunk it was trying when it is called off before landing", async () => {
        const drop = { ...catalog.newPreset("supply-drop", "drop"), minutes: 10 };
        setUp([drop]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        const added = world.sent.filter((line) => line.includes("run forceload add"));
        expect(added.length).toBeGreaterThan(0);
        expect(state().run?.target).not.toBeNull();
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
        const hunt = { ...catalog.newPreset("mob-hunt", "hunt"), minutes: 10 };
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
        setUp([{ ...catalog.newPreset("mob-hunt", "hunt"), minutes: 10 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        await expect(events.startNow("owner", SERVER)).rejects.toThrow("It has already started");
    });
});

describe("calling one off", () => {
    it("ends it with nobody winning and cleans up", async () => {
        const hunt = { ...catalog.newPreset("mob-hunt", "hunt"), minutes: 10 };
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
        setUp([{ ...catalog.newPreset("fishing", "fish"), minutes: 10 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "fish",
            trigger: "manual",
            startedBy: null
        });
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "fish",
                trigger: "manual",
                startedBy: null
            })
        ).rejects.toThrow(/another event is on/i);
    });

    it("refuses one with nobody on the server", async () => {
        world.online = [];
        setUp([{ ...catalog.newPreset("fishing", "fish"), minutes: 10 }]);
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "fish",
                trigger: "manual",
                startedBy: null
            })
        ).rejects.toThrow(/nobody is on/i);
    });
});

describe("the minute sweep", () => {
    it("draws an event once enough people are playing, not before", async () => {
        const fish = { ...catalog.newPreset("fishing", "fish"), minutes: 5 };
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

    it("skips a scheduled event when too few are playing, and says so", async () => {
        const fish = { ...catalog.newPreset("fishing", "fish"), minutes: 5 };
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
        setUp([catalog.newPreset("fishing", "fish")], {
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
        setUp([catalog.newPreset("fishing", "fish")], {
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
            expect(world.sent.filter((line) => line === `give ${name} minecraft:emerald 2`)).toHaveLength(1);
            expect(world.sent.filter((line) => line === `xp add ${name} 3 levels`)).toHaveLength(1);
        }
        expect(state().pending).toEqual([]);
    });

    it("keeps a prize the game refused as too many, rather than calling it given", async () => {
        setUp([catalog.newPreset("fishing", "fish")], {
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
        setUp([catalog.newPreset("fishing", "fish")], {
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
    it("reads the chat for the first right answer and scores the rounds", async () => {
        const quiz = {
            ...catalog.newPreset("trivia", "quiz"),
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
});

describe("a world boss", () => {
    it("appears with its health and name, counts damage near it, and falls", async () => {
        const boss = { ...catalog.newPreset("world-boss", "boss"), minutes: 10 };
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
        expect(world.sent).toContain(
            "attribute @e[tag=pe_boss,limit=1] minecraft:max_health base set 400"
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

    it("is not taken as felled when it is out of reach and somebody far off kills its kind", async () => {
        const boss = { ...catalog.newPreset("world-boss", "boss"), minutes: 10 };
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
        const boss = { ...catalog.newPreset("world-boss", "boss"), minutes: 3 };
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

describe("a blood moon", () => {
    it("brings night and waves, and only the survivors stand on the podium", async () => {
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
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
        expect(world.sent).toContain("kill @e[tag=pe_mob]");
    });
});

describe("the others", () => {
    it("a race is won by whoever reaches the finish first", async () => {
        const race = {
            ...catalog.newPreset("explorer", "race"),
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
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
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
            world.sent.some((line) =>
                line.includes(
                    "positioned 300.5 70 0.5 as @a[distance=..6,gamemode=!spectator] run scoreboard players add @s pe_score 2"
                )
            )
        ).toBe(true);
        world.scores = { Ana: 95 };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 95 }]);
    });

    it("draws the circle's edge and a column of light, and tells each player the way", async () => {
        world.online = ["Ana"];
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
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
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(60_000);
        expect(
            world.sent.some((line) => line.includes("run scoreboard players add @s pe_score"))
        ).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
    });

    it("judges the ground by older names on a server that refuses the newest", async () => {
        world.built = true;
        world.refusedGround = ["leaf_litter"];
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(60_000);
        expect(
            world.sent.some((line) => line.includes("run scoreboard players add @s pe_score"))
        ).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
    });

    it("keeps judging the ground after a column that could not be read", async () => {
        world.built = true;
        world.unsureGround = 2;
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(60_000);
        expect(
            world.sent.some((line) => line.includes("run scoreboard players add @s pe_score"))
        ).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
    });

    it("takes the fixed point an operator chose as it is", async () => {
        world.built = true;
        const hill = {
            ...catalog.newPreset("king-of-the-hill", "hill"),
            minutes: 3,
            options: { place: { mode: "fixed" as const, x: 300, z: 0 }, radius: 6 }
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
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
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
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
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
        const happy = { ...catalog.newPreset("happy-hour", "happy"), minutes: 20 };
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
        const happy = { ...catalog.newPreset("happy-hour", "happy"), minutes: 60 };
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
        const drop = { ...catalog.newPreset("supply-drop", "drop"), minutes: 10 };
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
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 10 };
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
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 10 };
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
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 3 };
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
});

describe("the least to be ranked", () => {
    it("keeps a token score off the podium and out of the prizes", async () => {
        const hunt = { ...catalog.newPreset("mob-hunt", "hunt"), minutes: 3 };
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
        const hunt = { ...catalog.newPreset("mob-hunt", "hunt"), minutes: 3 };
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
        setUp([{ ...catalog.newPreset("fishing", "fish"), minutes: 5 }], draw("fish"));
        await events.sweepEvents();
        await play(15 * 60_000);
        world.hurt = { Ana: 40 };
        await events.sweepEvents();
        world.hurt = { Ana: 55 };
        const held = await events.sweepEvents();
        expect(held.started).toBe(0);
        expect(state().waiting).toBe("Waiting: Ana is in a fight or in the End");
        // A minute and a half after the last blow, it goes ahead.
        await play(100_000);
        const started = await events.sweepEvents();
        expect(started.started).toBe(1);
    });

    it("counts only the Overworld for an event that happens there", async () => {
        world.dims = { Ana: "minecraft:the_nether", Ben: "minecraft:the_nether" };
        setUp([{ ...catalog.newPreset("supply-drop", "drop"), minutes: 5 }], draw("drop"));
        await events.sweepEvents();
        await play(15 * 60_000);
        await events.sweepEvents();
        expect(state().run).toBeNull();
        expect(state().waiting).toBe("Waiting for 2 active players in the Overworld (0 now)");
    });

    it("does not hold a mining rush back for players in the Nether", async () => {
        world.dims = { Ana: "minecraft:the_nether", Ben: "minecraft:the_nether" };
        setUp([{ ...catalog.newPreset("mining-rush", "rush"), minutes: 5 }], draw("rush"));
        await events.sweepEvents();
        await play(15 * 60_000);
        const started = await events.sweepEvents();
        expect(started.started).toBe(1);
    });

    it("does not count a night sat out in the Nether as surviving it", async () => {
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3, minScore: 1 };
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
        setUp([{ ...catalog.newPreset("blood-moon", "moon"), minutes: 5 }]);
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "moon",
                trigger: "manual",
                startedBy: null
            })
        ).rejects.toThrow(/Peaceful.*Easy or harder under Rules/);
    });

    it("runs one that needs no hostile mobs on Peaceful", async () => {
        world.difficulty = "Peaceful";
        setUp([{ ...catalog.newPreset("fishing", "fish"), minutes: 5 }]);
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
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 3 };
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
        world.online = Array.from({ length: 100 }, (_, index) => `Pescador${String(index).padStart(2, "0")}`);
        world.glued = true;
        world.scoreTitle = "Gran concurso de pesca en el r\u00edo del norte";
        const fish = { ...catalog.newPreset("fishing", "fish"), minutes: 3 };
        setUp([fish]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "fish",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = Object.fromEntries(world.online.map((name, index) => [name, index === 95 ? 90 : 1]));
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
        const fish = { ...catalog.newPreset("fishing", "fish"), minutes: 3 };
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
        const fish = { ...catalog.newPreset("fishing", "fish"), minutes: 3 };
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
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
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
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
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
            const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
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
        }
    );

    it.each(["1.21.4", "26.1"])(
        "gives a server on %s whose clock stands still its own time back after a blood moon",
        async (version) => {
            world.version = version;
            world.renamedRules = events.atLeast(version, [1, 21, 11]);
            world.daylightCycle = "false";
            const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
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
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
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
            )
    );
}

describe("a treasure hunt", () => {
    const start = async (
        options: Partial<catalog.EventOptions<"treasure-hunt">> = {},
        minutes = 9
    ) => {
        const made = catalog.newPreset("treasure-hunt", "hunt");
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

    it("hides its chests only into air, tells the clues, points the way and scores whoever opens one", async () => {
        world.markFollows = true;
        await start();
        await play(30_000);
        const run = state().run!;
        expect(run.hidden).toBe(true);
        expect(run.chests).toHaveLength(3);
        expect(world.chests).toEqual(run.chests.map(at));
        // Each one on ground judged open, and kept loaded.
        for (const chest of run.chests)
            expect(world.sent).toContain(
                `execute in minecraft:overworld run forceload add ${chest.x} ${chest.z}`
            );
        expect(touchesBlocks(world.sent)).toEqual([]);
        // The first clue for each, and the way or the count in every action bar.
        for (const number of [1, 2, 3])
            expect(
                world.sent.some(
                    (line) => line.startsWith("tellraw @a") && line.includes(`Treasure ${number}: `)
                )
            ).toBe(true);
        expect(world.sent.some((line) => line.startsWith("title Ana actionbar"))).toBe(true);

        world.opened.push(at(run.chests[0]!));
        await play(2_100);
        expect(state().run?.points).toEqual({ Ana: 1 });
        expect(state().run?.chests[0]).toMatchObject({ opened: true, by: "Ana" });
        expect(world.sent).toContain("scoreboard players set Ana pe_score 1");

        // Three minutes in, the area; six, the exact spot; the last two, the beams.
        await play(3 * 60_000);
        expect(world.sent.some((line) => line.includes("within 50 blocks"))).toBe(true);
        await play(4 * 60_000);
        const chest = state().run!.chests[1]!;
        expect(
            world.sent.some((line) => line.includes(`X ${chest.x} Y ${chest.y} Z ${chest.z}`))
        ).toBe(true);
        expect(world.sent.some((line) => line.includes("particle minecraft:end_rod"))).toBe(true);

        await play(3 * 60_000);
        const after = readEventState(config);
        expect(after.run).toBeNull();
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 1 }]);
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        // The opened chest is Ana's and stays; the two nobody found are gone.
        expect(world.chests).toEqual([at(run.chests[0]!)]);
        for (const one of run.chests)
            expect(world.sent).toContain(
                `execute in minecraft:overworld run forceload remove ${one.x} ${one.z}`
            );
        expect(world.sent.some((line) => line.includes("never found"))).toBe(true);
    });

    it("ends as soon as every chest is open", async () => {
        world.markFollows = true;
        await start({ chests: 2 });
        await play(20_000);
        world.opened.push(...state().run!.chests.map(at));
        await play(2_100);
        const entry = state().history[0];
        expect(entry?.note).toBe("All 2 treasures found");
        expect(entry?.podium).toEqual([{ place: 1, name: "Ana", score: 2 }]);
        expect(world.chests).toHaveLength(2);
    });

    it("called off, takes away exactly the chests it put down and nothing else", async () => {
        world.markFollows = true;
        world.chests = ["1 64 1"];
        await start();
        await play(30_000);
        const placed = state().run!.chests.map(at);
        expect(placed).toHaveLength(3);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().history[0]).toMatchObject({ outcome: "cancelled", podium: [] });
        // Somebody's own chest, which the event never put down, is still there.
        expect(world.chests).toEqual(["1 64 1"]);
        expect(touchesBlocks(world.sent)).toEqual([]);
        expect(world.sent.some((line) => line.includes("setblock 1 64 1"))).toBe(false);
    });

    it("never takes a chest already standing where it lands for one of its own", async () => {
        world.markFollows = true;
        world.markAt = [0, 0];
        const made = catalog.newPreset("treasure-hunt", "hunt");
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
        const made = catalog.newPreset("treasure-hunt", "hunt");
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
        const made = { ...catalog.newPreset("treasure-hunt", "hunt"), minutes: 10 };
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
        const made = { ...catalog.newPreset("treasure-hunt", "hunt"), minutes: 10 };
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
        const made = catalog.newPreset("gathering", "gather");
        setUp([{ ...made, minutes: 3, options: { material: "wheat" as const } }]);
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
                    line.includes("Gather: ") &&
                    line.includes("Wheat")
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

    it("draws its material when the event is set off, and says it in the countdown", async () => {
        const made = catalog.newPreset("gathering", "gather");
        setUp([made], { countdownSeconds: 30 });
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "gather",
            trigger: "manual",
            startedBy: null
        });
        const material = state().run?.material;
        expect(catalog.GATHER_MATERIALS).toContain(material);
        await play(2_100);
        expect(state().run?.phase).toBe("countdown");
        expect(
            world.sent.some((line) => line.startsWith("tellraw @a") && line.includes("Gather: "))
        ).toBe(true);
    });
});

describe("a rare catch", () => {
    it("is won by the first to reel the treasure in, who keeps it", async () => {
        const made = catalog.newPreset("rare-catch", "catch");
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
        expect(world.sent.filter((line) => /(^|run )clear /.test(line))).toEqual([]);
        expect(world.sent).toContain("scoreboard objectives remove pe_rod");
    });

    it("has no winner when nobody catches it", async () => {
        const made = catalog.newPreset("rare-catch", "catch");
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
        const made = { ...catalog.newPreset("xp-boost", "boost"), minutes: 5 };
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
        const made = { ...catalog.newPreset("xp-boost", "boost"), minutes: 20 };
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

describe("a horde defence", () => {
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
        setUp([catalog.newPreset("waves", "waves")]);
        await start();
        await play(10_100);
        // Nothing is lost to a death: keepInventory on, the server's own
        // value written down first.
        expect(world.sent).toContain("gamerule keepInventory true");
        expect(state().run?.gamerules).toEqual({
            keepInventory: "false",
            sendCommandFeedback: "true"
        });
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
        setUp([catalog.newPreset("waves", "waves")]);
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
        setUp([catalog.newPreset("waves", "waves")]);
        await start();
        await play(10_100 + 46_000);
        expect(summoned()).toHaveLength(4);
        const held = holds();
        await play(121_000);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("title @a title") && line.includes("Wave 1 ran out of time")
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
        setUp([catalog.newPreset("waves", "waves")]);
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
        setUp([catalog.newPreset("waves", "waves")]);
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
        setUp([catalog.newPreset("waves", "waves")]);
        await expect(start()).rejects.toThrow(/Peaceful/);
    });

    it("puts the point well away from every bed", async () => {
        world.homes = { Ana: [0, 0], Ben: [0, 0] };
        setUp([catalog.newPreset("waves", "waves")]);
        await start();
        await play(4_100);
        const loaded = world.sent
            .filter((line) => /run forceload add -?\d+ -?\d+$/.test(line))
            .map((line) => line.split(" ").slice(-2).map(Number) as [number, number]);
        expect(loaded.length).toBeGreaterThan(0);
        for (const [x, z] of loaded) expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(96);
    });

    it("cleans up after a restart that caught it handing out its results", async () => {
        const preset = catalog.newPreset("waves", "waves");
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
        const preset = catalog.newPreset("waves", "waves");
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
    const shower = (minutes = 10) => ({
        ...catalog.newPreset("meteor-shower", "meteors"),
        minutes
    });
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
        world.nearMeteor = true;
        const [mined, back] = first!.blocks;
        world.blocks.delete(`${mined!.x} ${mined!.y} ${mined!.z}`);
        world.blocks.delete(`${back!.x} ${back!.y} ${back!.z}`);
        await play(2_100);
        expect(state().run?.meteors[0]?.blocks).toHaveLength(3);
        const hers = `${back!.x} ${back!.y} ${back!.z}`;
        world.blocks.set(hers, back!.block);
        await play(2_100);
        expect(state().run?.meteors[0]?.blocks).toHaveLength(3);
        world.nearMeteor = false;

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
        await play(4_100);
        const target = state().run?.target;
        expect(target).not.toBeNull();
        expect(Math.hypot(target!.x, target!.z)).toBeGreaterThanOrEqual(48);
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
    for (const line of fills)
        expect(line.endsWith(" keep") || / minecraft:air replace minecraft:\S+$/.test(line)).toBe(
            true
        );
    const { built, removed } = builtAndRemoved();
    for (const one of built) expect(removed).toContain(one);
    for (const line of world.sent.filter((one) => one.startsWith("clear ")))
        expect(line).toContain("custom_data={polaris_event:1b}");
    expect(world.sent.some((line) => /minecraft:(lava|fire|tnt|water)\b/.test(line))).toBe(false);
}

describe("a parkour race", () => {
    const race = () => ({
        ...catalog.newPreset("parkour", "race"),
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
        world.at.Ana = top(course.checkpoints[0]!);
        world.at.Ben = [top(3)[0], course.floor - 3, top(3)[2]];
        const from = world.sent.length;
        await play(2_100);
        const said = world.sent.slice(from);
        expect(state().run?.stage?.racers.find((one) => one.name === "Ana")?.checkpoint).toBe(
            course.checkpoints[0]
        );
        expect(
            said.some(
                (line) => line.startsWith("title Ana title") && line.includes("Checkpoint 1/")
            )
        ).toBe(true);
        // Ben fell onto the net and is back at the start, unhurt.
        const start = parkour.spotOn(course, 0);
        expect(said).toContain(
            `execute in minecraft:overworld run tp Ben ${start.x.toFixed(3)} ${start.y.toFixed(3)} ${start.z.toFixed(3)} ${start.yaw.toFixed(1)} 0.0`
        );

        const savedBen = state().run!.stage!.saved.find((one) => one.name === "Ben")!;
        world.at.Ana = top(course.platforms.length - 1);
        chat(["Ben", "leave"]);
        await play(4_100);

        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("Everybody finished or dropped out");
        expect(after.history[0]?.podium.map((one) => one.name)).toEqual(["Ana"]);
        expect(world.sent).toContain(
            `execute in minecraft:overworld run tp Ben ${savedBen.x.toFixed(3)} ${savedBen.y.toFixed(3)} ${savedBen.z.toFixed(3)} ${savedBen.yaw.toFixed(1)} ${savedBen.pitch.toFixed(1)}`
        );
        expect(world.sent).toContain("gamemode survival Ana");
        expect(world.sent).toContain("gamemode survival Ben");
        expect(world.inside.size).toBe(0);
        expect(after.stageLeftovers).toEqual([]);
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
        await play(120_000);
        const after = state();
        expect(after.history[0]).toMatchObject({ outcome: "failed" });
        expect(
            world.sent.some((line) => line.endsWith(" keep") && !line.includes("structure_void"))
        ).toBe(false);
        expect(world.sent.some((line) => / tp (Ana|Ben) /.test(line))).toBe(false);
        keptTheRules();
    });
});

describe("a parkour race on a server before 1.16", () => {
    it("admits whoever joins, the world they are in read as a number", async () => {
        world.version = "1.15.2";
        world.online = ["Ana", "Ben"];
        setUp([
            {
                ...catalog.newPreset("parkour", "race"),
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
        expect(state().run?.stage?.saved.every((one) => one.dimension === "minecraft:overworld")).toBe(
            true
        );
    });
});

describe("spleef", () => {
    const floor = () => ({
        ...catalog.newPreset("spleef", "floor"),
        minutes: 5,
        options: { place: { mode: "players" as const }, size: 6, height: 30 }
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
        world.at.Ben = [arenaAt.centre.x, arenaAt.floor - 3, arenaAt.centre.z];
        await play(2_100);
        expect(world.inside.has("Ben")).toBe(false);
        expect(
            world.sent.some((line) => line.startsWith("tellraw @a") && line.includes("Ben is out"))
        ).toBe(true);
        world.at.Cy = [arenaAt.centre.x, arenaAt.floor - 3, arenaAt.centre.z];
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
        expect(world.sent).toContain("gamemode survival Ana");
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
    for (const line of world.sent.filter((one) => one.startsWith("clear "))) {
        expect(line).toContain("polaris_event:1b");
    }
}

/** A run that joined, built and brought everybody in: countdown, joins, setup. */
async function joinAndStart(presetId: string): Promise<void> {
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
    chat(["Ana", "join"], ["Ben", "unirse"], ["Cy", "hello"]);
    await play(30_000);
    expect(state().run?.joined).toEqual(["Ana", "Ben"]);
    await play(20_000);
}

describe("a team duel", () => {
    const duelOf = (minutes = 3) => ({ ...catalog.newPreset("team-duel", "duel"), minutes });

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
        expect(world.sent).toContain("team remove pe_red");
        expect(world.sent).toContain(
            `execute in minecraft:overworld run forceload remove ${box.x1} ${box.z1} ${box.x2} ${box.z2}`
        );
        expect(after.arenaLeftovers).toEqual([]);
        onlyOurBlocks();
    });

    it("refuses to start on a server with PvP blocked, and says where to allow it", async () => {
        world.properties = "difficulty=normal\npvp=false\n";
        setUp([duelOf()]);
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "duel",
                trigger: "manual",
                startedBy: null
            })
        ).rejects.toThrow(/Player versus player is Blocked.*Allow it under Settings/);
        expect(state().run).toBeNull();
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
            note: "Fewer than two players joined"
        });
        expect(fills()).toEqual([]);
        expect(world.sent.some((line) => / run tp (Ana|Ben) /.test(line))).toBe(false);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw @a") && line.includes("Only 1 joined and it needs 2")
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
    const duel = () => ({ ...catalog.newPreset("team-duel", "duel"), minutes: 3 });
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
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "duel",
                trigger: "manual",
                startedBy: null
            })
        ).rejects.toThrow(/needs Minecraft 1.16/);
    });
});

describe("a server with EssentialsX on it", () => {
    beforeEach(() => {
        world.bukkit = true;
        world.essentials = true;
    });

    it("runs a duel with the game's own commands: kit given and taken back, everybody home", async () => {
        world.online = ["Ana", "Ben"];
        setUp([{ ...catalog.newPreset("team-duel", "duel"), minutes: 3 }]);
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
        setUp([catalog.newPreset("fishing", "fish")], {
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
        setUp([{ ...catalog.newPreset("blood-moon", "moon"), minutes: 3 }]);
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

describe("a world boss whose server's version is unknown", () => {
    it.each(["1.20.1", "1.21.4", "1.21.5", "26.1"])("wears its own name on %s", async (version) => {
        world.version = version;
        world.versionIn = "none";
        setUp([{ ...catalog.newPreset("world-boss", "boss"), minutes: 3 }]);
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
        const duel = { ...catalog.newPreset("team-duel", "duel"), minutes: 10 };
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
            ...catalog.newPreset("build-battle", "build"),
            minutes: 3,
            options: {
                ...catalog.optionsSchemas["build-battle"].parse({}),
                voteSeconds: 30,
                themeMode: "mine" as const,
                themes: ["A lighthouse"]
            }
        };
        setUp([battle]);
        await joinAndStart("build");
        const run = state().run!;
        expect(run.readyAt).not.toBeNull();
        expect(run.theme).toBe("A lighthouse");
        expect(fills().every((line) => line.endsWith(" keep"))).toBe(true);
        expect(
            fills().filter((line) => line.includes("minecraft:white_stained_glass keep"))
        ).toHaveLength(2);
        // Their own blocks cannot go down in adventure mode; the kit's glass only on the plot.
        expect(world.sent).toContain("gamemode adventure Ben");
        const kit = world.sent.filter((line) => line.startsWith("give Ana "));
        expect(kit).toHaveLength(17);
        expect(kit.every((line) => line.includes("minecraft:custom_data={polaris_event:1b}"))).toBe(
            true
        );
        expect(kit[0]).toContain('minecraft:can_place_on={blocks:["minecraft:white_stained_glass"');
        expect(
            world.sent.some(
                (line) => line.startsWith("title Ana subtitle") && line.includes("A lighthouse")
            )
        ).toBe(true);

        // Nobody can be hurt on a plot, or on the tour with the others.
        expect(world.sent).toContain("effect give Ben minecraft:resistance 3 4 true");

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
        expect(
            world.sent.some((line) =>
                /^execute in minecraft:overworld run tp (Ana|Ben) .* -45 20$/.test(line)
            )
        ).toBe(true);
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
        expect(after.arenaLeftovers).toEqual([]);
        onlyOurBlocks();
    });
});
