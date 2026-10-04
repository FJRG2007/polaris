/**
 * A bingo rush: one card of nine items (three by three), the same for
 * everybody, drawn from the run's id. An item is marked the first time it is
 * seen in a player's inventory and stays marked; a full line or the full card,
 * whichever the event is set to, wins and ends it.
 *
 * The card is drawn from pools by how hard each item is to come by
 * (`POOLS`): easy ones turn up in the first minutes, medium ones take a cave
 * or a farm, hard ones a trip to the Nether. Every item carries the version
 * that added it, so a card never asks for something the server does not have;
 * an unknown version gets only what every version has.
 *
 * How an item is read, as a gathering reads one (`kinds/gathering`): `clear
 * <player> <item> 0`, which takes nothing and answers how many there are. It
 * counts only once the game's own statistics say the player came by one since
 * the start - picked up (less what they dropped) or made, smelted or traded
 * for - so a stack carried in, or taken out of their own chest, marks nothing.
 * Everything is worked out in the game, every player in one batch a look, and
 * kept on the scoreboard under `pe_bg`: a Polaris restart finds the marks where
 * they were.
 *
 * Pure: the service (`events-service`) sends these lines and reads the marks.
 */

import { z } from "zod";
import { podium } from "../plan";
import type { Placed } from "../plan";
import * as speech from "../../speech";
import { asciiJson } from "../commands";
import type { EventOptions } from "../catalog";
import { seeded, shuffled } from "../trivia-bank";

export type BingoDifficulty = EventOptions<"bingo">["difficulty"];
export type BingoGoal = EventOptions<"bingo">["goal"];

/** One item that can be on a card. */
export interface BingoItem {
    /** Its id, without `minecraft:`. */
    readonly id: string;
    /** Named by the game in each player's own language: blocks and items have
     *  their names under different keys. */
    readonly block?: boolean;
    /** The version that added it; absent for anything every version has. */
    readonly since?: readonly number[];
    /** Only found in the Nether, or made of what is. */
    readonly nether?: boolean;
}

/**
 * The items a card is drawn from, by how hard they are to come by. Never one
 * the game gives by filling something in a hand (a milk or water bucket),
 * which no statistic counts and so could never be marked.
 */
export const POOLS: Readonly<Record<BingoDifficulty, readonly BingoItem[]>> = {
    easy: [
        { id: "crafting_table", block: true },
        { id: "stick" },
        { id: "torch", block: true },
        { id: "furnace", block: true },
        { id: "chest", block: true },
        { id: "ladder", block: true },
        { id: "stone_pickaxe" },
        { id: "stone_sword" },
        { id: "stone_axe" },
        { id: "stone_shovel" },
        { id: "wooden_hoe" },
        { id: "bowl" },
        { id: "lever", block: true },
        { id: "cobblestone_slab", block: true },
        { id: "cobblestone_wall", block: true },
        { id: "flint" },
        { id: "wheat_seeds" },
        { id: "charcoal" },
        { id: "coal" },
        { id: "white_wool", block: true },
        { id: "composter", block: true, since: [1, 14] },
        { id: "barrel", block: true, since: [1, 14] },
        { id: "campfire", block: true, since: [1, 14] },
        { id: "smoker", block: true, since: [1, 14] },
        { id: "grindstone", block: true, since: [1, 14] }
    ],
    medium: [
        { id: "iron_ingot" },
        { id: "iron_pickaxe" },
        { id: "bucket" },
        { id: "shears" },
        { id: "shield" },
        { id: "bread" },
        { id: "redstone" },
        { id: "lapis_lazuli" },
        { id: "gold_ingot" },
        { id: "compass" },
        { id: "clock" },
        { id: "paper" },
        { id: "book" },
        { id: "bow" },
        { id: "arrow" },
        { id: "leather" },
        { id: "feather" },
        { id: "item_frame" },
        { id: "painting" },
        { id: "rail", block: true },
        { id: "minecart" },
        { id: "cauldron", block: true },
        { id: "hopper", block: true },
        { id: "fishing_rod" },
        { id: "flint_and_steel" },
        { id: "pumpkin_pie" },
        { id: "mushroom_stew" },
        { id: "lantern", block: true, since: [1, 14] },
        { id: "crossbow", since: [1, 14] },
        { id: "stonecutter", block: true, since: [1, 14] },
        { id: "raw_copper", since: [1, 17] },
        { id: "copper_ingot", since: [1, 17] },
        { id: "lightning_rod", block: true, since: [1, 17] },
        { id: "spyglass", since: [1, 17] },
        { id: "brush", since: [1, 20] },
        { id: "decorated_pot", block: true, since: [1, 20] },
        { id: "crafter", block: true, since: [1, 21] },
        { id: "bundle", since: [1, 21, 2] }
    ],
    hard: [
        { id: "blaze_rod", nether: true },
        { id: "nether_wart", nether: true },
        { id: "quartz", nether: true },
        { id: "glowstone_dust", nether: true },
        { id: "magma_cream", nether: true },
        { id: "ghast_tear", nether: true },
        { id: "soul_sand", block: true, nether: true },
        { id: "nether_brick", nether: true },
        { id: "brewing_stand", block: true, nether: true },
        { id: "obsidian", block: true },
        { id: "diamond" },
        { id: "ender_pearl" },
        { id: "golden_apple" },
        { id: "crimson_fungus", block: true, nether: true, since: [1, 16] },
        { id: "warped_fungus", block: true, nether: true, since: [1, 16] },
        { id: "blackstone", block: true, nether: true, since: [1, 16] },
        { id: "basalt", block: true, nether: true, since: [1, 16] },
        { id: "crying_obsidian", block: true, since: [1, 16] },
        { id: "soul_torch", block: true, nether: true, since: [1, 16] }
    ]
};

/** How many of each pool a card of each difficulty holds; nine in all. */
export const MAKEUP: Readonly<Record<BingoDifficulty, Readonly<Record<BingoDifficulty, number>>>> =
    {
        easy: { easy: 9, medium: 0, hard: 0 },
        medium: { easy: 4, medium: 5, hard: 0 },
        hard: { easy: 2, medium: 3, hard: 4 }
    };

/** Of a hard card's hard items, how many at the least only the Nether has: a
 *  hard card is a trip there, never only a deep cave. */
export const NETHER_LEAST = 2;

/** The rows, columns and diagonals of a three by three card, by cell. */
export const LINES: readonly (readonly number[])[] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
];

export const CELLS = 9;
export const FULL = (1 << CELLS) - 1;

/** Every item there is, by id, whatever pool it is in. */
const BY_ID = new Map(Object.values(POOLS).flatMap((pool) => pool.map((one) => [one.id, one])));

export function itemOf(id: string): BingoItem {
    return BY_ID.get(id) ?? { id };
}

/**
 * The card for a run: nine different items, as many from each pool as its
 * difficulty asks (`MAKEUP`), each one a version that `has` reads, in cells
 * drawn from the run's id - the same card after any restart.
 */
export function drawCard(
    runId: string,
    difficulty: BingoDifficulty,
    has: (since: readonly number[]) => boolean
): string[] {
    const random = seeded(`${runId}:bingo`);
    const known = (one: BingoItem) => !one.since || has(one.since);
    const picked: string[] = [];
    const take = (from: readonly BingoItem[], count: number) => {
        const fresh = shuffled(
            from.filter((one) => known(one) && !picked.includes(one.id)),
            random
        );
        picked.push(...fresh.slice(0, count).map((one) => one.id));
    };
    const makeup = MAKEUP[difficulty];
    // The Nether's share of a hard card first, then the rest of it from anywhere.
    const hard = POOLS.hard;
    take(
        hard.filter((one) => one.nether),
        Math.min(makeup.hard, makeup.hard > 0 ? NETHER_LEAST : 0)
    );
    take(hard, makeup.hard - picked.length);
    take(POOLS.medium, makeup.medium);
    take(POOLS.easy, makeup.easy);
    return shuffled(picked, random);
}

/** A run's card, and how it stands. */
export const bingoSchema = z.object({
    /** The nine item ids, row by row. */
    card: z.array(z.string()).length(CELLS),
    /** What each player has marked, as a mask of cells. */
    marked: z.record(z.number().int()).default({}),
    /** When each reached what they have now, in ms from the start: who got
     *  there first breaks a tie. */
    at: z.record(z.number()).default({}),
    /** Who completed the line or the card the event was set to. */
    winner: z.string().nullable().default(null)
});
export type BingoState = z.infer<typeof bingoSchema>;

// ------------------------------------------------------------------ the marks

/** How many cells a mask has marked. */
export function countOf(mask: number): number {
    let count = 0;
    for (let cell = 0; cell < CELLS; cell += 1) if (mask & (1 << cell)) count += 1;
    return count;
}

/** Whether a mask holds what wins: any full line, or the whole card. */
export function completes(mask: number, goal: BingoGoal): boolean {
    if (goal === "card") return (mask & FULL) === FULL;
    return LINES.some((line) => line.every((cell) => mask & (1 << cell)));
}

/** The cells a mask has that the one before it did not, in order. */
export function newCells(before: number, now: number): number[] {
    const fresh: number[] = [];
    for (let cell = 0; cell < CELLS; cell += 1)
        if (now & (1 << cell) && !(before & (1 << cell))) fresh.push(cell);
    return fresh;
}

/**
 * Who of those who just completed it wins: the most marked, then the name, so
 * two who complete it in the same look are settled the same way every time.
 */
export function firstToComplete(done: readonly { name: string; mask: number }[]): string | null {
    const ranked = [...done].sort(
        (left, right) =>
            countOf(right.mask) - countOf(left.mask) || left.name.localeCompare(right.name)
    );
    return ranked[0]?.name ?? null;
}

/**
 * The podium: whoever completed the line or the card first, whatever the least
 * to be ranked; then everybody else by items marked, a tie to whoever got
 * there first (`plan.podium`).
 */
export function podiumOf(
    scores: ReadonlyMap<string, number>,
    disqualified: ReadonlySet<string>,
    minScore: number,
    winner: string | null,
    at: Readonly<Record<string, number>>
): Placed[] {
    const first =
        winner && !disqualified.has(winner.toLowerCase())
            ? [...scores].find(([name]) => name.toLowerCase() === winner.toLowerCase())
            : undefined;
    if (!first) return podium(scores, disqualified, minScore, at);
    const rest = new Map([...scores].filter(([name]) => name !== first[0]));
    return [
        { place: 1, name: first[0], score: first[1] },
        ...podium(rest, disqualified, minScore, at)
            .map((one) => ({ ...one, place: one.place + 1 }))
            .filter((one) => one.place <= 3)
    ];
}

// ------------------------------------------------------------------ the commands

const PICKED = (cell: number) => `pe_bgp${cell}`;
const DROPPED = (cell: number) => `pe_bgd${cell}`;
const MADE = (cell: number) => `pe_bgc${cell}`;
/** A cell marked (1) or not (unset or 0), per player. */
const MARK = (cell: number) => `pe_bgm${cell}`;
/** What a player came by of a cell's item since the start. */
const CAME_BY = "pe_bgn";
const TMP = "pe_bgt";
/** Every cell marked, as one number: what is read. */
export const MASK = "pe_bgk";

/** The objectives a card counts with. The statistics count from now on. */
export function bingoSetup(card: readonly string[]): string[] {
    const lines: string[] = [];
    const add = (objective: string, criterion: string) =>
        lines.push(
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} ${criterion}`
        );
    card.forEach((id, cell) => {
        add(PICKED(cell), `minecraft.picked_up:minecraft.${id}`);
        add(DROPPED(cell), `minecraft.dropped:minecraft.${id}`);
        add(MADE(cell), `minecraft.crafted:minecraft.${id}`);
        add(MARK(cell), "dummy");
    });
    for (const objective of [CAME_BY, TMP, MASK]) add(objective, "dummy");
    return lines;
}

/**
 * One look, every player at once: each cell not yet marked is marked for
 * whoever came by its item since the start and holds one now. Then every
 * player's marks as one number, for `READ_MARKS`.
 */
export function bingoTick(card: readonly string[]): string[] {
    const lines: string[] = [];
    card.forEach((id, cell) => {
        const open = `execute as @a unless score @s ${MARK(cell)} matches 1`;
        // A statistic not counted yet reads as nothing: `store result` writes
        // a zero when the read fails.
        lines.push(
            `${open} store result score @s ${CAME_BY} run scoreboard players get @s ${PICKED(cell)}`,
            `${open} store result score @s ${TMP} run scoreboard players get @s ${DROPPED(cell)}`,
            `${open} run scoreboard players operation @s ${CAME_BY} -= @s ${TMP}`,
            `${open} store result score @s ${TMP} run scoreboard players get @s ${MADE(cell)}`,
            `${open} run scoreboard players operation @s ${CAME_BY} += @s ${TMP}`,
            `execute as @a[scores={${CAME_BY}=1..}] unless score @s ${MARK(cell)} matches 1 store result score @s ${TMP} run clear @s minecraft:${id} 0`,
            `execute as @a[scores={${CAME_BY}=1..,${TMP}=1..}] run scoreboard players set @s ${MARK(cell)} 1`,
            `scoreboard players set @a ${CAME_BY} 0`
        );
    });
    lines.push(`scoreboard players set @a ${MASK} 0`);
    card.forEach((_, cell) =>
        lines.push(
            `execute as @a[scores={${MARK(cell)}=1}] run scoreboard players add @s ${MASK} ${1 << cell}`
        )
    );
    return lines;
}

/** Everybody's marks: `Ana has 37 [pe_bgk]`. */
export const READ_MARKS = `execute as @a run scoreboard players get @s ${MASK}`;

/** Every objective a card can have made, taken back out. */
export function bingoCleanup(): string[] {
    const every: string[] = [];
    for (let cell = 0; cell < CELLS; cell += 1)
        every.push(PICKED(cell), DROPPED(cell), MADE(cell), MARK(cell));
    every.push(CAME_BY, TMP, MASK);
    return every.map((objective) => `scoreboard objectives remove ${objective}`);
}

// ------------------------------------------------------------------ what players read

/** An item's name as the game writes it in each player's own language. */
export function nameKey(id: string): string {
    return `${itemOf(id).block ? "block" : "item"}.minecraft.${id}`;
}

type Part = Readonly<Record<string, unknown>>;

const MARKED = "✔";
const OPEN = "□";

/** One cell: marked in green with a tick, or grey with an empty box. */
function cellParts(id: string, marked: boolean): Part[] {
    return marked
        ? [
              { text: `${MARKED} `, color: "green" },
              { translate: nameKey(id), color: "green" }
          ]
        : [
              { text: `${OPEN} `, color: "dark_gray" },
              { translate: nameKey(id), color: "gray" }
          ];
}

function json(parts: readonly Part[]): string {
    return asciiJson(JSON.stringify([{ text: "" }, ...parts]));
}

/**
 * The card as three lines of chat to `who` (a name, or `@a`), each item named
 * by the game itself in the reader's own language, and ticked where `mask` has
 * it.
 */
export function cardLines(who: string, card: readonly string[], mask = 0): string[] {
    return [0, 1, 2].map((row) => {
        const parts: Part[] = [{ text: "  " }];
        for (let column = 0; column < 3; column += 1) {
            const cell = row * 3 + column;
            if (column > 0) parts.push({ text: "   ", color: "dark_gray" });
            parts.push(...cellParts(card[cell] ?? "air", (mask & (1 << cell)) !== 0));
        }
        return `tellraw ${who} ${json(parts)}`;
    });
}

/** What a player just marked, said to them: the item, and how many they have. */
export function markedLine(name: string, id: string, count: number): string {
    return `tellraw ${name} ${json([
        { text: `${MARKED} `, color: "green", bold: true },
        { translate: nameKey(id), color: "green" },
        { text: ` ${count}/${CELLS}`, color: "yellow" }
    ])}`;
}

/** How many of the card a player has, and the first few still missing, on
 *  their action bar; `missing` is the word for them, in each language. */
export function progressBar(
    name: string,
    card: readonly string[],
    mask: number,
    missing: (language: speech.Language) => string
): string {
    const left = card.filter((_, cell) => !(mask & (1 << cell)));
    const each = Object.fromEntries(
        speech.LANGUAGES.map((language) => {
            const parts: Part[] = [
                { text: "Bingo ", color: "gold", bold: true },
                { text: `${countOf(mask)}/${CELLS}`, color: "yellow" }
            ];
            if (left.length > 0) {
                parts.push({ text: `  ${missing(language)} `, color: "gray" });
                left.slice(0, 3).forEach((id, index) => {
                    if (index > 0) parts.push({ text: ", ", color: "dark_gray" });
                    parts.push({ translate: nameKey(id), color: "white" });
                });
                if (left.length > 3) parts.push({ text: ", ...", color: "dark_gray" });
            }
            return [language, json(parts)];
        })
    ) as Record<speech.Language, string>;
    return `title ${name} actionbar ${speech.perLanguage(each)}`;
}

/** A small sound for a mark, a bigger one for the win. */
export function markSound(name: string): string {
    return `execute as ${name} at @s run playsound minecraft:entity.experience_orb.pickup master @s ~ ~ ~ 1 1.4`;
}
