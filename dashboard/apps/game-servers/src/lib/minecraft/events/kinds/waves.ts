/**
 * Horde defence: a point marked on open ground, and waves of monsters summoned
 * around it, each bigger and stronger than the last.
 *
 * Pure, like the rest of the commands. What keeps it from costing anybody
 * anything is here too:
 *
 * - Only monsters that cannot change a block come: no creeper, enderman,
 *   ravager, silverfish, blaze or slime. Zombies are summoned unable to break
 *   doors and unable to call for help (a zombie's reinforcements would be
 *   untagged, and so outlive the event), and nothing picks up loot.
 * - Everything summoned carries `MOB_TAG` and is kept on a leash round the
 *   point, inside chunks held loaded, so the `kill` at the end reaches every one.
 * - `keepInventory` is on for exactly the event (`KEEP_INVENTORY`), put back by
 *   the same record of game rules a blood moon uses.
 */

import type { EventOptions } from "../catalog";
import { MOB_TAG, SCORE, hillTick, readTest } from "../commands";

export type WaveMix = EventOptions<"waves">["mix"];

type Point = { readonly x: number; readonly y: number; readonly z: number };

/** Radius of the marked ring; the monsters are spread inside it, and the
 *  ground under all of it is checked to be the world's own. */
export const DEFENCE_RADIUS = 12;
/** Within this of the point a player counts as defending it. */
export const AREA = 24;
/** A monster that wanders further than this is brought back to the point. */
export const LEASH = 24;
/** Kills and hits within this of the point are the event's. */
export const REACH = 40;
/** How far each way the chunks round the point are held loaded, past the
 *  leash, so no monster is ever in ground the server let go of. */
export const LOAD_REACH = 32;
/** How far from anybody's bed the point may be: twice the usual, since what
 *  comes is a horde. */
export const CLEARANCE = 96;
/** The most monsters one wave may bring, however many defend. */
export const WAVE_CAP = 60;

/** Only for as long as a wave is being summoned. */
const NEW_TAG = "pe_wnew";
/** Kills near the point, and hits near it - the one who only wounds takes part too. */
export const KILLS = "pe_wkill";
export const HITS = "pe_whit";
const RAW_HITS = "pe_wraw";

/** The monsters each mix sends, none of which can change a block. */
export const MIX_MOBS: Readonly<Record<WaveMix, readonly string[]>> = {
    classic: ["zombie", "skeleton", "spider"],
    undead: ["zombie", "husk", "skeleton", "stray"],
    mixed: ["zombie", "skeleton", "spider", "husk", "witch"]
};

/** The ones that fight with a bow, which `summon` with data does not hand them. */
const ARCHERS = ["skeleton", "stray"];
/** The ones that can break a door and call for help. */
const ZOMBIES = ["zombie", "husk"];

/**
 * What every monster is summoned with: tagged, never despawning (a wave that
 * vanishes when players step away is not cleared), never picking anything up,
 * never breaking a door, and dropping none of the gear it was handed. A key a
 * mob does not have is ignored by the game.
 */
const SUMMON_DATA = `{Tags:["${MOB_TAG}","${NEW_TAG}"],PersistenceRequired:1b,CanPickUpLoot:0b,CanBreakDoors:0b,HandDropChances:[0.0f,0.0f],ArmorDropChances:[0.0f,0.0f,0.0f,0.0f]}`;

/** One kill counter per kind of monster in the mix. */
function killObjectives(mix: WaveMix): { objective: string; criterion: string }[] {
    return MIX_MOBS[mix].map((id, index) => ({
        objective: `pe_wk${index}`,
        criterion: `minecraft.killed:minecraft.${id}`
    }));
}

/**
 * How many monsters a wave brings: the base, half as many again for each wave
 * before it, and half as many again for each defender past the first (up to
 * five), never past `WAVE_CAP`.
 */
export function waveSize(base: number, number: number, defenders: number): number {
    const perDefender = base + Math.round(base * 0.5 * Math.max(0, number));
    const crowd = 1 + 0.5 * (Math.min(5, Math.max(1, defenders)) - 1);
    return Math.max(1, Math.min(WAVE_CAP, Math.round(perDefender * crowd)));
}

/** What a wave is made stronger with, from the third on. */
export function waveEffects(number: number): { effect: string; level: number }[] {
    const wave = number + 1;
    const effects: { effect: string; level: number }[] = [];
    if (wave >= 3) effects.push({ effect: "strength", level: wave >= 5 ? 1 : 0 });
    if (wave >= 5) effects.push({ effect: "resistance", level: 0 });
    if (wave >= 7) effects.push({ effect: "speed", level: 0 });
    return effects;
}

/** The objectives the kills and hits are counted with. */
export function wavesSetup(mix: WaveMix): string[] {
    const lines: string[] = [];
    for (const one of killObjectives(mix)) {
        lines.push(
            `scoreboard objectives remove ${one.objective}`,
            `scoreboard objectives add ${one.objective} ${one.criterion}`
        );
    }
    lines.push(
        `scoreboard objectives remove ${KILLS}`,
        `scoreboard objectives add ${KILLS} dummy`,
        `scoreboard objectives remove ${RAW_HITS}`,
        `scoreboard objectives add ${RAW_HITS} minecraft.custom:minecraft.damage_dealt`,
        `scoreboard objectives remove ${HITS}`,
        `scoreboard objectives add ${HITS} dummy`
    );
    return lines;
}

/**
 * One wave, summoned on the point and spread onto the surface inside the ring,
 * then armed and made as strong as its number says. Lasts as long as the
 * event may still run, so no effect runs out mid-wave.
 */
export function summonWave(
    point: Point,
    mix: WaveMix,
    count: number,
    number: number,
    seconds: number
): string[] {
    const kinds = MIX_MOBS[mix];
    const at = `${point.x + 0.5} ${point.y} ${point.z + 0.5}`;
    const time = Math.max(60, Math.min(1_000_000, Math.ceil(seconds)));
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
        const kind = kinds[(number + index) % kinds.length] as string;
        lines.push(
            `execute in minecraft:overworld run summon minecraft:${kind} ${at} ${SUMMON_DATA}`
        );
    }
    const fresh = `@e[tag=${NEW_TAG}]`;
    lines.push(
        `execute in minecraft:overworld run spreadplayers ${point.x} ${point.z} 2 ${DEFENCE_RADIUS} false ${fresh}`
    );
    for (const archer of ARCHERS.filter((id) => kinds.includes(id))) {
        const them = `@e[tag=${NEW_TAG},type=minecraft:${archer}]`;
        // `item replace` from 1.17, `replaceitem` before it: whichever the
        // server does not know fails and changes nothing.
        lines.push(
            `item replace entity ${them} weapon.mainhand with minecraft:bow`,
            `replaceitem entity ${them} weapon.mainhand minecraft:bow`
        );
    }
    for (const zombie of ZOMBIES.filter((id) => kinds.includes(id))) {
        // No calls for help: a reinforcement is a zombie nobody tagged. The
        // attribute lost its `zombie.` in 1.21.2; both are tried.
        for (const id of [
            "minecraft:spawn_reinforcements",
            "minecraft:zombie.spawn_reinforcements"
        ]) {
            lines.push(
                `execute as @e[tag=${NEW_TAG},type=minecraft:${zombie}] run attribute @s ${id} base set 0`
            );
        }
    }
    // Glowing, to find the last one; fire resistance, so a wave in daylight
    // is not burnt away by the sun before anybody fights it.
    lines.push(
        `effect give ${fresh} minecraft:glowing ${time} 0 true`,
        `effect give ${fresh} minecraft:fire_resistance ${time} 0 true`
    );
    for (const { effect, level } of waveEffects(number)) {
        lines.push(`effect give ${fresh} minecraft:${effect} ${time} ${level} true`);
    }
    lines.push(`tag ${fresh} remove ${NEW_TAG}`);
    return lines;
}

/** How many of the event's monsters are still about: `Test passed, count: 7`. */
export const WAVE_ALIVE = `execute if entity @e[tag=${MOB_TAG}]`;

/** The count out of a `WAVE_ALIVE` answer: 0 when none is left, null when the
 *  server could not say. */
export function readAlive(output: string): number | null {
    const answer = readTest(output);
    if (answer === "failed") return 0;
    if (answer !== "passed") return null;
    const match = /count:\s*(\d+)/i.exec(output);
    return match ? Number(match[1]) : 1;
}

/** Everybody defending the point now, as a `WHERE`-style answer. */
export function defenders(point: Point): string {
    return `execute in minecraft:overworld positioned ${point.x + 0.5} ${point.y} ${point.z + 0.5} as @a[distance=..${AREA},gamemode=!spectator,gamemode=!creative] run data get entity @s Pos`;
}

/** Any monster that strayed too far brought back onto the point, which is open
 *  air: a leash, so none walks off into ground nobody has loaded. */
export function leash(point: Point): string {
    const at = `${point.x + 0.5} ${point.y} ${point.z + 0.5}`;
    return `execute in minecraft:overworld positioned ${at} as @e[tag=${MOB_TAG},distance=${LEASH}..] run tp @s ${at}`;
}

/** The ring and the column of light, from the hill's - without its counting. */
export function wavesMarks(point: Point): string[] {
    return hillTick(point, DEFENCE_RADIUS, 0).filter((line) => !line.includes("scoreboard"));
}

/**
 * The kills and hits made near the point since the last tick added to each
 * player's, and the side panel brought up to date. Anything done elsewhere, or
 * while no wave is on (`open` false), is let go: the raw counts are emptied
 * every tick either way.
 */
export function wavesTick(point: Point, mix: WaveMix, open: boolean): string[] {
    const near = `execute in minecraft:overworld positioned ${point.x + 0.5} ${point.y} ${point.z + 0.5} as @a[distance=..${REACH}] run scoreboard players operation @s`;
    const raw = [...killObjectives(mix).map((one) => one.objective), RAW_HITS];
    const lines: string[] = [];
    for (const objective of [...raw, KILLS, HITS])
        lines.push(`scoreboard players add @a ${objective} 0`);
    if (open) {
        for (const one of killObjectives(mix))
            lines.push(`${near} ${KILLS} += @s ${one.objective}`);
        lines.push(`${near} ${HITS} += @s ${RAW_HITS}`);
    }
    for (const objective of raw) lines.push(`scoreboard players set @a ${objective} 0`);
    lines.push(
        `execute as @a[scores={${KILLS}=1..}] run scoreboard players operation @s ${SCORE} = @s ${KILLS}`
    );
    return lines;
}

/** Everybody's hits near the point, online: `Ana has 40 [pe_whit]`. */
export const READ_HITS = `execute as @a run scoreboard players get @s ${HITS}`;

/** The game rule held on while it runs, under every name it has had. */
export const KEEP_INVENTORY = ["keepInventory", "keep_inventory"] as const;

/**
 * What a horde defence leaves, taken out: every monster it summoned - while
 * the chunks they are in are still held, so it goes before any chunk is let
 * go - then its objectives. Safe to send again and again.
 */
export function wavesCleanup(mix: WaveMix): string[] {
    const lines = [`kill @e[tag=${MOB_TAG}]`];
    for (const one of killObjectives(mix))
        lines.push(`scoreboard objectives remove ${one.objective}`);
    lines.push(
        `scoreboard objectives remove ${KILLS}`,
        `scoreboard objectives remove ${RAW_HITS}`,
        `scoreboard objectives remove ${HITS}`
    );
    return lines;
}
