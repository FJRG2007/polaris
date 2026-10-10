/**
 * A team duel's commands: the arena, the two teams, what is counted, and how a
 * player who dies is brought back.
 *
 * The arena is a closed box in the air: a floor of barrier under a layer of
 * glass - red at one end, blue at the other - barrier walls and a barrier roof.
 * Mobs cannot spawn on glass or barrier, nobody outside can break into it, and
 * nobody inside can break or place anything, playing in adventure mode.
 *
 * Nobody loses anything to it. A player is out by dying, as anywhere else in the
 * game, and `keepInventory` is on for exactly as long as it lasts, put back to
 * what the server had after: a death keeps everything, items and levels. Back
 * from it, they are sent to their side, healed, and shielded for a few seconds.
 * (Sending a player back at a few hearts left, before the next blow, counted
 * blows that would never have killed: a player out who was not.)
 *
 * Nobody heals on their own in it either. Everybody is kept fed so they can
 * sprint, and a full belly mends half a heart every half second - a fight
 * nobody could ever finish - so `naturalRegeneration` is off for as long as the
 * duel lasts, and put back the same way.
 *
 * Pure; the loop is `arena-service.ts`.
 */

import type { Box } from "../state";
import type { Spot } from "./arena";
import type { EventOptions } from "../catalog";

export const TEAMS = ["pe_red", "pe_blue"] as const;
const COLOURS = ["red", "blue"] as const;

/** The game's own counts: health, damage dealt, deaths and players killed. */
export const HP = "pe_hp";
export const DEALT = "pe_dealt";
export const DIED = "pe_died";
export const KILLS = "pe_pk";

export const READ_HP = `execute as @a run scoreboard players get @s ${HP}`;

/** A whole player's health: twenty half hearts. */
export const FULL_HEALTH = 20;

/**
 * Everybody's health as read, by name, with whoever is on but has no score -
 * the game sets a `health` score only when that player's health first
 * changes after the count was made - at full health, which is what an
 * unchanged health is here: everybody comes in healed. Without it, a player
 * nobody had hurt yet was taken for one not on.
 */
export function healthOf(
    read: ReadonlyMap<string, number>,
    on: Iterable<string>
): Map<string, number> {
    const health = new Map(read);
    const known = new Set([...read.keys()].map((name) => name.toLowerCase()));
    for (const name of on) if (!known.has(name.toLowerCase())) health.set(name, FULL_HEALTH);
    return health;
}
export const READ_DEALT = `execute as @a run scoreboard players get @s ${DEALT}`;
export const READ_DIED = `execute as @a run scoreboard players get @s ${DIED}`;
export const READ_KILLS = `execute as @a run scoreboard players get @s ${KILLS}`;

/** The game rule that keeps inventories through a death, under each name it has had. */
export const KEEP_INVENTORY = ["keepInventory", "keep_inventory"] as const;

/** The game rule that heals a fed player over time, under each name it has had. */
export const NATURAL_REGENERATION = ["naturalRegeneration", "natural_health_regeneration"] as const;

/** Half its width and length, and its height, floor and roof included. */
const HALF_X = 8;
const HALF_Z = 11;
const HEIGHT = 7;

/** How far from its center the ground under it is judged. */
export const DUEL_REACH = HALF_Z;

/** How many can play: eight a side. */
export const DUEL_MAX = 16;

/** Seconds a player sent back is shielded, and cannot strike either. */
export const SHIELD_SECONDS = 5;

const DUEL_RIM = "minecraft:polished_andesite";
const DUEL_LIGHT = "minecraft:sea_lantern";

export const FLOOR_BLOCKS = [
    "minecraft:red_stained_glass",
    "minecraft:white_stained_glass",
    "minecraft:blue_stained_glass"
] as const;

/** Every kind of block the arena is built of. */
export const DUEL_BLOCKS = ["minecraft:barrier", DUEL_RIM, DUEL_LIGHT, ...FLOOR_BLOCKS];

export function duelBox(center: { x: number; z: number }, floorY: number): Box {
    return {
        x1: center.x - HALF_X,
        y1: floorY,
        z1: center.z - HALF_Z,
        x2: center.x + HALF_X,
        y2: floorY + HEIGHT,
        z2: center.z + HALF_Z
    };
}

/**
 * What it is built with, each only into air: the barrier floor, roof and four
 * walls first, then the glass it is walked on.
 */
export function duelFills(box: Box): { box: Box; block: string }[] {
    const barrier = "minecraft:barrier";
    const mid = Math.round((box.z1 + box.z2) / 2);
    const glass = (z1: number, z2: number, block: string) => ({
        box: { x1: box.x1 + 1, y1: box.y1 + 1, z1, x2: box.x2 - 1, y2: box.y1 + 1, z2 },
        block
    });
    // Put in before the barrier walls, which then fill round them: a stone rim
    // at the floor's height all round, and a post of light three high at each
    // corner - the walls that were invisible read as an arena.
    const rimY = box.y1 + 1;
    const post = (x: number, z: number) => ({
        box: { x1: x, z1: z, x2: x, z2: z, y1: rimY, y2: rimY + 2 },
        block: DUEL_LIGHT
    });
    const rim = (x1: number, z1: number, x2: number, z2: number) => ({
        box: { x1, z1, x2, z2, y1: rimY, y2: rimY },
        block: DUEL_RIM
    });
    return [
        post(box.x1, box.z1),
        post(box.x2, box.z1),
        post(box.x1, box.z2),
        post(box.x2, box.z2),
        rim(box.x1 + 1, box.z1, box.x2 - 1, box.z1),
        rim(box.x1 + 1, box.z2, box.x2 - 1, box.z2),
        rim(box.x1, box.z1 + 1, box.x1, box.z2 - 1),
        rim(box.x2, box.z1 + 1, box.x2, box.z2 - 1),
        { box: { ...box, y2: box.y1 }, block: barrier },
        { box: { ...box, y1: box.y2 }, block: barrier },
        { box: { ...box, x2: box.x1 }, block: barrier },
        { box: { ...box, x1: box.x2 }, block: barrier },
        { box: { ...box, z2: box.z1 }, block: barrier },
        { box: { ...box, z1: box.z2 }, block: barrier },
        glass(box.z1 + 1, mid - 1, FLOOR_BLOCKS[0]),
        glass(mid, mid, FLOOR_BLOCKS[1]),
        glass(mid + 1, box.z2 - 1, FLOOR_BLOCKS[2])
    ];
}

/** Where the `index`th player of a side stands: along their own end, facing the other. */
export function sideSpot(box: Box, side: number, index: number): Spot {
    const cx = Math.round((box.x1 + box.x2) / 2);
    const step = Math.ceil(index / 2) * 2 * (index % 2 === 0 ? 1 : -1);
    const x = Math.max(box.x1 + 2, Math.min(box.x2 - 2, cx + step));
    return side === 0
        ? { x, y: box.y1 + 2, z: box.z1 + 3, yaw: 0 }
        : { x, y: box.y1 + 2, z: box.z2 - 3, yaw: 180 };
}

const SWORDS: Readonly<Record<EventOptions<"team-duel">["kit"], string>> = {
    wood: "minecraft:wooden_sword",
    stone: "minecraft:stone_sword",
    iron: "minecraft:iron_sword"
};

/** What goes in the off hand rather than the bag: nobody should have to put it there. */
export const OFFHAND_ITEM = "minecraft:shield";

/** The same for everybody: a sword and a shield. */
export function duelKit(kit: EventOptions<"team-duel">["kit"]): string[] {
    return [SWORDS[kit], OFFHAND_ITEM];
}

/** The teams, friendly fire off, and the counts the loop reads. */
export function duelSetup(names: readonly [string, string]): string[] {
    const lines: string[] = [];
    TEAMS.forEach((team, side) => {
        lines.push(
            `team remove ${team}`,
            `team add ${team} ${JSON.stringify({ text: names[side] })}`,
            `team modify ${team} color ${COLOURS[side]}`,
            `team modify ${team} friendlyFire false`
        );
    });
    for (const [objective, criterion] of [
        [HP, "health"],
        [DEALT, "minecraft.custom:minecraft.damage_dealt"],
        [DIED, "deathCount"],
        [KILLS, "playerKillCount"]
    ] as const) {
        lines.push(
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} ${criterion}`
        );
    }
    return lines;
}

/** The teams and counts removed again. Whoever was on one of ours is on none. */
export function duelTeardown(): string[] {
    return [
        ...TEAMS.map((team) => `team remove ${team}`),
        ...[HP, DEALT, DIED, KILLS].map((objective) => `scoreboard objectives remove ${objective}`)
    ];
}

/**
 * Onto a side's team, only if they are on no team at all: a player whose server
 * put them on one of its own keeps it, and plays uncolored rather than lose it.
 */
export function joinTeam(name: string, side: number): string {
    return `execute if entity @a[name=${name},team=] run team join ${TEAMS[side]} ${name}`;
}

/** Out of the fight: back to their side, healed whole at once - nothing heals
 *  them over time in here - and shielded, unable to be hurt or to hurt anybody,
 *  for a few seconds. */
export function sendBack(name: string, spot: Spot): string[] {
    return [
        `execute in minecraft:overworld run tp ${name} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} ${spot.yaw} 0`,
        `effect give ${name} minecraft:instant_health 1 3 true`,
        `effect give ${name} minecraft:resistance ${SHIELD_SECONDS} 4 true`,
        `effect give ${name} minecraft:weakness ${SHIELD_SECONDS} 4 true`
    ];
}

/** How long after a blow its striker is still credited with bringing somebody down. */
export const CREDIT_MS = 6_000;

/**
 * Who brought a player down. Where the game was asked who last hurt them
 * (`attacker`, from 1.19.4: null when nothing did), that one if a rival, and
 * nobody else - "struck last" is anybody's strike at anybody. Otherwise a rival
 * the game counts a player kill for since the last look, or else the rival who
 * struck last, within a few seconds.
 */
export function creditFor(
    rivals: readonly string[],
    killsSince: ReadonlyMap<string, number>,
    lastHit: ReadonlyMap<string, number>,
    now: number,
    attacker?: string | null
): string | null {
    if (attacker !== undefined)
        return rivals.find((name) => name.toLowerCase() === (attacker ?? "").toLowerCase()) ?? null;
    const killer = rivals.find((name) => (killsSince.get(name) ?? 0) > 0);
    if (killer) return killer;
    let best: string | null = null;
    let at = now - CREDIT_MS;
    for (const name of rivals) {
        const hit = lastHit.get(name);
        if (hit !== undefined && hit >= at) {
            best = name;
            at = hit;
        }
    }
    return best;
}
