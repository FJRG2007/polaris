/**
 * A rare catch: a fishing race for one treasure, won by the first player who
 * reels it in. The treasure stays with whoever caught it; nothing is taken.
 *
 * How a catch is told from outside the game: the game's own statistics say how
 * many of the treasure a player has picked up since it began, less what they
 * dropped (so throwing one of their own down and picking it up again is not a
 * catch), and how many times they used a fishing rod. A catch is one more of
 * the treasure picked up within a few looks of reeling a line in - the item
 * flies to the player a moment after the rod is pulled.
 *
 * `fish_caught` is no use here: the game counts only fish in it, never the
 * treasures. Everything is kept on the server's scoreboard, under `pe_`, so a
 * Polaris restart finds it where it was.
 */

import { RARE_CATCHES, type EventOptions, type RareCatch } from "../catalog";

const ROD = "pe_rod";
const ROD_BEFORE = "pe_rodp";
const ROD_NOW = "pe_rdf";
/** How many more looks a pull of the rod still counts for. */
const RECENT = "pe_rfr";
const COUNT = "pe_rcnt";
const COUNT_BEFORE = "pe_rprev";
const COUNT_NOW = "pe_rdc";
/** How many looks after reeling in a treasure landing counts as caught. */
export const RECENT_LOOKS = 3;

/** The treasures that count for this one. */
export function catches(options: EventOptions<"rare-catch">): readonly RareCatch[] {
    return options.treasure === "any" ? RARE_CATCHES : [options.treasure];
}

function counted(options: EventOptions<"rare-catch">): { picked: string; dropped: string; id: string }[] {
    return catches(options).map((id) => {
        const index = RARE_CATCHES.indexOf(id);
        return { picked: `pe_rp${index}`, dropped: `pe_rd${index}`, id };
    });
}

/** The objectives it looks with. The statistics count from this moment on. */
export function catchSetup(options: EventOptions<"rare-catch">): string[] {
    const lines: string[] = [];
    const add = (objective: string, criterion: string) =>
        lines.push(
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} ${criterion}`
        );
    for (const one of counted(options)) {
        add(one.picked, `minecraft.picked_up:minecraft.${one.id}`);
        add(one.dropped, `minecraft.dropped:minecraft.${one.id}`);
    }
    add(ROD, "minecraft.used:minecraft.fishing_rod");
    for (const objective of [ROD_BEFORE, ROD_NOW, RECENT, COUNT, COUNT_BEFORE, COUNT_NOW])
        add(objective, "dummy");
    return lines;
}

/**
 * One look: how many of the treasure each player has landed since the last
 * look, and whether they reeled a line in lately. Read with `READ_CATCHERS`,
 * then `catchCommit` makes this look the one the next is measured from.
 */
export function catchLook(options: EventOptions<"rare-catch">): string[] {
    const lines: string[] = [];
    for (const one of counted(options)) {
        lines.push(`scoreboard players add @a ${one.picked} 0`, `scoreboard players add @a ${one.dropped} 0`);
    }
    for (const objective of [ROD, ROD_BEFORE, RECENT, COUNT_BEFORE])
        lines.push(`scoreboard players add @a ${objective} 0`);
    lines.push(`scoreboard players set @a ${COUNT} 0`);
    for (const one of counted(options)) {
        lines.push(
            `execute as @a run scoreboard players operation @s ${COUNT} += @s ${one.picked}`,
            `execute as @a run scoreboard players operation @s ${COUNT} -= @s ${one.dropped}`
        );
    }
    lines.push(
        `execute as @a run scoreboard players operation @s ${ROD_NOW} = @s ${ROD}`,
        `execute as @a run scoreboard players operation @s ${ROD_NOW} -= @s ${ROD_BEFORE}`,
        `scoreboard players remove @a[scores={${RECENT}=1..}] ${RECENT} 1`,
        `scoreboard players set @a[scores={${ROD_NOW}=1..}] ${RECENT} ${RECENT_LOOKS}`,
        `execute as @a run scoreboard players operation @s ${COUNT_NOW} = @s ${COUNT}`,
        `execute as @a run scoreboard players operation @s ${COUNT_NOW} -= @s ${COUNT_BEFORE}`
    );
    return lines;
}

/** Whoever landed the treasure off a line this look. */
export const READ_CATCHERS = `execute as @a[scores={${COUNT_NOW}=1..,${RECENT}=1..}] run data get entity @s Pos`;

export function catchCommit(): string[] {
    return [
        `execute as @a run scoreboard players operation @s ${COUNT_BEFORE} = @s ${COUNT}`,
        `execute as @a run scoreboard players operation @s ${ROD_BEFORE} = @s ${ROD}`
    ];
}

/** Every objective any rare catch makes, taken back out. */
export function catchCleanup(): string[] {
    const every = [
        ...RARE_CATCHES.flatMap((_, index) => [`pe_rp${index}`, `pe_rd${index}`]),
        ROD,
        ROD_BEFORE,
        ROD_NOW,
        RECENT,
        COUNT,
        COUNT_BEFORE,
        COUNT_NOW
    ];
    return every.map((objective) => `scoreboard objectives remove ${objective}`);
}
