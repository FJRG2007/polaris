/**
 * Lucky Block Race: the minigame, built and refereed by a data pack Polaris
 * writes into the world.
 *
 * The game everyone knows from the videos: a lane each, walled off from the
 * others, a row of lucky blocks down every lane that has to be broken to get
 * through, and an arena at the far end where whatever each player found decides
 * who is left standing. The published maps are Bedrock worlds or Java worlds
 * that need 1.8 Forge mods, so none of them runs on a current server; this is
 * the same layout, generated.
 *
 * The lucky blocks are the Lucky Blocks data pack's own (lullaby6, installed by
 * the blueprint from Modrinth): `lucky_blocks:block/place` puts one wherever it
 * is run, and breaking it rolls the pack's outcomes - items, kits, mobs, chests,
 * effects and its traps, among them the obsidian cell, the falling anvil and
 * TNT. Everything else - the lanes, the arena, the lobby and the referee - is
 * the pack written here, so the game runs inside the server tick by tick and
 * Polaris only has to put it there once (`lucky-race-service.ts`).
 *
 * How a round goes:
 * - Everyone waits in a closed lobby in the sky. Standing on the emerald block,
 *   or `/trigger lbr.start`, starts a round.
 * - Up to four players are drawn into the lanes, in survival with nothing on
 *   them; anybody else watches as a spectator. Ten seconds, then the gates open.
 * - Each checkpoint is two lucky blocks stacked across the lane with an
 *   unbreakable barrier above, so the only way on is through both.
 * - With two or more racers the last one alive wins, wherever they are. A racer
 *   alone wins by reaching the arena. A round that runs fifteen minutes ends
 *   with no winner.
 * - Ten seconds after the result the course is rebuilt and everyone is back in
 *   the lobby.
 *
 * Every command here is written in syntax every release from 1.21 accepts: a
 * function file that fails to parse is dropped whole, silently, so nothing that
 * changed name - the game rules above all, renamed in 1.21.11 - is put in one.
 * Those go to the console instead (`consoleLines`), where an unknown name is one
 * failed line and nothing more.
 *
 * Pure: geometry, text and files. Reaching a server is the service.
 */

import type { Language } from "./events/catalog";

/** The blueprint this is for. */
export const LUCKY_RACE_BLUEPRINT = "luckyrace";

/** The pack's folder in the level's `datapacks`, and its function namespace. */
export const RACE_PACK_DIR = "polaris-lucky-race";
const NS = "polaris_race";

/**
 * Bumped whenever the pack or the course changes, so a server set up by an
 * older Polaris is set up again: its files rewritten and its course rebuilt.
 */
export const RACE_VERSION = 1;

/** Install config key holding the version a server was last set up with. */
export const RACE_SETUP_KEY = "luckyRaceSetup";

/** Install config key counting passes that tried and did not get there. */
export const RACE_TRIES_KEY = "luckyRaceTries";

/** Passes that try before a server that never takes it is left alone. */
export const MAX_TRIES = 10;

/** Ticks a round may run before it ends with no winner: fifteen minutes. */
export const ROUND_TICKS = 15 * 60 * 20;

/** The course. Lanes run towards +z; the lobby floats above the origin. */
export const COURSE = {
    /** The lane floor's height; players walk one above it. */
    floor: 64,
    /** The lobby floor's height. */
    lobby: 100,
    /** Each lane's centre line. Twelve apart, so a trap's lava in one lane
     *  never reaches the next. */
    lanes: [-18, -6, 6, 18] as const,
    /** The lanes' back wall. */
    start: 30,
    /** Checkpoints per lane, and the distance between two. */
    checkpoints: 16,
    spacing: 5,
    /** The arena's half width and its depth inside the walls. */
    arenaHalf: 22,
    arenaDepth: 30
} as const;

/** Where the lane's gate stands, the first checkpoint, the lane's last block,
 *  and the arena's front wall. */
export function courseLine() {
    const gate = COURSE.start + 4;
    const first = COURSE.start + 7;
    const last = first + COURSE.spacing * (COURSE.checkpoints - 1);
    const end = last + 4;
    const arena = end + 1;
    return { gate, first, last, end, arena, back: arena + COURSE.arenaDepth + 1 };
}

/** The z of every checkpoint along a lane. */
export function checkpointRows(): number[] {
    const { first } = courseLine();
    return Array.from({ length: COURSE.checkpoints }, (_, k) => first + k * COURSE.spacing);
}

/** The most blocks one `/fill` may change. */
export const FILL_LIMIT = 32768;

/**
 * A `/fill` over a box of any size, cut along z into pieces the game accepts.
 */
export function fills(
    from: readonly [number, number, number],
    to: readonly [number, number, number],
    block: string,
    mode = ""
): string[] {
    const [x1, y1, z1] = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])];
    const [x2, y2, z2] = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])];
    const slice = (x2 - x1 + 1) * (y2 - y1 + 1);
    const depth = Math.max(1, Math.floor(FILL_LIMIT / slice));
    const lines: string[] = [];
    for (let z = z1; z <= z2; z += depth) {
        const top = Math.min(z2, z + depth - 1);
        lines.push(`fill ${x1} ${y1} ${z} ${x2} ${y2} ${top} ${block}${mode ? ` ${mode}` : ""}`);
    }
    return lines;
}

/** Everything the course occupies, lobby aside: cleared before every build. */
function courseBox() {
    const { back } = courseLine();
    const half = COURSE.arenaHalf + 1;
    return {
        from: [-half, COURSE.floor - 2, COURSE.start - 1] as const,
        to: [half, COURSE.floor + 21, back] as const
    };
}

/** A selector over the course's box. */
function inCourse(filter: string): string {
    const { from, to } = courseBox();
    const [dx, dy, dz] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    return `@e[${filter}x=${from[0]},y=${from[1]},z=${from[2]},dx=${dx},dy=${dy},dz=${dz}]`;
}

/** Where a spectator is put: above the arena's front wall, looking in. */
function spectatorSpot(): string {
    const { arena } = courseLine();
    return `0.5 ${COURSE.floor + 16} ${arena + 1}.5 0 35`;
}

/** Where the lobby puts a player: its middle, facing the emerald. */
const LOBBY_SPOT = `0.5 ${COURSE.lobby + 1} 0.5 0 0`;

/** The lines that build one lane, lucky blocks aside. */
function laneLines(x: number): string[] {
    const f = COURSE.floor;
    const { gate, end } = courseLine();
    const s = COURSE.start;
    return [
        ...fills([x - 2, f, s], [x + 2, f, end], "minecraft:bedrock"),
        ...fills([x - 1, f + 1, s], [x - 1, f + 2, end], "minecraft:bedrock"),
        ...fills([x + 1, f + 1, s], [x + 1, f + 2, end], "minecraft:bedrock"),
        ...fills([x - 2, f + 1, s], [x - 2, f + 11, end], "minecraft:barrier"),
        ...fills([x + 2, f + 1, s], [x + 2, f + 11, end], "minecraft:barrier"),
        ...fills([x - 2, f + 12, s], [x + 2, f + 12, end], "minecraft:barrier"),
        ...fills([x - 2, f + 1, s], [x + 2, f + 11, s], "minecraft:barrier"),
        // The gate, opened at the start, and the barrier over it that stays.
        ...fills([x, f + 1, gate], [x, f + 2, gate], "minecraft:barrier"),
        ...fills([x - 1, f + 3, gate], [x + 1, f + 11, gate], "minecraft:barrier"),
        // Over every checkpoint, so nobody climbs past one.
        ...checkpointRows().flatMap((z) =>
            fills([x - 1, f + 3, z], [x + 1, f + 11, z], "minecraft:barrier")
        )
    ];
}

/** The lines that put every lane's lucky blocks back. */
function luckyLines(): string[] {
    const f = COURSE.floor;
    return COURSE.lanes.flatMap((x) =>
        checkpointRows().flatMap((z) => [
            `execute positioned ${x} ${f + 1} ${z} run function lucky_blocks:block/place`,
            `execute positioned ${x} ${f + 2} ${z} run function lucky_blocks:block/place`
        ])
    );
}

/** The arena at the end of the lanes: grass over bedrock, walled and roofed. */
function arenaLines(): string[] {
    const f = COURSE.floor;
    const { arena, back } = courseLine();
    const half = COURSE.arenaHalf;
    const wall = half + 1;
    return [
        ...fills([-wall, f - 1, arena], [wall, f - 1, back], "minecraft:bedrock"),
        ...fills([-wall, f, arena], [wall, f, back], "minecraft:bedrock"),
        ...fills([-half, f, arena + 1], [half, f, back - 1], "minecraft:grass_block"),
        // Walls: glass to look through at head height, barrier above it.
        ...fills([-wall, f + 1, arena], [wall, f + 19, back], "minecraft:barrier", "outline"),
        ...fills([-wall, f + 1, arena], [wall, f + 3, arena], "minecraft:glass"),
        ...fills([-wall, f + 1, back], [wall, f + 3, back], "minecraft:glass"),
        ...fills([-wall, f + 1, arena], [-wall, f + 3, back], "minecraft:glass"),
        ...fills([wall, f + 1, arena], [wall, f + 3, back], "minecraft:glass"),
        ...fills([-wall, f + 20, arena], [wall, f + 20, back], "minecraft:barrier"),
        // A doorway where each lane comes in.
        ...COURSE.lanes.flatMap((x) => fills([x, f + 1, arena], [x, f + 2, arena], "minecraft:air"))
    ];
}

/** The lobby: a closed room in the sky with the start block in it. */
function lobbyLines(): string[] {
    const y = COURSE.lobby;
    return [
        `fill -7 ${y} -7 7 ${y + 5} 7 minecraft:barrier hollow`,
        `fill -6 ${y} -6 6 ${y} 6 minecraft:white_concrete`,
        `fill -7 ${y + 1} -7 7 ${y + 1} 7 minecraft:white_stained_glass outline`,
        `setblock 0 ${y} 4 minecraft:emerald_block`
    ];
}

/** What the players read, in the server's language. */
const TEXT = {
    en: {
        lobby: "Stand on the emerald block to start the race",
        countdown: "Break the lucky blocks!",
        go: "GO!",
        full: "The race is full - you are watching this one",
        out: " is out",
        outTitle: "You are out",
        outSub: "Watch the rest from here",
        arrived: " reached the arena!",
        wins: " wins!",
        winsTitle: "wins!",
        nobody: "Nobody won",
        timeUp: "Time is up",
        back: "Back to the lobby",
        started: "The race begins with ",
        racers: " racer(s)"
    },
    es: {
        lobby: "Pisa el bloque de esmeralda para empezar la carrera",
        countdown: "¡Rompe los lucky blocks!",
        go: "¡YA!",
        full: "La carrera está llena: esta ronda la ves",
        out: " ha caído",
        outTitle: "Has caído",
        outSub: "Mira el resto desde aquí",
        arrived: " ha llegado a la arena",
        wins: " gana",
        winsTitle: "¡gana!",
        nobody: "Nadie ha ganado",
        timeUp: "Se acabó el tiempo",
        back: "Volvéis al lobby",
        started: "Empieza la carrera con ",
        racers: " jugador(es)"
    }
} as const satisfies Record<Language, Record<string, string>>;

/** A text component, written so every release reads it: JSON, which the
 *  SNBT reader of 1.21.5 onwards accepts as it is. */
function text(value: string, color: string, bold = false): string {
    return JSON.stringify(bold ? { text: value, color, bold: true } : { text: value, color });
}

function sound(id: string): string {
    return `execute as @a at @s run playsound minecraft:${id} master @s ~ ~ ~ 1 1`;
}

/** The pack's functions, by name. */
export function raceFunctions(language: Language): Record<string, string[]> {
    const t = TEXT[language];
    const f = COURSE.floor;
    const { arena, back } = courseLine();
    const s = COURSE.start;
    const half = COURSE.arenaHalf + 1;
    const state = "lbr.state";
    const phase = (n: number) => `execute if score #phase ${state} matches ${n}`;
    const notCreative = "unless entity @s[gamemode=creative]";
    return {
        load: [
            `scoreboard objectives add ${state} dummy`,
            "scoreboard objectives add lbr.deaths deathCount",
            "scoreboard objectives add lbr.round dummy",
            "scoreboard objectives add lbr.start trigger",
            `scoreboard players set #20 ${state} 20`,
            `execute unless score #phase ${state} matches 0.. run scoreboard players set #phase ${state} 0`,
            `execute unless score #round ${state} matches 0.. run scoreboard players set #round ${state} 0`
        ],
        // Run once by Polaris, and again whenever a newer course is put in.
        setup: [
            `forceload add ${-half} -8 ${half} ${back}`,
            `setworldspawn 0 ${COURSE.lobby + 1} 0`,
            "time set noon",
            "weather clear",
            "difficulty normal",
            `scoreboard players set #phase ${state} 0`,
            // The chunks just asked for are loaded over the next ticks; a fill
            // into one that is not yet is refused.
            `schedule function ${NS}:build 40t`
        ],
        build: [
            `kill ${inCourse("type=!minecraft:player,")}`,
            ...fills(courseBox().from, courseBox().to, "minecraft:air"),
            ...COURSE.lanes.flatMap(laneLines),
            ...arenaLines(),
            ...lobbyLines(),
            ...luckyLines()
        ],
        tick: [
            `scoreboard players add #tick ${state} 1`,
            `scoreboard players operation #mod ${state} = #tick ${state}`,
            `scoreboard players operation #mod ${state} %= #20 ${state}`,
            `${phase(0)} run function ${NS}:phase/lobby`,
            `${phase(1)} run function ${NS}:phase/countdown`,
            `${phase(2)} run function ${NS}:phase/race`,
            `${phase(3)} run function ${NS}:phase/ended`,
            "scoreboard players enable @a lbr.start",
            `execute as @a[scores={lbr.start=1..}] run function ${NS}:pressed`
        ],
        pressed: [
            "scoreboard players set @s lbr.start 0",
            `${phase(0)} run function ${NS}:start`
        ],
        "phase/lobby": [
            `execute as @a[tag=!lbr.lobby] run function ${NS}:player/to_lobby`,
            `execute if score #mod ${state} matches 0 run function ${NS}:lobby_second`,
            `execute as @a[tag=lbr.lobby,gamemode=!creative,gamemode=!spectator] at @s if block ~ ~-1 ~ minecraft:emerald_block run function ${NS}:start`
        ],
        lobby_second: [
            `title @a[tag=lbr.lobby] actionbar ${text(t.lobby, "yellow")}`,
            "effect give @a[tag=lbr.lobby] minecraft:saturation 2 0 true",
            "effect give @a[tag=lbr.lobby] minecraft:resistance 2 4 true",
            "effect give @a[tag=lbr.lobby] minecraft:regeneration 2 4 true",
            "gamemode adventure @a[tag=lbr.lobby,gamemode=!adventure,gamemode=!creative]",
            `execute as @a[tag=lbr.lobby,gamemode=!creative] unless entity @s[x=-7,y=${COURSE.lobby},z=-7,dx=14,dy=6,dz=14] run tp @s ${LOBBY_SPOT}`
        ],
        "player/to_lobby": [
            "tag @s remove lbr.in",
            "tag @s remove lbr.out",
            "tag @s remove lbr.arrived",
            "tag @s add lbr.lobby",
            "clear @s",
            "effect clear @s",
            "xp set @s 0 levels",
            "xp set @s 0 points",
            "scoreboard players set @s lbr.deaths 0",
            `execute ${notCreative} run gamemode adventure @s`,
            `tp @s ${LOBBY_SPOT}`
        ],
        start: [
            `execute unless score #phase ${state} matches 0 run return 0`,
            `scoreboard players set #phase ${state} 1`,
            `scoreboard players set #timer ${state} 200`,
            `scoreboard players add #round ${state} 1`,
            "tag @a remove lbr.in",
            "tag @a remove lbr.out",
            "tag @a remove lbr.arrived",
            ...COURSE.lanes.map(
                (_, i) => `execute as @r[tag=lbr.lobby,gamemode=!creative] run function ${NS}:lane/${i}`
            ),
            `execute as @a[tag=lbr.lobby] run tellraw @s ${text(t.full, "gray")}`,
            `execute as @a[tag=lbr.lobby] run function ${NS}:player/spectate`,
            `execute store result score #started ${state} if entity @a[tag=lbr.in]`,
            `tellraw @a [${text(t.started, "yellow")},{"score":{"name":"#started","objective":"${state}"},"color":"aqua","bold":true},${text(t.racers, "yellow")}]`
        ],
        ...Object.fromEntries(
            COURSE.lanes.map((x, i) => [
                `lane/${i}`,
                [
                    "tag @s remove lbr.lobby",
                    "tag @s remove lbr.arrived",
                    "tag @s add lbr.in",
                    `scoreboard players operation @s lbr.round = #round ${state}`,
                    "scoreboard players set @s lbr.deaths 0",
                    "clear @s",
                    "effect clear @s",
                    "gamemode survival @s",
                    "effect give @s minecraft:instant_health 1 10 true",
                    "effect give @s minecraft:saturation 1 10 true",
                    `tp @s ${x}.5 ${f + 1} ${s + 2}.5 0 0`
                ]
            ])
        ),
        "player/spectate": [
            "tag @s remove lbr.lobby",
            "tag @s remove lbr.in",
            "tag @s remove lbr.arrived",
            "tag @s add lbr.out",
            "gamemode spectator @s",
            `tp @s ${spectatorSpot()}`
        ],
        // Every tick of a round: who joined, came back from an older round, or
        // respawned in the lobby after falling out.
        guard: [
            `execute as @a[tag=!lbr.in,tag=!lbr.out] run function ${NS}:player/spectate`,
            `execute as @a[tag=lbr.in] unless score @s lbr.round = #round ${state} run function ${NS}:player/spectate`,
            `execute as @a[tag=lbr.out] if entity @s[y=${COURSE.lobby - 5},dy=60] run tp @s ${spectatorSpot()}`
        ],
        "phase/countdown": [
            `function ${NS}:guard`,
            `scoreboard players remove #timer ${state} 1`,
            `scoreboard players operation #left ${state} = #timer ${state}`,
            `scoreboard players operation #left ${state} %= #20 ${state}`,
            `scoreboard players operation #sec ${state} = #timer ${state}`,
            `scoreboard players operation #sec ${state} /= #20 ${state}`,
            `execute if score #left ${state} matches 0 if score #timer ${state} matches 1.. run title @a title {"score":{"name":"#sec","objective":"${state}"},"color":"gold","bold":true}`,
            `execute if score #left ${state} matches 0 if score #timer ${state} matches 1.. run title @a subtitle ${text(t.countdown, "yellow")}`,
            `execute if score #left ${state} matches 0 if score #timer ${state} matches 1.. run ${sound("block.note_block.hat")}`,
            `execute if score #timer ${state} matches ..0 run function ${NS}:go`
        ],
        go: [
            `scoreboard players set #phase ${state} 2`,
            `scoreboard players set #timer ${state} 0`,
            ...COURSE.lanes.flatMap((x) =>
                fills([x, f + 1, courseLine().gate], [x, f + 2, courseLine().gate], "minecraft:air")
            ),
            `title @a title ${text(t.go, "green", true)}`,
            `title @a subtitle ${text("", "white")}`,
            sound("entity.player.levelup")
        ],
        "phase/race": [
            `function ${NS}:guard`,
            `scoreboard players add #timer ${state} 1`,
            `execute as @a[tag=lbr.in,scores={lbr.deaths=1..}] run function ${NS}:player/out`,
            `execute as @a[tag=lbr.in,tag=!lbr.arrived] if entity @s[x=${-half},y=${f - 5},z=${arena},dx=${half * 2},dy=40,dz=${back - arena}] run function ${NS}:player/arrived`,
            `execute store result score #alive ${state} if entity @a[tag=lbr.in]`,
            `execute if score #started ${state} matches 2.. if score #alive ${state} matches ..1 run return run function ${NS}:finish`,
            `execute if score #alive ${state} matches 0 run return run function ${NS}:finish`,
            `execute if score #started ${state} matches 1 if entity @a[tag=lbr.in,tag=lbr.arrived] run return run function ${NS}:finish`,
            `execute if score #timer ${state} matches ${ROUND_TICKS}.. run function ${NS}:time_up`
        ],
        "player/out": [
            "scoreboard players set @s lbr.deaths 0",
            `tellraw @a [{"selector":"@s","color":"aqua","bold":true},${text(t.out, "red")}]`,
            "tag @s remove lbr.in",
            "tag @s add lbr.out",
            "gamemode spectator @s",
            `tp @s ${spectatorSpot()}`,
            `title @s title ${text(t.outTitle, "red", true)}`,
            `title @s subtitle ${text(t.outSub, "gray")}`
        ],
        "player/arrived": [
            "tag @s add lbr.arrived",
            `tellraw @a [{"selector":"@s","color":"aqua","bold":true},${text(t.arrived, "yellow")}]`
        ],
        time_up: [
            `tellraw @a ${text(t.timeUp, "red", true)}`,
            "tag @a remove lbr.in",
            `function ${NS}:finish`
        ],
        finish: [
            `scoreboard players set #phase ${state} 3`,
            `scoreboard players set #timer ${state} 200`,
            `execute if entity @a[tag=lbr.in] run tellraw @a [{"selector":"@a[tag=lbr.in]","color":"aqua","bold":true},${text(t.wins, "green", true)}]`,
            `execute if entity @a[tag=lbr.in] run title @a title {"selector":"@a[tag=lbr.in]","color":"gold","bold":true}`,
            `execute if entity @a[tag=lbr.in] run title @a subtitle ${text(t.winsTitle, "green")}`,
            `execute unless entity @a[tag=lbr.in] run title @a title ${text(t.nobody, "red", true)}`,
            `execute unless entity @a[tag=lbr.in] run title @a subtitle ${text("", "white")}`,
            sound("ui.toast.challenge_complete")
        ],
        "phase/ended": [
            `function ${NS}:guard`,
            `scoreboard players remove #timer ${state} 1`,
            `execute if score #timer ${state} matches ..0 run function ${NS}:reset`
        ],
        reset: [
            `function ${NS}:build`,
            `scoreboard players set #phase ${state} 0`,
            "tag @a remove lbr.lobby",
            `tellraw @a ${text(t.back, "yellow")}`
        ]
    };
}

/** The pack's files, by their path inside its folder. */
export function racePackFiles(language: Language): ReadonlyMap<string, string> {
    const files = new Map<string, string>();
    // 48 is 1.21, the first release the Lucky Blocks pack and the singular
    // `function` folder share. Both spellings of the range: `supported_formats`
    // up to 1.21.8, `min_format`/`max_format` from 1.21.9.
    files.set(
        "pack.mcmeta",
        `${JSON.stringify({
            pack: {
                description: "Polaris Lucky Block Race",
                pack_format: 48,
                supported_formats: [48, 1000],
                min_format: 48,
                max_format: 1000
            }
        })}\n`
    );
    files.set("data/minecraft/tags/function/load.json", `${JSON.stringify({ values: [`${NS}:load`] })}\n`);
    files.set("data/minecraft/tags/function/tick.json", `${JSON.stringify({ values: [`${NS}:tick`] })}\n`);
    for (const [name, lines] of Object.entries(raceFunctions(language)))
        files.set(`data/${NS}/function/${name}.mcfunction`, `${lines.join("\n")}\n`);
    return files;
}

/**
 * The console lines that finish setting a server up once the pack is on: the
 * world rules the game needs, in both spellings (the camel-case names up to
 * 1.21.10, the renamed ones from 1.21.11 - a server answers the spelling it
 * does not know with one failed line), then the build.
 */
export function consoleLines(): string[] {
    const rules: readonly (readonly [string, string, string])[] = [
        ["spawnRadius", "respawn_radius", "0"],
        ["doImmediateRespawn", "immediate_respawn", "true"],
        ["doMobSpawning", "spawn_mobs", "false"],
        ["doDaylightCycle", "advance_time", "false"],
        ["doWeatherCycle", "advance_weather", "false"],
        ["doInsomnia", "spawn_phantoms", "false"],
        ["announceAdvancements", "show_advancement_messages", "false"],
        ["keepInventory", "keep_inventory", "false"]
    ];
    return [
        ...rules.flatMap(([old, renamed, value]) => [`gamerule ${old} ${value}`, `gamerule ${renamed} ${value}`]),
        `function ${NS}:setup`
    ];
}

/** Whether a server is one this is for. */
export function wantsRace(blueprintId: unknown): boolean {
    return blueprintId === LUCKY_RACE_BLUEPRINT;
}

/** Whether a level's `datapacks` listing has the Lucky Blocks pack in it. */
export function hasLuckyPack(entries: readonly string[]): boolean {
    return entries.some((entry) => /lucky/i.test(entry) && entry !== RACE_PACK_DIR);
}
