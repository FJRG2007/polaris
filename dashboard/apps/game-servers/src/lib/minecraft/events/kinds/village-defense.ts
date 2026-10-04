/**
 * Villager defense: a horde defense (`waves`) played round a villager set down
 * at the point. It is the horde's whole machinery - the place, the wave timing,
 * the sizes by defenders, the gear, the counts of who held the point - with a
 * villager to keep alive, and only monsters that go for one.
 *
 * Pure, like the rest of the commands. How the villager is kept:
 *
 * - It cannot wander off: summoned with `NoAI`. A pen would be blocks built
 *   into the world round it, to be taken down again and kept out of the way
 *   of the monsters that have to reach it; with no AI it stands on its spot,
 *   is pushed by nothing, and is still hit by whatever reaches it.
 * - It is persistent, named (`customNameValue`), glowing, and tagged
 *   `VILLAGER_TAG` - never `MOB_TAG`, which is what counts a wave's monsters.
 *   Whatever ends the event kills exactly what carries the tag.
 * - A zombie that kills a villager on Normal or Hard turns it into a zombie
 *   villager where it stood; that one is taken away with it
 *   (`villagerCleanup`).
 *
 * Which monsters go for it: in vanilla a zombie (husk and zombie villager
 * included), a vindicator and a pillager hunt villagers; a skeleton, a stray,
 * a spider and a witch never do, so none of those come (`VILLAGE_MOBS`). Each
 * of them goes for a player it sees before a villager, though - its target
 * goals rank players first. From 1.19.4 a wave is turned on the villager
 * (`provokeLine`): every monster no defender stands right next to is touched
 * by the villager with `/damage`, which is what a mob takes for being hit, and
 * makes it go for whoever hit it ahead of any player. A defender who strikes
 * it draws it off again. Before 1.19.4 there is no such command, and the
 * monsters go for the villager only when no player is in their sight.
 */

import { z } from "zod";
import { MOUNT_TAG, type WaveMix } from "./waves";
import { customNameValue, MOB_TAG } from "../commands";

/** What the villager carries, and the only thing the end kills for it. */
export const VILLAGER_TAG = "pe_villager";

/** The villager's health, as the game gives one. */
export const VILLAGER_HEALTH = 20;

/** Looks in a row the villager must be missing before it is taken as lost: a
 *  server that has just started loads entities a moment after their chunks. */
export const LOST_AFTER = 2;

/** Its health, as a share, under which everybody is warned - once each. */
export const WARN_AT = [0.5, 0.25] as const;

/** How many ticks apart the wave is turned on the villager again. */
export const PROVOKE_EVERY = 3;

/** A monster within this of a player is that player's to fight. */
export const ENGAGED = 3;

/**
 * The monsters each mix sends: only ones that hunt villagers in vanilla, and
 * none that can change a block (a ravager tramples crops, an evoker's vexes
 * and fangs are nobody's to clear up).
 */
export const VILLAGE_MOBS: Readonly<Record<WaveMix, readonly string[]>> = {
    classic: ["zombie", "vindicator"],
    undead: ["zombie", "husk", "zombie_villager"],
    mixed: ["zombie", "husk", "zombie_villager", "vindicator", "pillager"]
};

/** The names a villager may be given, one drawn from the run's id. */
export const VILLAGER_NAMES = [
    "Bartolo",
    "Petra",
    "Anselmo",
    "Casilda",
    "Tobias",
    "Remedios",
    "Eusebio",
    "Leonor",
    "Fermin",
    "Rufina"
] as const;

/** What a run keeps of its villager: written down before it is summoned. */
export const villagerSchema = z.object({
    name: z.string(),
    /** Whether it is known to be in the world: false while written down and
     *  not yet summoned - a restart then looks before summoning another. */
    summoned: z.boolean().default(false),
    /** Whether this server has `/damage` (1.19.4) to turn a wave on it. */
    provoke: z.boolean().default(false),
    /** How many of `WARN_AT` have been said. */
    warned: z.number().int().default(0),
    /** Looks in a row it was not found (`LOST_AFTER`). */
    missing: z.number().int().default(0),
    /** It died: the event ended there, with nobody winning. */
    lost: z.boolean().default(false)
});
export type Villager = z.infer<typeof villagerSchema>;

type Point = { readonly x: number; readonly y: number; readonly z: number };

/** The same name for the same run, whatever happens to it. */
export function villagerName(runId: string): string {
    let hash = 0;
    for (const char of runId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
    return VILLAGER_NAMES[Math.abs(hash) % VILLAGER_NAMES.length] as string;
}

const VILLAGER = `@e[type=minecraft:villager,tag=${VILLAGER_TAG},limit=1]`;

/** Whether it is there: `Test passed, count: 1`, or `Test failed`. */
export const VILLAGER_THERE = `execute if entity @e[type=minecraft:villager,tag=${VILLAGER_TAG}]`;

/** Its health right now: `... has the following entity data: 14.0f`. */
export const VILLAGER_HEALTH_READ = `data get entity ${VILLAGER} Health`;

/** Where it stands on the point: its middle, on the ground the place was judged on. */
export function villagerSpot(point: Point): string {
    return `${point.x + 0.5} ${point.y} ${point.z + 0.5}`;
}

/**
 * The villager set down at the point and named, the way this version writes a
 * name. Summoned with data, so it gets nothing of the game's own spawning: no
 * profession, a plains villager, which trades nothing.
 */
export function summonVillager(point: Point, name: string, modernText: boolean): string[] {
    return [
        `execute in minecraft:overworld run summon minecraft:villager ${villagerSpot(point)} {Tags:["${VILLAGER_TAG}"],NoAI:1b,PersistenceRequired:1b,Glowing:1b,CustomNameVisible:1b}`,
        `data merge entity ${VILLAGER} {CustomName:${customNameValue(name, modernText, "villager")}}`
    ];
}

/**
 * Every monster of the wave that no defender is right next to turned on the
 * villager, from 1.19.4: hurt by it for next to nothing, with a damage type
 * that does not knock back, so it goes for the villager ahead of any player.
 * Never a mount, which fights nobody.
 */
export function provokeLine(): string {
    return `execute as ${VILLAGER} at @s as @e[tag=${MOB_TAG},tag=!${MOUNT_TAG},distance=..48] at @s unless entity @a[distance=..${ENGAGED},gamemode=!spectator,gamemode=!creative] run damage @s 0.01 minecraft:generic by ${VILLAGER}`;
}

/** How many of `WARN_AT` its health has fallen under. */
export function warningsDue(health: number): number {
    return WARN_AT.filter((share) => health <= VILLAGER_HEALTH * share).length;
}

/** Its health in hearts, to one decimal: what the bar and the warnings say. */
export function hearts(health: number): string {
    const value = Math.max(0, Math.round(health * 5) / 10);
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Thanks from the villager, round it, when every wave was fought off. */
export function thanksLines(point: Point): string[] {
    const at = villagerSpot(point);
    return [
        `execute in minecraft:overworld run particle minecraft:happy_villager ${at} 0.6 1 0.6 0 30 force`,
        `execute in minecraft:overworld positioned ${at} run playsound minecraft:entity.villager.celebrate neutral @a[distance=..48] ~ ~ ~ 1 1`
    ];
}

/** The villager's last moment, for everybody near it. */
export function lostLines(point: Point): string[] {
    return [
        `execute in minecraft:overworld positioned ${villagerSpot(point)} run playsound minecraft:entity.villager.death neutral @a[distance=..64] ~ ~ ~ 1 0.8`
    ];
}

/**
 * The villager taken away - and, where it stood, the zombie villager a zombie
 * may have turned it into - while the chunks round the point are still held.
 * Safe to send again and again.
 */
export function villagerCleanup(point: Point | null): string[] {
    const lines = [`kill @e[tag=${VILLAGER_TAG}]`];
    if (point)
        lines.push(
            `execute in minecraft:overworld positioned ${villagerSpot(point)} run kill @e[type=minecraft:zombie_villager,distance=..1.5]`
        );
    return lines;
}
