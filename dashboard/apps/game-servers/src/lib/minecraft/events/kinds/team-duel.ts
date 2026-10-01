/**
 * A team duel's commands: the arena, the two teams, what is counted, and how a
 * player brought low is taken out of the fight before the next blow kills them.
 *
 * The arena is a closed box in the air: a floor of barrier under a layer of
 * glass - red at one end, blue at the other - barrier walls and a barrier roof.
 * Mobs cannot spawn on glass or barrier, nobody outside can break into it, and
 * nobody inside can break or place anything, playing in adventure mode.
 *
 * Nobody loses anything to it. Each tick reads everybody's health, and a player
 * at `downHearts` or below is out: sent back to their side, healed, and shielded
 * for a few seconds. A blow big enough to kill in between two looks is still
 * possible, so `keepInventory` is on for exactly as long as it lasts, and put
 * back to what the server had after: a death keeps everything, items and levels.
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
export const READ_DEALT = `execute as @a run scoreboard players get @s ${DEALT}`;
export const READ_DIED = `execute as @a run scoreboard players get @s ${DIED}`;
export const READ_KILLS = `execute as @a run scoreboard players get @s ${KILLS}`;

/**
 * Whoever is brought low between two looks, shielded at once: sent far oftener
 * than the tick (`events-service` quick look), so somebody already down to their
 * last hearts is not killed by the next blow while the tick has yet to see it.
 * The tick then sends them back to their side as it always has.
 */
export function shieldLow(downHearts: number): string {
    return `effect give @a[tag=pe_arena,scores={${HP}=..${downHearts * 2}}] minecraft:resistance 2 4 true`;
}

/** The game rule that keeps inventories through a death, under each name it has had. */
export const KEEP_INVENTORY = ["keepInventory", "keep_inventory"] as const;

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

export const FLOOR_BLOCKS = [
    "minecraft:red_stained_glass",
    "minecraft:white_stained_glass",
    "minecraft:blue_stained_glass"
] as const;

/** Every kind of block the arena is built of. */
export const DUEL_BLOCKS = ["minecraft:barrier", ...FLOOR_BLOCKS];

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
    return [
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

/** The same for everybody: a sword and a shield. */
export function duelKit(kit: EventOptions<"team-duel">["kit"]): string[] {
    return [SWORDS[kit], "minecraft:shield"];
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

/** Out of the fight: back to their side, healed, and shielded - unable to be
 *  hurt, or to hurt anybody - for a few seconds. */
export function sendBack(name: string, spot: Spot): string[] {
    return [
        `execute in minecraft:overworld run tp ${name} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} ${spot.yaw} 0`,
        `effect give ${name} minecraft:instant_health 1 1 true`,
        `effect give ${name} minecraft:regeneration ${SHIELD_SECONDS} 1 true`,
        `effect give ${name} minecraft:resistance ${SHIELD_SECONDS} 4 true`,
        `effect give ${name} minecraft:weakness ${SHIELD_SECONDS} 4 true`
    ];
}

/** How long after a blow its striker is still credited with bringing somebody down. */
export const CREDIT_MS = 6_000;

/**
 * Who brought a player down: a rival the game counts a player kill for since
 * the last look, or else the rival who struck last, within a few seconds.
 */
export function creditFor(
    rivals: readonly string[],
    killsSince: ReadonlyMap<string, number>,
    lastHit: ReadonlyMap<string, number>,
    now: number
): string | null {
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
