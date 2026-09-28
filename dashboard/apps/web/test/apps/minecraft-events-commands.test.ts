/**
 * What a Minecraft event sends the server, and how the server's answers are
 * read - asserted line by line, since a wrong line is an event that silently
 * does nothing in the game.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as trivia from "@polaris-app/game-servers/src/lib/minecraft/events/trivia-bank";
import {
    atLeast,
    firstRight
} from "@polaris-app/game-servers/src/lib/minecraft/events/events-service";

const preset = <K extends catalog.EventKind>(
    kind: K,
    options: Partial<catalog.EventOptions<K>> = {}
): catalog.EventPreset => {
    const made = catalog.newPreset(kind, kind);
    return { ...made, options: { ...made.options, ...options } } as catalog.EventPreset;
};

describe("the scoreboard", () => {
    it("counts every ore by its worth for a mining rush", () => {
        const counted = commands.components(preset("mining-rush"));
        expect(
            counted.find(
                (one) => one.criterion === "minecraft.mined:minecraft.deepslate_diamond_ore"
            )?.weight
        ).toBe(8);
        expect(
            counted.find((one) => one.criterion === "minecraft.mined:minecraft.ancient_debris")
                ?.weight
        ).toBe(10);
        expect(new Set(counted.map((one) => one.objective)).size).toBe(counted.length);
        expect(counted.every((one) => one.objective.length <= 16)).toBe(true);
    });

    it("counts only diamonds, both kinds of ore, when asked", () => {
        const counted = commands.components(preset("mining-rush", { target: "diamond" }));
        expect(counted.map((one) => one.criterion)).toEqual([
            "minecraft.mined:minecraft.diamond_ore",
            "minecraft.mined:minecraft.deepslate_diamond_ore"
        ]);
    });

    it("gives every player a zero before adding up, and weights what is worth more", () => {
        const lines = commands.scoreTick(preset("mining-rush"));
        const first = lines.findIndex((line) =>
            line.startsWith("scoreboard players add @a pe_c0 0")
        );
        const firstSum = lines.findIndex((line) => line.includes("pe_sum += @s pe_tmp"));
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThan(firstSum);
        expect(lines).toContain(
            "execute as @a run scoreboard players operation @s pe_tmp *= #w8 pe_const"
        );
        expect(lines.at(-1)).toBe(
            "execute as @a[scores={pe_sum=1..}] run scoreboard players operation @s pe_score = @s pe_sum"
        );
    });

    it("sets up a constant for every weight the tick multiplies by", () => {
        const setup = commands.setupScoreboard(preset("mining-rush"), "&6Mining");
        for (const line of commands.scoreTick(preset("mining-rush"))) {
            const used = /#w(\d+)/.exec(line)?.[1];
            if (used) expect(setup).toContain(`scoreboard players set #w${used} pe_const ${used}`);
        }
    });

    it("shows distance in metres", () => {
        const lines = commands.scoreTick(preset("explorer", { mode: "distance" }));
        expect(lines).toContain(
            "execute as @a run scoreboard players operation @s pe_sum /= #w100 pe_const"
        );
    });

    it("puts no scoreboard up for a happy hour, a supply drop or a race", () => {
        expect(commands.hasScoreboard(preset("happy-hour"))).toBe(false);
        expect(commands.hasScoreboard(preset("supply-drop"))).toBe(false);
        expect(commands.hasScoreboard(preset("explorer", { mode: "race" }))).toBe(false);
        expect(commands.setupScoreboard(preset("happy-hour"), "x")).toEqual([]);
    });

    it("counts deaths on a blood moon, from when night falls", () => {
        const setup = commands.setupScoreboard(preset("blood-moon"), "x");
        expect(setup).toContain("scoreboard objectives add pe_death deathCount");
    });
});

describe("reading what the server says", () => {
    it("reads scores, and ignores somebody who has none", () => {
        const output =
            "Ana has 12 [pe_score]Ben has 3 [pe_score]\nCan't get value of pe_score for Cai; none is set";
        expect([...commands.readScores(output)]).toEqual([
            ["Ana", 12],
            ["Ben", 3]
        ]);
    });

    it("reads positions and facings", () => {
        expect(
            commands.readWhere("Ana has the following entity data: [1.5d, -58.0d, 30.25d]")
        ).toEqual([{ name: "Ana", x: 1.5, y: -58, z: 30.25 }]);
        expect(
            commands.readFacing("Ana has the following entity data: [-179.5f, 12.0f]").get("Ana")
        ).toEqual({ yaw: -179.5, pitch: 12 });
    });

    it("reads a marker's spot in whole blocks", () => {
        expect(
            commands.readPoint("Armor Stand has the following entity data: [100.5d, 71.0d, -20.7d]")
        ).toEqual({ x: 100, y: 71, z: -21 });
    });

    it("tells a surface found from one refused", () => {
        expect(
            commands.spreadWorked(
                "Spread 1 entity around 100.5, 30.5 with an average distance of 0 blocks apart"
            )
        ).toBe(true);
        expect(
            commands.spreadWorked(
                "Could not spread 1 entity around 100, 30 (too many entities for space - try using spread of at most 0.0)"
            )
        ).toBe(false);
    });

    it("knows a prize that reached somebody from one that did not", () => {
        expect(commands.gaveIt("Gave 5 [Diamond] to Ana")).toBe(true);
        expect(commands.gaveIt("No player was found")).toBe(false);
    });
});

describe("the text players read", () => {
    it("travels as plain ASCII, accents written as escapes", () => {
        const line = commands.say("&aLa hora feliz ha terminado. ¡Olé!");
        expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
        expect(line).toContain("\\u00a1");
    });

    it("never asks for a game variable by accident", () => {
        const every = [
            ...catalog.EVENT_KINDS.flatMap((kind) =>
                (["en", "es"] as const).map((language) => messages.rules(kind, language))
            ),
            messages.startsIn("X", 60, "es"),
            messages.dropArea(100, 200, 50, "en"),
            messages.bossAppeared("B", 1, 2, 3, "es"),
            messages.podiumLine(1, "Ana", "3 points", "en"),
            messages.roundWon("Ana", "creeper", "es")
        ];
        for (const line of every) expect(line).not.toMatch(/[{}]/);
    });

    it("says the clock the way a player reads it", () => {
        expect(messages.clock(61)).toBe("1:01");
        expect(messages.clock(3725)).toBe("1:02:05");
        expect(messages.clock(-5)).toBe("0:00");
    });
});

describe("each kind's commands", () => {
    it("spreads a wave onto the surface around each player in survival", () => {
        const lines = commands.wave({ intensity: "low", creepers: false }, 0);
        expect(lines.filter((line) => line.includes("summon"))).toHaveLength(2);
        expect(
            lines.some((line) =>
                line.includes("spreadplayers ~ ~ 4 16 false @e[tag=pe_new,distance=..1]")
            )
        ).toBe(true);
        expect(lines.at(-1)).toBe("tag @e[tag=pe_new] remove pe_new");
        expect(lines.join("\n")).not.toContain("creeper");
    });

    it("names a boss the way each version reads a name", () => {
        expect(commands.bossNameCommand("The Warlord", true)).toContain(
            '{CustomName:{text:"The Warlord",color:"red",bold:1b}}'
        );
        const legacy = commands.bossNameCommand("The Warlord", false);
        expect(legacy).toMatch(/\{CustomName:'\[.*The Warlord.*\]'\}/);
    });

    it("tries the attribute ids of both eras", () => {
        expect(commands.bossAttributes(400, true)[0]).toContain(
            "minecraft:max_health base set 400"
        );
        expect(commands.bossAttributes(400, false)[0]).toContain(
            "minecraft:generic.max_health base set 400"
        );
        expect(
            commands.attributeWorked(
                "Set base value of attribute Max Health for entity Warlord to 400.0"
            )
        ).toBe(true);
        expect(commands.attributeWorked("Unknown attribute: minecraft:max_health")).toBe(false);
    });

    it("keeps a chest's chunk loaded, and lets it go at the end", () => {
        const point = { x: 120, y: 70, z: -40 };
        const cleanup = commands.cleanup(preset("supply-drop"), point);
        expect(cleanup).toContain(commands.forceloadRemove(120, -40));
        expect(cleanup).toContain(commands.removeChest(point));
        expect(commands.placeChest(point, "treasure")).toContain(
            'minecraft:chest{LootTable:"minecraft:chests/buried_treasure"}'
        );
    });

    it("takes the chest away only while nobody has opened it", () => {
        expect(commands.removeChest({ x: 120, y: 70, z: -40 })).toBe(
            "execute in minecraft:overworld if block 120 70 -40 minecraft:chest if data block 120 70 -40 LootTable run setblock 120 70 -40 minecraft:air replace"
        );
    });

    it("lets go of the column being tried as well as the place, once per chunk", () => {
        const lines = commands.cleanup(preset("world-boss"), null, { x: 500, z: 500 });
        expect(lines).toContain(commands.forceloadRemove(500, 500));
        const same = commands.release({ x: 120, z: -40 }, { x: 121, z: -41 });
        expect(same).toHaveLength(1);
        expect(commands.release({ x: 120, z: -40 }, { x: 300, z: 0 })).toHaveLength(2);
    });

    it("takes a happy hour's effects off again", () => {
        const happy = preset("happy-hour");
        const cleared = commands
            .cleanup(happy, null)
            .filter((line) => line.startsWith("effect clear"));
        const given = commands
            .happyEffects(happy.options as catalog.EventOptions<"happy-hour">, 60)
            .map((line) => line.split(" ")[3]);
        expect(cleared.map((line) => line.split(" ")[3])).toEqual(given);
        expect(cleared.length).toBeGreaterThan(0);
    });

    it("takes every objective it made back out, and nothing else", () => {
        const made = commands.setupScoreboard(preset("mining-rush"), "x").flatMap((line) => {
            const match = /^scoreboard objectives add (\S+)/.exec(line);
            return match ? [match[1] as string] : [];
        });
        const removed = new Set(
            commands.cleanup(preset("mining-rush"), null).flatMap((line) => {
                const match = /^scoreboard objectives remove (\S+)/.exec(line);
                return match ? [match[1] as string] : [];
            })
        );
        for (const objective of made) expect(removed.has(objective)).toBe(true);
        for (const objective of removed) expect(objective.startsWith("pe_")).toBe(true);
    });

    it("gives a prize as the game's own commands", () => {
        expect(
            commands.rewardCommands("Ana", {
                items: [{ id: "minecraft:diamond", count: 5 }],
                levels: 10
            })
        ).toEqual(["give Ana minecraft:diamond 5", "xp add Ana 10 levels"]);
    });

    it("counts a finish as a box from bedrock to the sky", () => {
        expect(commands.arrived(1000, -200)).toContain("@a[x=994,y=-64,z=-206,dx=12,dy=384,dz=12]");
    });
});

describe("trivia", () => {
    it("takes an answer however it is written", () => {
        expect(trivia.answers("  Caña de Azúcar!! ", ["caña de azucar"])).toBe(true);
        expect(trivia.answers("DIAMOND pickaxe", ["diamond pickaxe"])).toBe(true);
        expect(trivia.answers("iron", ["diamond pickaxe"])).toBe(false);
    });

    it("finds the first right answer in the log, whatever the loader prints", () => {
        const log = [
            "[20:00:01] [Server thread/INFO]: <Ben> no idea",
            "[20:00:02] [Server thread/INFO] [minecraft/MinecraftServer]: <Ana> Creeper",
            "[20:00:03] [Server thread/INFO]: [Not Secure] <Cai> creeper"
        ].join("\n");
        expect(firstRight(log, ["creeper"])).toBe("Ana");
        expect(firstRight(log, ["zombie"])).toBeNull();
    });

    it("never hands a word back unscrambled", () => {
        for (let seed = 0; seed < 50; seed += 1) {
            expect(trivia.scramble("diamond", trivia.seeded(`s${seed}`))).not.toBe("DIAMOND");
        }
    });

    it("asks in the same order after a restart", () => {
        const one = trivia
            .shuffled(trivia.QUESTIONS.en, trivia.seeded("event-1"))
            .map((q) => q.question);
        const again = trivia
            .shuffled(trivia.QUESTIONS.en, trivia.seeded("event-1"))
            .map((q) => q.question);
        expect(again).toEqual(one);
    });

    it("has answers for every built-in question, and no braces", () => {
        for (const language of ["en", "es"] as const) {
            for (const question of trivia.QUESTIONS[language]) {
                expect(question.answers.length).toBeGreaterThan(0);
                expect(question.question).not.toMatch(/[{}]/);
                expect(
                    catalog.presetSchema.safeParse({
                        ...catalog.newPreset("trivia", "t"),
                        options: {
                            ...catalog.newPreset("trivia", "t").options,
                            questions: [question]
                        }
                    }).success
                ).toBe(true);
            }
            for (const word of trivia.WORDS[language]) expect(word).toMatch(/^[a-z]+$/);
        }
    });
});

describe("versions", () => {
    it("reads what is at least what", () => {
        expect(atLeast("1.21.4", [1, 21, 5])).toBe(false);
        expect(atLeast("1.21.5", [1, 21, 5])).toBe(true);
        expect(atLeast("1.20", [1, 21, 2])).toBe(false);
        expect(atLeast("1.21.10", [1, 21, 5])).toBe(true);
        expect(atLeast(null, [1, 21, 5])).toBe(true);
        expect(atLeast("24w14a", [1, 21, 5])).toBe(true);
    });
});
