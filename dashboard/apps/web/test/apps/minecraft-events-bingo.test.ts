import { describe, expect, it } from "vitest";
import * as speech from "@polaris-app/game-servers/src/lib/minecraft/speech";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as bingo from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/bingo";
import { atLeast } from "@polaris-app/game-servers/src/lib/minecraft/events/events-service";
import * as say from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/bingo-messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const every = () => true;
const none = () => false;
const on = (version: string) => (since: readonly number[]) => atLeast(version, since);

/** The pool an item is in. */
function poolOf(id: string): (typeof DIFFICULTIES)[number] {
    return DIFFICULTIES.find((one) => bingo.POOLS[one].some((item) => item.id === id))!;
}

describe("a bingo card", () => {
    it("is the same card for the same run, and another for another", () => {
        expect(bingo.drawCard("run-1", "medium", every)).toEqual(
            bingo.drawCard("run-1", "medium", every)
        );
        const cards = new Set(
            Array.from({ length: 50 }, (_, index) =>
                bingo.drawCard(`run-${index}`, "medium", every).join(",")
            )
        );
        expect(cards.size).toBe(50);
    });

    it("never repeats an item, and holds what its difficulty asks, over thousands of runs", () => {
        for (const difficulty of DIFFICULTIES) {
            const makeup = bingo.MAKEUP[difficulty];
            for (let seed = 0; seed < 3000; seed += 1) {
                const card = bingo.drawCard(`seed-${seed}`, difficulty, every);
                expect(card).toHaveLength(9);
                expect(new Set(card).size).toBe(9);
                for (const pool of DIFFICULTIES)
                    expect(card.filter((id) => poolOf(id) === pool)).toHaveLength(makeup[pool]);
                if (difficulty === "hard") {
                    const nether = card.filter((id) => bingo.itemOf(id).nether);
                    expect(nether.length).toBeGreaterThanOrEqual(bingo.NETHER_LEAST);
                }
            }
        }
    });

    it("asks for nothing the server's version does not have, and fills on the oldest", () => {
        for (const version of ["1.13.2", "1.16.5", "1.19.4", "1.21.1", "1.21.4"]) {
            for (const difficulty of DIFFICULTIES) {
                for (let seed = 0; seed < 1000; seed += 1) {
                    const card = bingo.drawCard(`seed-${seed}`, difficulty, on(version));
                    expect(card).toHaveLength(9);
                    for (const id of card) {
                        const since = bingo.itemOf(id).since;
                        if (since) expect(atLeast(version, since)).toBe(true);
                    }
                }
            }
        }
        // A version nobody could read: only what every version has.
        for (let seed = 0; seed < 500; seed += 1) {
            const card = bingo.drawCard(`seed-${seed}`, "hard", none);
            expect(card).toHaveLength(9);
            for (const id of card) expect(bingo.itemOf(id).since).toBeUndefined();
        }
        // The versions given are the ones that added each item.
        expect(bingo.itemOf("bundle").since).toEqual([1, 21, 2]);
        expect(bingo.itemOf("crafter").since).toEqual([1, 21]);
        expect(bingo.itemOf("copper_ingot").since).toEqual([1, 17]);
        expect(bingo.itemOf("crimson_fungus").since).toEqual([1, 16]);
        expect(bingo.itemOf("composter").since).toEqual([1, 14]);
    });

    it("never asks for what no statistic sees come in, like a bucket filled in the hand", () => {
        const all = Object.values(bingo.POOLS).flat();
        expect(all.some((one) => /_bucket$/.test(one.id))).toBe(false);
        expect(new Set(all.map((one) => one.id)).size).toBe(all.length);
    });

    it("is won by any full row, column or diagonal, or only by the whole card", () => {
        const mask = (cells: number[]) => cells.reduce((sum, cell) => sum | (1 << cell), 0);
        for (const line of bingo.LINES) {
            expect(bingo.completes(mask([...line]), "line")).toBe(true);
            expect(bingo.completes(mask([...line]), "card")).toBe(false);
        }
        expect(bingo.LINES).toHaveLength(8);
        expect(bingo.completes(mask([0, 1, 3, 5, 7]), "line")).toBe(false);
        expect(bingo.completes(mask([0, 1, 2, 3, 4, 5, 6, 7, 8]), "card")).toBe(true);
        expect(bingo.completes(mask([0, 1, 2, 3, 4, 5, 6, 7]), "card")).toBe(false);
        expect(bingo.countOf(mask([0, 4, 8]))).toBe(3);
        expect(bingo.newCells(mask([0]), mask([0, 2, 5]))).toEqual([2, 5]);
        // Two in one look: the most marked, then the name.
        expect(
            bingo.firstToComplete([
                { name: "Zed", mask: mask([0, 1, 2, 4]) },
                { name: "Ana", mask: mask([3, 4, 5]) }
            ])
        ).toBe("Zed");
        expect(
            bingo.firstToComplete([
                { name: "Zed", mask: mask([3, 4, 5]) },
                { name: "Ana", mask: mask([0, 1, 2]) }
            ])
        ).toBe("Ana");
    });
});

describe("a bingo podium", () => {
    const scores = new Map([
        ["Ana", 5],
        ["Ben", 3],
        ["Cid", 5],
        ["Dee", 1]
    ]);

    it("puts whoever completed it first on top, whatever the least to be ranked", () => {
        expect(bingo.podiumOf(scores, new Set(), 4, "Ben", { Ana: 30, Cid: 10 })).toEqual([
            { place: 1, name: "Ben", score: 3 },
            { place: 2, name: "Cid", score: 5 },
            { place: 3, name: "Ana", score: 5 }
        ]);
    });

    it("ranks by items marked with a tie to who got there first, when nobody completed it", () => {
        expect(bingo.podiumOf(scores, new Set(), 3, null, { Ana: 30, Cid: 10 })).toEqual([
            { place: 1, name: "Cid", score: 5 },
            { place: 2, name: "Ana", score: 5 },
            { place: 3, name: "Ben", score: 3 }
        ]);
    });

    it("never puts somebody disqualified on it, even the one who completed it", () => {
        expect(bingo.podiumOf(scores, new Set(["ben", "cid"]), 3, "Ben", {})).toEqual([
            { place: 1, name: "Ana", score: 5 }
        ]);
    });
});

describe("what a bingo rush sends", () => {
    const card = bingo.drawCard("run-1", "hard", every);

    it("counts every item from now, and looks at every player in one batch", () => {
        const setup = bingo.bingoSetup(card);
        expect(setup).toContain(
            `scoreboard objectives add pe_bgp0 minecraft.picked_up:minecraft.${card[0]}`
        );
        expect(setup).toContain(
            `scoreboard objectives add pe_bgc8 minecraft.crafted:minecraft.${card[8]}`
        );
        const tick = bingo.bingoTick(card);
        // Held, read without taking anything.
        expect(tick).toContain(
            `execute as @a[scores={pe_bgn=1..}] unless score @s pe_bgm4 matches 1 store result score @s pe_bgt run clear @s minecraft:${card[4]} 0`
        );
        expect(tick).toContain(
            "execute as @a[scores={pe_bgm8=1}] run scoreboard players add @s pe_bgk 256"
        );
        expect(tick.some((line) => / clear @s \S+ [1-9]/.test(line))).toBe(false);
        expect(bingo.READ_MARKS).toBe("execute as @a run scoreboard players get @s pe_bgk");
        const removed = bingo.bingoCleanup();
        for (const line of setup.filter((one) => one.startsWith("scoreboard objectives add ")))
            expect(removed).toContain(
                line.replace("add", "remove").split(" ").slice(0, 4).join(" ")
            );
    });

    it("shows the card with each item named by the game, ticked where it is marked", () => {
        const rows = bingo.cardLines("Ana", card, 0b000010001);
        expect(rows).toHaveLength(3);
        const parsed = rows.map((row) => JSON.parse(row.slice("tellraw Ana ".length)) as object[]);
        const keys = parsed.flatMap((row) =>
            row.flatMap((part) =>
                "translate" in part ? [(part as { translate: string }).translate] : []
            )
        );
        expect(keys).toEqual(card.map(bingo.nameKey));
        expect(JSON.stringify(parsed[0])).toContain('"color":"green"');
        expect(bingo.nameKey("crafting_table")).toBe("block.minecraft.crafting_table");
        expect(bingo.nameKey("blaze_rod")).toBe("item.minecraft.blaze_rod");
        for (const row of bingo.cardLines("@a", card, 511))
            expect(commandBytes(commands.namespaced(row))).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });

    it("puts each player's own count and what is left on their action bar, in their language", () => {
        const bar = bingo.progressBar("Ana", card, 0b11, say.missing);
        const en = speech.localize(bar, speech.audienceOf("en"))[0]!;
        const es = speech.localize(
            bar,
            speech.audienceOf("en", new Map([["ana", "es" as const]]))
        )[0]!;
        expect(en).toContain('"text":"2/9"');
        expect(en).toContain("Missing:");
        expect(es).toContain("Faltan:");
        expect(en.startsWith("title Ana actionbar ")).toBe(true);
        expect(commandBytes(es)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        expect(bingo.markedLine("Ana", card[0]!, 4)).toContain(" 4/9");
    });

    it("says everything in both languages within a command", () => {
        const spoken = speech.spoken(say);
        const lines = [
            commands.say(spoken.cardHeader(true, speech.EVERY)),
            commands.say(spoken.cardHeader(false, speech.EVERY)),
            commands.say(spoken.wonLine("Abcdefghijklmnop", true, speech.EVERY)),
            commands.say(spoken.timeUpLine(false, speech.EVERY)),
            ...commands.titleCommands(
                spoken.winTitle("Abcdefghijklmnop", speech.EVERY),
                spoken.winSubtitle(true, speech.EVERY)
            )
        ];
        for (const line of lines)
            for (const language of speech.LANGUAGES)
                expect(
                    commandBytes(
                        commands.namespaced(speech.localize(line, speech.audienceOf(language))[0]!)
                    )
                ).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        expect(say.cardHeader(true, "es")).toContain("línea");
    });
});
