/**
 * An experience boost: for as long as it lasts, every mob a player kills and
 * every ore block they mine gives experience on top of the game's own.
 *
 * The game's statistics count the kills and the ores; a running "paid" count per
 * player says how much of that has been rewarded already, so each one is paid
 * exactly once - on the next tick, after a restart, or in the last lines of the
 * cleanup - and nothing is ever taken away. An ore block placed during it is
 * taken off the ores mined, as a mining rush does: with silk touch the same block
 * could be put down and mined again for ever.
 *
 * `xp add` takes a fixed amount, so what is owed is paid in powers of two:
 * whoever is owed 32 or more gets 32 at once, then 16, and so on down to one.
 */

import { ORES } from "../commands";
import type { EventOptions } from "../catalog";

const KILLS = "pe_xk";
const KILLS_PAID = "pe_xkp";
const ORES_MINED = "pe_xo";
const ORES_PAID = "pe_xop";
const OWED = "pe_xd";

const mined = (index: number) => `pe_xm${index}`;
const placed = (index: number) => `pe_xu${index}`;

/** The most paid out of one count in one tick; the rest waits for the next. */
const STEPS = [32, 16, 8, 4, 2, 1] as const;

export function boostSetup(options: EventOptions<"xp-boost">): string[] {
    const lines: string[] = [];
    const add = (objective: string, criterion: string) =>
        lines.push(
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} ${criterion}`
        );
    if (options.perKill > 0) {
        add(KILLS, "minecraft.custom:minecraft.mob_kills");
        add(KILLS_PAID, "dummy");
    }
    if (options.perOre > 0) {
        ORES.forEach(([id], index) => {
            add(mined(index), `minecraft.mined:minecraft.${id}`);
            add(placed(index), `minecraft.used:minecraft.${id}`);
        });
        add(ORES_MINED, "dummy");
        add(ORES_PAID, "dummy");
    }
    add(OWED, "dummy");
    return lines;
}

/** What each player is owed of one count, paid out, and written down as paid. */
function payout(count: string, paid: string, bonus: number): string[] {
    const lines = [
        `scoreboard players add @a ${count} 0`,
        `scoreboard players add @a ${paid} 0`,
        `execute as @a run scoreboard players operation @s ${OWED} = @s ${count}`,
        `execute as @a run scoreboard players operation @s ${OWED} -= @s ${paid}`
    ];
    for (const step of STEPS) {
        const owed = `@a[scores={${OWED}=${step}..}]`;
        lines.push(
            `execute as ${owed} run xp add @s ${step * bonus} points`,
            `scoreboard players add ${owed} ${paid} ${step}`,
            `scoreboard players remove ${owed} ${OWED} ${step}`
        );
    }
    return lines;
}

/** Everything killed and mined since the last tick, rewarded. */
export function boostTick(options: EventOptions<"xp-boost">): string[] {
    const lines: string[] = [];
    if (options.perKill > 0) lines.push(...payout(KILLS, KILLS_PAID, options.perKill));
    if (options.perOre > 0) {
        lines.push(`scoreboard players set @a ${ORES_MINED} 0`);
        ORES.forEach((_, index) => {
            lines.push(
                `scoreboard players add @a ${mined(index)} 0`,
                `scoreboard players add @a ${placed(index)} 0`,
                `execute as @a run scoreboard players operation @s ${ORES_MINED} += @s ${mined(index)}`,
                `execute as @a run scoreboard players operation @s ${ORES_MINED} -= @s ${placed(index)}`
            );
        });
        lines.push(...payout(ORES_MINED, ORES_PAID, options.perOre));
    }
    return lines;
}

/**
 * The end: whatever is still owed paid first, then every objective it made
 * taken back out. Each line fails harmlessly when there is nothing to do.
 */
export function boostCleanup(options: EventOptions<"xp-boost">): string[] {
    const every = [
        KILLS,
        KILLS_PAID,
        ORES_MINED,
        ORES_PAID,
        OWED,
        ...ORES.flatMap((_, index) => [mined(index), placed(index)])
    ];
    return [...boostTick(options), ...every.map((objective) => `scoreboard objectives remove ${objective}`)];
}
