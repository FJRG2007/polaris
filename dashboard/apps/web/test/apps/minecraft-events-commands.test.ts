/**
 * What a Minecraft event sends the server, and how the server's answers are
 * read - asserted line by line, since a wrong line is an event that silently
 * does nothing in the game.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as trivia from "@polaris-app/game-servers/src/lib/minecraft/events/trivia-bank";
import * as boost from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/xp-boost";
import * as duel from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/team-duel";
import * as gather from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/gathering";
import * as hunt from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/treasure-hunt";
import * as build from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/build-battle";
import * as rareCatch from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/rare-catch";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import * as waves from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/waves";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as chunks from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/chunks";
import * as spleef from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/spleef";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";
import * as parkour from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/parkour";
import * as parkourLayout from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/parkour-layout";
import * as meteors from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/meteor-shower";
import {
    atLeast,
    chatLines,
    firstRight,
    truthRound
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
            "minecraft.mined:minecraft.deepslate_diamond_ore",
            "minecraft.used:minecraft.diamond_ore",
            "minecraft.used:minecraft.deepslate_diamond_ore"
        ]);
    });

    it("weights what is worth more", () => {
        const lines = commands.scoreTick(preset("mining-rush"));
        expect(lines).toContain(
            "execute as @a run scoreboard players operation @s pe_tmp *= #w8 pe_const"
        );
        expect(lines.at(-1)).toBe(
            "execute as @a[scores={pe_sum=1..}] run scoreboard players operation @s pe_score = @s pe_sum"
        );
    });

    it("counts a statistic the server does not have as nothing, not as the one before it", () => {
        // A 1.16 server: no deepslate or copper ores, so their objectives were
        // never made. Played through a scoreboard that fails the way the game
        // does - a command naming a missing objective changes nothing - with one
        // player who mined five coal ore.
        const missing = /deepslate|copper/;
        const made = new Set(
            commands
                .components(preset("mining-rush"))
                .filter((one) => !missing.test(one.criterion))
                .map((one) => one.objective)
        );
        const scores = new Map<string, number | undefined>([["pe_c0", 5]]);
        for (const line of commands.setupScoreboard(preset("mining-rush"), "&6Mining")) {
            const constant = /^scoreboard players set (#w-?\d+) pe_const (-?\d+)$/.exec(line);
            if (constant) scores.set(constant[1]!, Number(constant[2]));
        }
        for (const extra of ["pe_sum", "pe_tmp", "pe_const", "pe_score"]) made.add(extra);
        const get = (objective: string) =>
            made.has(objective) ? scores.get(objective) : undefined;
        for (const line of commands.scoreTick(preset("mining-rush"))) {
            let match = /^scoreboard players (set|add) @a (\S+) (-?\d+)$/.exec(line);
            if (match) {
                const [, verb, objective, amount] = match;
                if (made.has(objective!))
                    scores.set(
                        objective!,
                        (verb === "add" ? (scores.get(objective!) ?? 0) : 0) + Number(amount)
                    );
                continue;
            }
            match = /store result score @s (\S+) run scoreboard players get @s (\S+)$/.exec(line);
            if (match) {
                scores.set(match[1]!, get(match[2]!) ?? 0);
                continue;
            }
            match = /operation @s (\S+) (\S+) (?:@s|(#w-?\d+)) (\S+)$/.exec(line);
            if (match) {
                const [, target, op, constant, source] = match;
                const right = constant ? scores.get(constant) : get(source!);
                const left = get(target!);
                if (right === undefined || !made.has(target!)) continue;
                const value =
                    op === "="
                        ? right
                        : op === "+="
                          ? (left ?? 0) + right
                          : op === "-="
                            ? (left ?? 0) - right
                            : op === "*="
                              ? (left ?? 0) * right
                              : Math.trunc((left ?? 0) / right);
                scores.set(target!, value);
            }
        }
        expect(scores.get("pe_score")).toBe(5);
    });

    it("sets up a constant for every weight the tick multiplies by", () => {
        const setup = commands.setupScoreboard(preset("mining-rush"), "&6Mining");
        for (const line of commands.scoreTick(preset("mining-rush"))) {
            const used = /#w(-?\d+)/.exec(line)?.[1];
            if (used) expect(setup).toContain(`scoreboard players set #w${used} pe_const ${used}`);
        }
    });

    it("shows distance in meters", () => {
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
    it("asks for answers a few dozen lines to a trip, and alone only what a trip lost", async () => {
        const lines = Array.from({ length: 60 }, (_, at) => `tp P${at} 0 64 0`);
        const trips: number[] = [];
        const alone: string[] = [];
        const answers = await commands.answersOf(
            {
                say: async ([line]) => {
                    alone.push(line!);
                    return `alone ${line}`;
                },
                sayEach: async (argvs) => {
                    trips.push(argvs.length);
                    if (trips.length === 2) throw new Error("timed out");
                    return argvs.map(([line]) => `trip ${line}`);
                }
            },
            lines
        );
        expect(trips).toEqual([25, 25, 10]);
        expect(alone).toEqual(lines.slice(25, 50));
        expect(answers).toHaveLength(60);
        expect(answers[0]).toBe("trip tp P0 0 64 0");
        expect(answers[30]).toBe("alone tp P30 0 64 0");
        expect(answers[59]).toBe("trip tp P59 0 64 0");
    });

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
        expect(commands.gaveIt("Gave 1 [Diamond] to ErrorBoy")).toBe(true);
        expect(commands.gaveIt("Gave 5 experience levels to Unknown_1\n")).toBe(true);
        expect(commands.gaveIt("Can't give more than 6400 of [Stick]")).toBe(false);
        expect(commands.gaveIt("Error: Player not found.")).toBe(false);
        expect(commands.gaveIt("")).toBe(false);
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
        // By players' homes too: no door broken down, no untagged reinforcement,
        // nothing a player dropped picked up.
        for (const line of lines.filter((one) => one.includes("summon")))
            expect(line).toContain("CanPickUpLoot:0b,CanBreakDoors:0b");
        expect(lines).toContain(
            "execute as @e[tag=pe_new,type=minecraft:zombie] run attribute @s minecraft:spawn_reinforcements base set 0"
        );
    });

    it("names a boss the way each version reads a name", () => {
        expect(commands.bossNameCommand("The Warlord", true)).toContain(
            '{CustomName:{text:"The Warlord",color:"red",bold:1b}}'
        );
        const legacy = commands.bossNameCommand("The Warlord", false);
        expect(legacy).toMatch(/\{CustomName:'\[.*The Warlord.*\]'\}/);
    });

    it("names a boss with an accent, a quote or a backslash on a server before 1.21.5", () => {
        // A quoted SNBT string as brigadier's StringReader reads one up to
        // 1.21.4: `\\` and `\'` are the only escapes, anything else is refused.
        const readQuoted = (line: string): string => {
            const start = line.indexOf("{CustomName:'") + "{CustomName:'".length;
            let out = "";
            for (let index = start; index < line.length; index += 1) {
                const char = line[index] as string;
                if (char === "\\") {
                    const next = line[index + 1] as string;
                    if (next !== "\\" && next !== "'")
                        throw new Error(`Invalid escape sequence '\\${next}' in quoted string`);
                    out += next;
                    index += 1;
                } else if (char === "'") return out;
                else out += char;
            }
            throw new Error("Unclosed quoted string");
        };
        const plain = (json: string): string => {
            const walk = (part: unknown): string =>
                typeof part === "string"
                    ? part
                    : Array.isArray(part)
                      ? part.map(walk).join("")
                      : `${(part as { text?: string }).text ?? ""}${walk((part as { extra?: unknown[] }).extra ?? [])}`;
            return walk(JSON.parse(json));
        };
        for (const name of ["El Señor de la Guerra", 'Ana\'s "Rex"', "back\\slash"]) {
            const line = commands.bossNameCommand(name, false);
            expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
            expect(plain(readQuoted(line))).toBe(name);
        }
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
        // The game's id, and the plural, are the same answer.
        expect(trivia.answers("minecraft:ender_pearl", ["ender pearl"])).toBe(true);
        expect(trivia.answers("Creepers", ["creeper"])).toBe(true);
        expect(trivia.answers("lingotes", ["lingote"])).toBe(true);
        expect(trivia.answers("minecraft", ["creeper"])).toBe(false);
        expect(trivia.answers("creep", ["creeper"])).toBe(false);
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

    it("takes true or false typed in either language, as a word or its letter", () => {
        for (const typed of ["t", "T", " true ", "TRUE!", "v", "V", "verdadero", "Verdadero."])
            expect(trivia.truthSaid(typed)).toBe(true);
        for (const typed of ["f", "F", "false", "False", "falso", " FALSO "])
            expect(trivia.truthSaid(typed)).toBe(false);
        for (const typed of ["", "fs", "trues", "verdad", "yes", "si", "tf", "true false", "x"])
            expect(trivia.truthSaid(typed)).toBeNull();
    });

    it("asks a question answered true or false as a true-or-false one, the operator's too", () => {
        expect(trivia.truthOf({ question: "Sheep can be dyed.", answers: ["Verdadero"] })).toBe(
            true
        );
        expect(
            trivia.truthOf({ question: "Ghasts live in the End.", answers: ["false", "f"] })
        ).toBe(false);
        expect(trivia.truthOf({ question: "Either?", answers: ["true", "false"] })).toBeNull();
        expect(trivia.truthOf({ question: "Which mob?", answers: ["creeper"] })).toBeNull();
        expect(trivia.truthAnswers(true, "es")[0]).toBe("verdadero");
        expect(trivia.truthAnswers(false, "en")[0]).toBe("false");
    });

    const said = (...lines: [string, string][]) =>
        lines
            .map(([name, text]) => `[20:00:01] [Server thread/INFO]: <${name}> ${text}`)
            .join("\n");

    it("gives a true-or-false round to the first right answer, typed in any of its forms", () => {
        for (const typed of ["t", "true", "v", "verdadero", "TRUE", "Verdadero!"])
            expect(truthRound(said(["Ana", typed]), true, []).winner).toBe("Ana");
        for (const typed of ["f", "false", "falso", "F", "Falso."])
            expect(truthRound(said(["Ana", typed]), false, []).winner).toBe("Ana");
        // Chatter is no answer, and changes nothing.
        expect(truthRound(said(["Ana", "hmm"], ["Ana", "trues"]), true, [])).toEqual({
            winner: null,
            out: []
        });
    });

    it("counts only a player's first true-or-false answer, across reads of the log", () => {
        const first = truthRound(said(["Ana", "f"], ["Ana", "t"], ["Ben", "maybe"]), true, []);
        expect(first).toEqual({ winner: null, out: ["Ana"] });
        // Still out the next time the log is read, however it is written.
        expect(truthRound(said(["ana", "verdadero"], ["Ben", "v"]), true, first.out)).toEqual({
            winner: "Ben",
            out: ["Ana"]
        });
    });

    it("reads a [True] or [False] click of this round as the answer, and none of another", () => {
        const line = commands.truthButtons(
            2,
            "&eClick or type t or f:",
            { label: "[True]", hover: "Answer true" },
            { label: "[False]", hover: "Answer false" }
        );
        expect(line.startsWith("tellraw @a ")).toBe(true);
        // Both spellings of the click, as the join buttons write them.
        const yes = commands.truthValue(2, true);
        const no = commands.truthValue(2, false);
        expect(line).toContain(
            `"clickEvent":{"action":"run_command","value":"/trigger pe_join set ${yes}"}`
        );
        expect(line).toContain(
            `"click_event":{"action":"run_command","command":"/trigger pe_join set ${no}"}`
        );
        // Never one of the join buttons' values, nor another round's.
        const values = [0, 1, 2, 14].flatMap((round) => [
            commands.truthValue(round, true),
            commands.truthValue(round, false)
        ]);
        expect(new Set(values).size).toBe(values.length);
        for (const value of values)
            expect([
                commands.JOIN_VALUE,
                commands.LEAVE_VALUE,
                commands.DONE_VALUE,
                commands.UNDO_VALUE
            ]).not.toContain(value);
        const pressedYes = commands.truthPressedLine("Ana", yes, 2);
        const pressedNo = commands.truthPressedLine("Ana", no, 2);
        expect(truthRound(pressedYes!, true, []).winner).toBe("Ana");
        expect(truthRound(pressedNo!, true, [])).toEqual({ winner: null, out: ["Ana"] });
        expect(commands.truthPressedLine("Ana", commands.truthValue(1, true), 2)).toBeNull();
        expect(commands.truthPressedLine("Ana", commands.JOIN_VALUE, 2)).toBeNull();
        // A join press never reads as an answer either.
        expect(commands.pressedLine("Ana", yes)).toBeNull();
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

    it("has hundreds of Minecraft questions, each in both languages, with a source and ids that never clash", () => {
        expect(trivia.BANK.length).toBeGreaterThanOrEqual(250);
        expect(new Set(trivia.BANK.map((one) => one.id)).size).toBe(trivia.BANK.length);
        // Every category is about Minecraft, and every one of them is asked.
        const categories = new Set(trivia.BANK.map((one) => one.category));
        expect([...categories].sort()).toEqual([...trivia.CATEGORIES].sort());
        for (const language of ["en", "es"] as const) {
            const asked = trivia.BANK.map((one) => trivia.normalizeAnswer(one[language].question));
            expect(new Set(asked).size).toBe(asked.length);
        }
        for (const one of trivia.BANK) {
            expect(one.source).toMatch(/^https:\/\/minecraft\.wiki\/w\/[^\s]+$/);
            // A true-or-false one is a sentence to judge, the same either way.
            const truth = trivia.truthOf(one.en);
            expect(trivia.truthOf(one.es)).toBe(truth);
            expect(truth !== null).toBe(one.id.startsWith("truth-"));
            if (truth !== null) {
                expect(one.en.question).toMatch(/^[A-Z].*\.$/);
                expect(one.es.question).toMatch(/^[A-ZÁÉÍÓÚÑ].*\.$/);
                continue;
            }
            expect(one.en.question.endsWith("?")).toBe(true);
            expect(one.es.question).toMatch(/^¿.*\?$|\?$/);
            expect(one.en.answers.length).toBeGreaterThan(0);
            expect(one.es.answers.length).toBeGreaterThan(0);
            // Every accepted answer still reads as one once compared.
            for (const answer of [...one.en.answers, ...one.es.answers])
                expect(trivia.normalizeAnswer(answer).length).toBeGreaterThan(0);
        }
        // Readers of either language are asked the same question in the same round.
        expect(trivia.QUESTIONS.en).toHaveLength(trivia.QUESTIONS.es.length);
    });

    it("asks nothing but Minecraft by default, in a new trivia event and in one saved before", () => {
        const offTopic =
            /capital of|planet|guitar|piano|ocean on earth|chemical symbol|olympic|painted/i;
        for (const one of trivia.BANK) expect(one.en.question).not.toMatch(offTopic);
        const made = catalog.newPreset("trivia", "t");
        const saved = catalog.presetSchema.parse({
            ...made,
            options: { rounds: 8, seconds: 30, mode: "questions" }
        });
        for (const preset of [made, saved]) {
            const options = preset.options as catalog.EventOptions<"trivia">;
            expect(options.questions).toEqual([]);
        }
        const ids = new Set(trivia.BANK.map((one) => one.id));
        for (const one of trivia.ordered("event-1", ["geography-148", "history-207"]))
            expect(ids.has(one.id)).toBe(true);
    });

    it("never repeats a question inside a game, and asks what was not asked lately first", () => {
        const game = trivia.ordered("event-1", []);
        expect(new Set(game.map((one) => one.id)).size).toBe(trivia.BANK.length);
        expect(trivia.ordered("event-1", []).map((one) => one.id)).toEqual(
            game.map((one) => one.id)
        );
        const recent = game.slice(0, 20).map((one) => one.id);
        const next = trivia.ordered("event-2", recent);
        const firstOnes = next.slice(0, trivia.BANK.length - recent.length).map((one) => one.id);
        for (const id of recent) expect(firstOnes).not.toContain(id);
        expect(trivia.remembered(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
        const many = Array.from({ length: trivia.RECENT_KEPT + 10 }, (_, index) => `q${index}`);
        expect(trivia.remembered([], many)).toHaveLength(trivia.RECENT_KEPT);
        expect(trivia.remembered([], many).at(-1)).toBe(`q${trivia.RECENT_KEPT + 9}`);
    });
});

describe("versions", () => {
    it("reads what is at least what", () => {
        expect(atLeast("1.21.4", [1, 21, 5])).toBe(false);
        expect(atLeast("1.21.5", [1, 21, 5])).toBe(true);
        expect(atLeast("1.20", [1, 21, 2])).toBe(false);
        expect(atLeast("1.21.10", [1, 21, 5])).toBe(true);
        // Unknown is not the newest: it is not at least anything.
        expect(atLeast(null, [1, 21, 5])).toBe(false);
        expect(atLeast(null, [1, 16])).toBe(false);
        expect(atLeast("24w14a", [1, 21, 5])).toBe(true);
    });
});

describe("a world boss's end", () => {
    it("takes the boss away for good, not only out of sight", () => {
        const lines = commands.cleanup(catalog.newPreset("world-boss", "b"), null);
        expect(lines.indexOf("kill @e[tag=pe_boss]")).toBeGreaterThan(
            lines.indexOf("execute as @e[tag=pe_boss] at @s run tp @s ~ -1000 ~")
        );
    });
});

describe("the marker on a server without the heightmap", () => {
    it("is brought down through leaves, logs and air, and stops on anything else", () => {
        expect(commands.SETTLE_MARK.length).toBe(96);
        expect(commands.SETTLE_MARK.slice(0, 3)).toEqual([
            "execute as @e[tag=pe_mark,limit=1] at @s if block ~ ~-1 ~ #minecraft:leaves run tp @s ~ ~-1 ~",
            "execute as @e[tag=pe_mark,limit=1] at @s if block ~ ~-1 ~ #minecraft:logs run tp @s ~ ~-1 ~",
            "execute as @e[tag=pe_mark,limit=1] at @s if block ~ ~-1 ~ minecraft:air run tp @s ~ ~-1 ~"
        ]);
    });
});

describe("a gathering of iron", () => {
    /**
     * One player's scoreboard, played through the tick's lines the way the game
     * runs them: `stats` are the game's own counts, `held` what they carry.
     */
    function progress(stats: Record<string, number>, heldAtStart: number, heldNow: number): number {
        const setup = gather.gatheringSetup("iron_ingot");
        const criteria = new Map<string, string>();
        for (const line of setup) {
            const made = /^scoreboard objectives add (\S+) (\S+)$/.exec(line);
            if (made) criteria.set(made[1]!, made[2]!);
        }
        const scores = new Map<string, number>();
        for (const [objective, criterion] of criteria) {
            if (criterion in stats) scores.set(objective, stats[criterion]!);
        }
        const matches = (selector: string) => {
            const range = /scores=\{(.+)\}/.exec(selector)?.[1];
            if (!range) return true;
            return range.split(",").every((part) => {
                const [objective, bounds] = part.split("=") as [string, string];
                const value = scores.get(objective);
                if (value === undefined) return false;
                const [low, high] = bounds.includes("..") ? bounds.split("..") : [bounds, bounds];
                return (
                    (low === "" || value >= Number(low)) && (high === "" || value <= Number(high))
                );
            });
        };
        const run = (line: string, held: number) => {
            let m =
                /^execute as (\S+) unless score @s (\S+) matches 1 store result score @s (\S+) run clear/.exec(
                    line
                );
            if (m) {
                if (scores.get(m[2]!) !== 1) scores.set(m[3]!, held);
                return;
            }
            m = /^execute as \S+ store result score @s (\S+) run clear/.exec(line);
            if (m) return void scores.set(m[1]!, held);
            m = /^scoreboard players (set|add) (\S+) (\S+) (-?\d+)$/.exec(line);
            if (m) {
                if (!criteria.has(m[3]!) || !matches(m[2]!)) return;
                const now = m[1] === "add" ? (scores.get(m[3]!) ?? 0) : 0;
                return void scores.set(m[3]!, now + Number(m[4]));
            }
            m = /^execute as (\S+) run scoreboard players operation @s (\S+) (\S+) @s (\S+)$/.exec(
                line
            );
            if (m) {
                if (!matches(m[1]!)) return;
                const [, , target, op, source] = m;
                const right = scores.get(source!);
                if (right === undefined) return;
                const left = scores.get(target!) ?? 0;
                const value =
                    op === "="
                        ? right
                        : op === "+="
                          ? left + right
                          : op === "-="
                            ? left - right
                            : op === "<"
                              ? Math.min(left, right)
                              : op === ">"
                                ? Math.max(left, right)
                                : left;
                scores.set(target!, value);
            }
        };
        for (const line of gather.gatheringTick("iron_ingot")) run(line, heldAtStart);
        for (const line of gather.gatheringTick("iron_ingot")) run(line, heldNow);
        return scores.get("pe_prog") ?? 0;
    }

    it("does not count ingots crafted out of a block taken from the player's own chest", () => {
        // Nine ingots crafted from a block: made, never picked up as raw iron.
        expect(progress({ "minecraft.crafted:minecraft.iron_ingot": 9 }, 0, 9)).toBe(0);
    });

    it("counts ingots smelted from raw iron picked up since the start", () => {
        const stats = {
            "minecraft.picked_up:minecraft.raw_iron": 5,
            "minecraft.crafted:minecraft.iron_ingot": 5
        };
        expect(progress(stats, 0, 5)).toBe(5);
        // And no more than that raw iron could make, however many are crafted.
        expect(progress({ ...stats, "minecraft.crafted:minecraft.iron_ingot": 14 }, 0, 14)).toBe(5);
    });

    it("counts ingots picked up off the ground, as before", () => {
        expect(progress({ "minecraft.picked_up:minecraft.iron_ingot": 3 }, 2, 5)).toBe(3);
    });
});

describe("letting go of chunks", () => {
    it("spares the chunks somebody else held, and lets go of the rest one by one", () => {
        const keep = new Set(["2,-1"]);
        expect(
            chunks.spareHeld(
                "execute in minecraft:overworld run forceload remove 10 -35 34 -11",
                keep
            )
        ).toEqual([
            "execute in minecraft:overworld run forceload remove 0 -48",
            "execute in minecraft:overworld run forceload remove 0 -32",
            "execute in minecraft:overworld run forceload remove 0 -16",
            "execute in minecraft:overworld run forceload remove 16 -48",
            "execute in minecraft:overworld run forceload remove 16 -32",
            "execute in minecraft:overworld run forceload remove 16 -16",
            "execute in minecraft:overworld run forceload remove 32 -48",
            "execute in minecraft:overworld run forceload remove 32 -32"
        ]);
        expect(
            chunks.spareHeld("execute in minecraft:overworld run forceload remove 40 -10", keep)
        ).toEqual([]);
    });

    it("leaves everything else as it was", () => {
        const keep = new Set(["2,-1"]);
        const line = "execute in minecraft:overworld run forceload remove 100 100";
        expect(chunks.spareHeld(line, keep)).toEqual([line]);
        expect(chunks.spareHeld("forceload add 40 -20", keep)).toEqual(["forceload add 40 -20"]);
        // Nothing known held: nothing to spare.
        expect(chunks.spareHeld("forceload remove 40 -20", null)).toEqual([
            "forceload remove 40 -20"
        ]);
    });
});

describe("vanilla's own commands on a Bukkit-family server", () => {
    it("names the command, and the one an execute runs, as vanilla's", () => {
        expect(commands.namespaced("kill @e[tag=pe_mark]")).toBe("minecraft:kill @e[tag=pe_mark]");
        expect(
            commands.namespaced(
                "execute in minecraft:overworld run tp Ana 1.000 64.000 2.000 0.0 0.0"
            )
        ).toBe(
            "minecraft:execute in minecraft:overworld run minecraft:tp Ana 1.000 64.000 2.000 0.0 0.0"
        );
        expect(
            commands.namespaced(
                'execute as @e[tag=pe_boss,nbt={CustomName:"a run b"}] at @s run execute as @a run give @s minecraft:stone 1'
            )
        ).toBe(
            'minecraft:execute as @e[tag=pe_boss,nbt={CustomName:"a run b"}] at @s run minecraft:execute as @a run minecraft:give @s minecraft:stone 1'
        );
        // Text is never touched, nor a line already named.
        expect(commands.namespaced('tellraw @a {"text":"run kill"}')).toBe(
            'minecraft:tellraw @a {"text":"run kill"}'
        );
        expect(commands.namespaced("minecraft:difficulty")).toBe("minecraft:difficulty");
    });

    it("keeps every ground check short enough to arrive with the name in front", () => {
        const far = { x: -29999999, y: -63, z: -29999999 };
        for (const names of commands.GROUND_NAMES) {
            for (const line of commands.builtUnder(far, names)) {
                expect(commands.namespaced(line).startsWith("minecraft:execute ")).toBe(true);
                expect(commandBytes(commands.namespaced(line))).toBeLessThanOrEqual(
                    COMMAND_BYTES_MAX
                );
            }
        }
        // A line with no room left goes as it is rather than not at all.
        const full = `say ${"x".repeat(COMMAND_BYTES_MAX - 4)}`;
        expect(commands.namespaced(full)).toBe(full);
    });

    it("tells a Bukkit-family server by its answer", () => {
        expect(commands.isBukkit("The difficulty is Normal")).toBe(true);
        expect(
            commands.isBukkit(
                "Unknown or incomplete command, see below for error\n...ft:difficulty<--[HERE]"
            )
        ).toBe(false);
        expect(commands.isBukkit("")).toBe(false);
    });
});

describe("what the server understands, when its version is unknown", () => {
    it("reads a probe the game parsed apart from one it refused", () => {
        // 1.20.5 and later, and 1.16 and later: nobody has the tag.
        expect(commands.probeParsed("No player was found")).toBe(true);
        expect(commands.probeParsed("No entity was found")).toBe(true);
        // Items written the other way, before 1.20.5.
        expect(
            commands.probeParsed(
                "Expected whitespace to end one argument, but found trailing data\n...tone[minecraft:custom_data={polaris_event:1b}] 0<--[HERE]"
            )
        ).toBe(false);
        // No `attribute` before 1.16, vanilla and Spigot.
        expect(commands.probeParsed("Unknown command\n...attribute<--[HERE]")).toBe(false);
        expect(commands.probeParsed('Unknown command. Type "/help" for help.')).toBe(false);
        // No answer at all is no evidence.
        expect(commands.probeParsed("")).toBe(false);
    });

    it("knows `attribute` is there even where the probe's old id is not (1.21.2 on)", () => {
        // Paper 1.21.4, as it answered.
        expect(
            commands.commandKnown(
                "Can't find element 'minecraft:generic.max_health' of type 'minecraft:attribute'\n...max_health get<--[HERE]"
            )
        ).toBe(true);
        expect(commands.commandKnown("No entity was found")).toBe(true);
        expect(commands.commandKnown("Unknown command\n...attribute<--[HERE]")).toBe(false);
        expect(commands.commandKnown('Unknown command. Type "/help" for help.')).toBe(false);
        expect(commands.commandKnown("")).toBe(false);
    });

    it("takes nothing from anybody with either probe", () => {
        expect(commands.PROBE_COMPONENTS).toMatch(/^clear @a\[tag=pe_probe\] \S+ 0$/);
        expect(commands.PROBE_ATTRIBUTE).toMatch(/^attribute @e\[tag=pe_probe,limit=1\] \S+ get$/);
    });
});

describe("a mining rush cannot be farmed", () => {
    it("takes off every ore block placed during it", () => {
        const lines = commands.scoreTick(catalog.newPreset("mining-rush", "r"));
        const placed = commands
            .components(catalog.newPreset("mining-rush", "r"))
            .find((one) => one.criterion === "minecraft.used:minecraft.diamond_ore");
        expect(placed?.weight).toBe(-8);
        expect(lines).toContain(
            `execute as @a run scoreboard players operation @s pe_tmp *= #w-8 pe_const`
        );
    });
});

describe("where an event may go", () => {
    it("reads where players sleep, the old way and the new", () => {
        expect(
            commands.readHomes(
                "Ana has the following entity data: 120\nBen has the following entity data: -40",
                "Ana has the following entity data: -7\nBen has the following entity data: 900",
                "Cam has the following entity data: [I; 5, 64, -3]"
            )
        ).toEqual([
            { x: 120, z: -7 },
            { x: -40, z: 900 },
            { x: 5, z: -3 }
        ]);
        expect(commands.readHomes("Found no elements matching SpawnX", "", "")).toEqual([]);
    });

    it("counts only the homes in the Overworld, from either era's answer", () => {
        expect(
            commands.readHomes(
                "Ana has the following entity data: 120\nBen has the following entity data: -40",
                "Ana has the following entity data: -7\nBen has the following entity data: 900",
                "Cam has the following entity data: [I; 5, 64, -3]Dee has the following entity data: [I; 8, 64, 9]",
                'Ana has the following entity data: "minecraft:the_nether"\nBen has the following entity data: "minecraft:overworld"',
                'Cam has the following entity data: "minecraft:the_nether"'
            )
        ).toEqual([
            { x: -40, z: 900 },
            { x: 8, z: 9 }
        ]);
    });

    it("reads a player's world as a name, or as the number it was before 1.16", () => {
        const worlds = commands.readDimensions(
            'Ana has the following entity data: "minecraft:the_end"\nBen has the following entity data: -1\nCy has the following entity data: 0'
        );
        expect([...worlds]).toEqual([
            ["Ana", "minecraft:the_end"],
            ["Ben", "minecraft:the_nether"],
            ["Cy", "minecraft:overworld"]
        ]);
    });

    it("keeps clear of every home, going further out when it has to", () => {
        const home = [{ x: 0, z: 0 }];
        let turn = 0;
        const random = () => (turn += 0.37) % 1;
        const point = commands.clearPoint({ x: 0, z: 0 }, 24, home, random);
        expect(point).not.toBeNull();
        // Clear by what the marker can drift too, so where it comes down is clear.
        expect(Math.hypot(point!.x, point!.z)).toBeGreaterThanOrEqual(
            commands.HOME_CLEARANCE + commands.MARK_DRIFT
        );
        expect(commands.clearPoint({ x: 0, z: 0 }, 24, [], random)).not.toBeNull();
        // A column just past the line is not enough: the marker may come down a step nearer.
        const edge = commands.clearPoint({ x: 0, z: 0 }, commands.HOME_CLEARANCE + 1, home, random);
        expect(Math.hypot(edge!.x, edge!.z)).toBeGreaterThanOrEqual(
            commands.HOME_CLEARANCE + commands.MARK_DRIFT
        );
    });

    it("asks about the ground under a point by the names the server knows", () => {
        const far = { x: -29999999, y: -63, z: -29999999 };
        for (const names of commands.GROUND_NAMES) {
            for (const line of commands.builtUnder(far, names)) {
                expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
                expect(line.startsWith("execute in minecraft:overworld unless block ")).toBe(true);
            }
        }
        const modern = commands.builtUnder({ x: 1, y: 70, z: 2 }, "modern").join(" ");
        expect(
            modern.startsWith(
                "execute in minecraft:overworld unless block 1 69 2 minecraft:grass_block"
            )
        ).toBe(true);
        expect(modern).toContain("minecraft:short_grass");
        expect(modern).toContain("#minecraft:small_flowers");
        expect(modern).not.toContain("#minecraft:flowers");
        expect(modern).not.toContain("leaves");
        expect(modern).not.toContain("leaf_litter");
        const latest = commands.builtUnder({ x: 1, y: 70, z: 2 }, "latest").join(" ");
        expect(latest).toContain("minecraft:leaf_litter");
        expect(latest).toContain("minecraft:short_dry_grass");
        const legacy = commands.builtUnder({ x: 1, y: 70, z: 2 }, "legacy").join(" ");
        expect(legacy).toContain("unless block 1 69 2 minecraft:grass ");
        expect(legacy).not.toContain("short_grass");
    });

    it("tells a refused block name apart from a column that could not be read", () => {
        expect(
            commands.nameRefused(
                "Unknown block type 'minecraft:leaf_litter'...ck 1 69 2 minecraft:leaf_litter<--[HERE]"
            )
        ).toBe(true);
        expect(commands.nameRefused("That position is not loaded")).toBe(false);
        expect(commands.nameRefused("")).toBe(false);
    });

    it("counts somebody in the circle only where the circle scores them", () => {
        const center = { x: 0, y: 64, z: 0 };
        expect(commands.inHill({ x: 3.5, y: 64, z: 0.5 }, center, 4)).toBe(true);
        expect(commands.inHill({ x: 3.5, y: 68, z: 0.5 }, center, 4)).toBe(false);
        expect(commands.inHill({ x: 5.5, y: 64, z: 0.5 }, center, 4)).toBe(false);
    });

    it("judges a place by its center and two rings", () => {
        expect(commands.siteSamples({ x: 0, z: 0 }, 6)).toHaveLength(17);
        expect(commands.siteSamples({ x: 0, z: 0 }, 3)).toHaveLength(9);
    });

    it("names the way to go, north being -Z", () => {
        expect(commands.headingTo({ x: 0, z: 0 }, { x: 0, z: -50 })).toBe("north");
        expect(commands.headingTo({ x: 0, z: 0 }, { x: 50, z: 0 })).toBe("east");
        expect(commands.headingTo({ x: 0, z: 0 }, { x: -50, z: 50 })).toBe("south-west");
    });
});
/** The objectives a list of lines adds, and the ones it removes. */
function objectives(lines: readonly string[], verb: "add" | "remove"): string[] {
    return lines.flatMap((line) => {
        const match = new RegExp(`^scoreboard objectives ${verb} (\\S+)`).exec(line);
        return match ? [match[1] as string] : [];
    });
}

/** Every item a line would take from a player: a `clear` without a count of 0. */
function takes(lines: readonly string[]): string[] {
    return lines.filter((line) => /(^|run )clear /.test(line) && !/ 0$/.test(line));
}

describe("a treasure hunt", () => {
    const chest = (x: number, z: number, opened = false) => ({
        x,
        y: 70,
        z,
        opened,
        by: null,
        was: null
    });

    it("asks whether a spot is air before anything goes there", () => {
        expect(hunt.airAt({ x: 10, y: 70, z: -4 })).toBe(
            "execute in minecraft:overworld if block 10 70 -4 minecraft:air"
        );
    });

    it("puts a chest down only where there is air, and never over anything", () => {
        expect(hunt.hideChest({ x: 10, y: 70, z: -4 }, "dungeon")).toBe(
            'execute in minecraft:overworld if block 10 70 -4 minecraft:air run setblock 10 70 -4 minecraft:chest{LootTable:"minecraft:chests/simple_dungeon"} keep'
        );
    });

    it("takes away only the chests nobody opened, and only while they are still unopened chests", () => {
        const lines = hunt.huntCleanup(
            [chest(100, 100), chest(300, 0, true)],
            [
                { x: 101, z: 99 },
                { x: 300, z: 0 }
            ]
        );
        const removals = lines.filter((line) => line.includes("setblock"));
        expect(removals).toEqual(commands.removeChestLines(chest(100, 100)));
        expect(removals[0]).toContain(
            "if block 100 70 100 minecraft:chest if data block 100 70 100 LootTable"
        );
        // Each chunk let go once: the column tried and the chest share one.
        expect(lines.filter((line) => line.includes("forceload remove"))).toEqual([
            commands.forceloadRemove(100, 100),
            commands.forceloadRemove(300, 0)
        ]);
        expect(lines.join("\n")).not.toMatch(/\bfill\b|minecraft:air replace minecraft:(?!chest)/);
    });

    it("keeps every chest's chunk loaded", () => {
        expect(
            hunt.holdChests([
                { x: 5, z: 5 },
                { x: 6, z: 7 },
                { x: 40, z: 5 }
            ])
        ).toEqual([commands.forceload(6, 7), commands.forceload(40, 5)]);
    });

    it("marks every chest nobody opened with a column of light from the start", () => {
        const lines = hunt.marks([chest(0, -300), chest(200, 0, true)]);
        expect(lines).toContain(commands.beam(chest(0, -300)));
        expect(lines.some((line) => line.includes(" 200.5 "))).toBe(false);
        expect(lines.some((line) => line.includes("particle minecraft:glow 0.5 70.8 -299.5"))).toBe(
            true
        );
    });

    it("points every player at the nearest chest nobody opened, however far, with how many are left", () => {
        const lines = hunt.guides(
            [
                { name: "Ana", x: 0.5, z: 30.5 },
                { name: "Ben", x: 900, z: 900 }
            ],
            [chest(0, 0), chest(0, 500), chest(50, 50, true)],
            "en"
        );
        expect(lines[0]).toMatch(/^title Ana actionbar /);
        expect(lines[0]).toContain("30 m ");
        expect(lines[0]).toContain("north");
        expect(lines[0]).toContain("(2/3)");
        // Far off, the way is shown all the same.
        expect(lines[1]).toContain("m ");
        expect(lines[1]).toContain("(2/3)");
        const done = hunt.guides([{ name: "Ana", x: 0, z: 0 }], [chest(0, 0, true)], "en");
        expect(done[0]).toContain("0 of 1");
    });

    it("seeks each chest its own way round the players, the same after a restart", () => {
        const ways = [0, 1, 2, 3, 4].map((index) => hunt.chestBearing("run-1", index, 5));
        expect(hunt.chestBearing("run-1", 2, 5)).toBe(ways[2]);
        for (let index = 1; index < ways.length; index += 1)
            expect(ways[index]! - ways[index - 1]!).toBeCloseTo((2 * Math.PI) / 5);
        // Kept within a sixth of a turn of the way asked for, at the distance asked for.
        for (let draw = 0; draw < 50; draw += 1) {
            const point = commands.pointAway({ x: 0, z: 0 }, 100, Math.random, 0);
            expect(point.z).toBeLessThan(0);
            expect(Math.abs(Math.atan2(point.x, -point.z))).toBeLessThanOrEqual(
                commands.BEARING_SPREAD + 0.02
            );
            expect(Math.hypot(point.x, point.z)).toBeGreaterThanOrEqual(69);
        }
    });

    it("takes the place of a small wild plant, and puts it back when nobody opened the chest", () => {
        expect(hunt.hideChest({ x: 1, y: 70, z: 2 }, "dungeon", "short_grass")).toBe(
            'execute in minecraft:overworld if block 1 70 2 minecraft:short_grass run setblock 1 70 2 minecraft:chest{LootTable:"minecraft:chests/simple_dungeon"} replace'
        );
        const back = hunt.removeLines({ x: 1, y: 70, z: 2, opened: false, by: null, was: "fern" });
        expect(back[0]).toBe(
            "execute in minecraft:overworld if block 1 70 2 minecraft:chest if data block 1 70 2 LootTable run setblock 1 70 2 minecraft:fern replace"
        );
        // A plant name out of anybody's hands is never written into a command.
        const odd = hunt.removeLines({
            x: 1,
            y: 70,
            z: 2,
            opened: false,
            by: null,
            was: "air run kill @a"
        });
        expect(odd.join("\n")).not.toContain("kill");
        expect(
            hunt.huntCleanup([{ x: 1, y: 70, z: 2, opened: false, by: null, was: "fern" }], [])[0]
        ).toBe(back[0]);
    });

    it("keeps its chests apart and spreads them out", () => {
        expect(hunt.tooClose({ x: 5, y: 70, z: 5 }, [chest(0, 0)])).toBe(true);
        expect(hunt.tooClose({ x: 30, y: 70, z: 0 }, [chest(0, 0)])).toBe(false);
        // On a small island they may come nearer, never onto one another.
        expect(hunt.tooClose({ x: 10, y: 70, z: 0 }, [chest(0, 0)], hunt.CHEST_GAP_NEAR)).toBe(
            false
        );
        expect(hunt.tooClose({ x: 5, y: 70, z: 0 }, [chest(0, 0)], hunt.CHEST_GAP_NEAR)).toBe(true);
        const options = { chests: 5, distance: 300, loot: "dungeon" as const };
        expect(hunt.huntDistance(options, () => 0)).toBe(105);
        expect(hunt.huntDistance(options, () => 0.999)).toBeLessThanOrEqual(300);
        expect(
            hunt.centerOf([
                { x: 0, z: 0 },
                { x: 10, z: -20 }
            ])
        ).toEqual({ x: 5, z: -10 });
        // Far apart: the larger group, never the empty ground between them.
        expect(
            hunt.centerOf([
                { x: 0, z: 0 },
                { x: 20, z: 0 },
                { x: 3000, z: 0 }
            ])
        ).toEqual({ x: 10, z: 0 });
        expect(
            hunt.centerOf([
                { x: 0, z: 0 },
                { x: 3000, z: 0 }
            ])
        ).toEqual({ x: 0, z: 0 });
        expect(hunt.centerOf([])).toBeNull();
    });
});

describe("a gathering", () => {
    it("counts what everybody holds without taking a single item, for every material", () => {
        for (const material of catalog.GATHER_MATERIALS) {
            const lines = [...gather.gatheringSetup(material), ...gather.gatheringTick(material)];
            expect(lines.some((line) => line.includes(" run clear @s "))).toBe(true);
            expect(takes(lines)).toEqual([]);
        }
    });

    it("takes where each player starts once, and never counts more than they gathered", () => {
        const lines = gather.gatheringTick("logs");
        expect(lines[0]).toBe(
            "execute as @a unless score @s pe_seen matches 1 store result score @s pe_base run clear @s #minecraft:logs 0"
        );
        expect(lines).toContain(
            "execute as @a store result score @s pe_have run clear @s #minecraft:logs 0"
        );
        expect(lines).toContain(
            "execute as @a run scoreboard players operation @s pe_cap += @s pe_gp0"
        );
        expect(lines).toContain(
            "execute as @a run scoreboard players operation @s pe_cap -= @s pe_gd0"
        );
        expect(lines).toContain(
            "execute as @a run scoreboard players operation @s pe_prog < @s pe_cap"
        );
        const setup = gather.gatheringSetup("logs");
        expect(setup).toContain(
            "scoreboard objectives add pe_gp0 minecraft.picked_up:minecraft.oak_log"
        );
        expect(setup).toContain(
            "scoreboard objectives add pe_gd10 minecraft.dropped:minecraft.warped_stem"
        );
        // Only iron is made rather than found: smelting it counts.
        expect(gather.gatheringSetup("iron_ingot")).toContain(
            "scoreboard objectives add pe_gc0 minecraft.crafted:minecraft.iron_ingot"
        );
        expect(setup.some((line) => line.includes("minecraft.crafted"))).toBe(false);
    });

    it("draws a material from the list, and reads a stored one back", () => {
        expect(gather.drawMaterial({ material: "kelp" }, () => 0.5)).toBe("kelp");
        expect(gather.drawMaterial({ material: "random" }, () => 0)).toBe("wheat");
        expect(gather.drawMaterial({ material: "random" }, () => 0.999)).toBe("pumpkin");
        expect(gather.materialOf("bamboo", { material: "random" })).toBe("bamboo");
        expect(gather.materialOf("nonsense", { material: "sand" })).toBe("sand");
        expect(gather.materialOf(null, { material: "random" })).toBe("wheat");
    });

    it("takes every objective any gathering makes back out", () => {
        const removed = new Set(objectives(gather.gatheringCleanup(), "remove"));
        for (const material of catalog.GATHER_MATERIALS) {
            for (const objective of objectives(gather.gatheringSetup(material), "add"))
                expect(removed.has(objective)).toBe(true);
        }
        for (const objective of removed) {
            expect(objective.startsWith("pe_")).toBe(true);
            expect(objective.length).toBeLessThanOrEqual(16);
        }
    });
});

describe("a rare catch", () => {
    it("never touches anybody's inventory", () => {
        const options = { treasure: "any" as const };
        const lines = [
            ...rareCatch.catchSetup(options),
            ...rareCatch.catchLook(options),
            rareCatch.READ_CATCHERS,
            ...rareCatch.catchCommit(),
            ...rareCatch.catchCleanup()
        ];
        expect(lines.filter((line) => /(^|run )clear /.test(line))).toEqual([]);
    });

    it("counts the treasure picked up, less dropped, and the rod reeled in", () => {
        const setup = rareCatch.catchSetup({ treasure: "saddle" });
        expect(setup).toContain(
            "scoreboard objectives add pe_rp1 minecraft.picked_up:minecraft.saddle"
        );
        expect(setup).toContain(
            "scoreboard objectives add pe_rd1 minecraft.dropped:minecraft.saddle"
        );
        expect(setup).toContain(
            "scoreboard objectives add pe_rod minecraft.used:minecraft.fishing_rod"
        );
        expect(setup.some((line) => line.includes("name_tag"))).toBe(false);
        expect(rareCatch.catches({ treasure: "any" })).toEqual(catalog.RARE_CATCHES);
        const look = rareCatch.catchLook({ treasure: "saddle" });
        expect(look).toContain(
            "execute as @a run scoreboard players operation @s pe_rcnt -= @s pe_rd1"
        );
        expect(look).toContain(
            `scoreboard players set @a[scores={pe_rdf=1..}] pe_rfr ${rareCatch.RECENT_LOOKS}`
        );
        expect(rareCatch.READ_CATCHERS).toBe(
            "execute as @a[scores={pe_rdc=1..,pe_rfr=1..}] run data get entity @s Pos"
        );
    });

    /**
     * One player's looks, played through the lines the way the game runs
     * them: each look the game's own counts of the treasure picked up and
     * dropped and of the rod used, and whether the look reads a catch.
     */
    function looks(steps: readonly { picked: number; dropped: number; rod: number }[]): boolean[] {
        const options = { treasure: "saddle" as const };
        const scores = new Map<string, number>();
        const matches = (selector: string) =>
            (/scores=\{(.+)\}/.exec(selector)?.[1] ?? "").split(",").every((part) => {
                if (part === "") return true;
                const [objective, bounds] = part.split("=") as [string, string];
                const value = scores.get(objective);
                return value !== undefined && value >= Number(bounds.replace("..", ""));
            });
        const run = (line: string) => {
            let m = /^scoreboard players (set|add|remove) (\S+) (\S+) (-?\d+)$/.exec(line);
            if (m) {
                if (!matches(m[2]!)) return;
                const now = scores.get(m[3]!) ?? 0;
                const by = Number(m[4]);
                scores.set(m[3]!, m[1] === "set" ? by : m[1] === "add" ? now + by : now - by);
                return;
            }
            m = /^execute as @a run scoreboard players operation @s (\S+) (\S+) @s (\S+)$/.exec(
                line
            );
            if (!m) throw new Error(`not played: ${line}`);
            const [, target, op, source] = m as unknown as [string, string, string, string];
            const right = scores.get(source) ?? 0;
            const left = scores.get(target) ?? 0;
            const value = {
                "=": right,
                "+=": left + right,
                "-=": left - right,
                ">": Math.max(left, right),
                "<": Math.min(left, right)
            }[op];
            if (value === undefined) throw new Error(`no operation ${op}`);
            scores.set(target, value);
        };
        return steps.map((step) => {
            scores.set("pe_rp1", step.picked);
            scores.set("pe_rd1", step.dropped);
            scores.set("pe_rod", step.rod);
            for (const line of rareCatch.catchLook(options)) run(line);
            const caught = (scores.get("pe_rdc") ?? 0) >= 1 && (scores.get("pe_rfr") ?? 0) >= 1;
            for (const line of rareCatch.catchCommit()) run(line);
            return caught;
        });
    }

    it("reads a treasure reeled in as a catch, and one dropped and picked up again as none", () => {
        // Reeled in: the rod used, the treasure picked up on the next look.
        expect(
            looks([
                { picked: 0, dropped: 0, rod: 0 },
                { picked: 0, dropped: 0, rod: 2 },
                { picked: 1, dropped: 0, rod: 2 }
            ])
        ).toEqual([false, false, true]);
        // One brought from before the start - or the one just caught - thrown
        // down on one look and picked up after a cast on another: no catch.
        expect(
            looks([
                { picked: 0, dropped: 0, rod: 0 },
                { picked: 0, dropped: 1, rod: 0 },
                { picked: 0, dropped: 1, rod: 1 },
                { picked: 1, dropped: 1, rod: 2 },
                { picked: 1, dropped: 2, rod: 3 },
                { picked: 2, dropped: 2, rod: 4 }
            ])
        ).toEqual([false, false, false, false, false, false]);
        // A real second catch after that still counts.
        expect(
            looks([
                { picked: 0, dropped: 0, rod: 0 },
                { picked: 0, dropped: 1, rod: 1 },
                { picked: 1, dropped: 1, rod: 2 },
                { picked: 2, dropped: 1, rod: 4 }
            ])
        ).toEqual([false, false, false, true]);
    });

    it("takes every objective it makes back out", () => {
        const removed = new Set(objectives(rareCatch.catchCleanup(), "remove"));
        for (const objective of objectives(rareCatch.catchSetup({ treasure: "any" }), "add")) {
            expect(removed.has(objective)).toBe(true);
            expect(objective.length).toBeLessThanOrEqual(16);
        }
    });
});

describe("an experience boost", () => {
    const options = { perKill: 5, perOre: 3 };

    it("pays what is owed in powers of two, only ever adding experience", () => {
        const lines = boost.boostTick(options);
        expect(lines).toContain("execute as @a[scores={pe_xd=32..}] run xp add @s 160 points");
        expect(lines).toContain("execute as @a[scores={pe_xd=1..}] run xp add @s 5 points");
        expect(lines).toContain("execute as @a[scores={pe_xd=1..}] run xp add @s 3 points");
        expect(lines).toContain("scoreboard players add @a[scores={pe_xd=4..}] pe_xkp 4");
        for (const line of lines.filter((one) => one.includes(" xp ")))
            expect(line).toMatch(/run xp add @s \d+ points$/);
        expect(lines.join("\n")).not.toMatch(/xp (set|remove)|xp add @s -/);
        // An ore put down is taken off the ores mined.
        expect(lines).toContain(
            "execute as @a run scoreboard players operation @s pe_xo -= @s pe_xu0"
        );
    });

    it("counts only what it rewards", () => {
        const kills = boost.boostSetup({ perKill: 4, perOre: 0 });
        expect(kills).toContain(
            "scoreboard objectives add pe_xk minecraft.custom:minecraft.mob_kills"
        );
        expect(kills.some((line) => line.includes("minecraft.mined"))).toBe(false);
        expect(
            boost.boostTick({ perKill: 0, perOre: 2 }).some((line) => line.includes("pe_xk "))
        ).toBe(false);
    });

    it("pays what is still owed before taking its objectives back out", () => {
        const lines = boost.boostCleanup(options);
        const lastPay = lines.findLastIndex((line) => line.includes("xp add"));
        const firstRemove = lines.findIndex((line) =>
            line.startsWith("scoreboard objectives remove")
        );
        expect(lastPay).toBeGreaterThan(0);
        expect(firstRemove).toBeGreaterThan(lastPay);
        const removed = new Set(objectives(lines, "remove"));
        for (const objective of objectives(boost.boostSetup(options), "add")) {
            expect(removed.has(objective)).toBe(true);
            expect(objective.length).toBeLessThanOrEqual(16);
        }
    });
});

describe("the new kinds in the catalog", () => {
    it("reads each with its defaults and keeps the limits", () => {
        expect(catalog.newPreset("treasure-hunt", "t").options).toEqual({
            chests: 5,
            distance: 300,
            loot: "bastion"
        });
        expect(catalog.newPreset("gathering", "g").options).toEqual({
            material: "random",
            rounds: 3,
            roundMinutes: 2
        });
        expect(catalog.newPreset("rare-catch", "r").options).toEqual({ treasure: "any" });
        expect(catalog.newPreset("xp-boost", "x").options).toEqual({ perKill: 5, perOre: 3 });
        const none = { ...catalog.newPreset("xp-boost", "x"), options: { perKill: 0, perOre: 0 } };
        expect(catalog.presetSchema.safeParse(none).success).toBe(false);
        const many = {
            ...catalog.newPreset("treasure-hunt", "t"),
            options: { chests: 11, distance: 300, loot: "dungeon" }
        };
        expect(catalog.presetSchema.safeParse(many).success).toBe(false);
    });

    it("ranks, places and judges each the way it is played", () => {
        const of = (kind: catalog.EventKind) => catalog.newPreset(kind, kind);
        expect(catalog.needsOverworld(of("treasure-hunt"))).toBe(true);
        expect(catalog.needsOverworld(of("gathering"))).toBe(false);
        expect(catalog.hasMinScore(of("rare-catch"))).toBe(false);
        expect(catalog.hasMinScore(of("gathering"))).toBe(true);
        expect(catalog.afkCounts(of("rare-catch"))).toBe(true);
        expect(catalog.afkCounts(of("treasure-hunt"))).toBe(false);
        expect(catalog.KIND_INFO["xp-boost"].competitive).toBe(false);
        expect(catalog.awardsPrizes(of("xp-boost"))).toBe(false);
        expect(commands.hasScoreboard(of("treasure-hunt"))).toBe(true);
        expect(commands.hasScoreboard(of("rare-catch"))).toBe(false);
        expect(commands.hasScoreboard(of("xp-boost"))).toBe(false);
    });

    it("has every new line in both languages, and no braces", () => {
        const lines = (["en", "es"] as const).flatMap((language) => [
            messages.huntGuide(12, "south-west", 2, 5, language),
            messages.huntStart(1, language),
            messages.huntStart(5, language),
            messages.huntLeftBar(2, 5, language),
            messages.huntUnfound(1, language),
            messages.huntUnfound(3, language),
            messages.huntOpened("Ana", 0, language),
            messages.gatherRoundTitle(2, 3, language),
            messages.gatherRoundLine(2, 3, "iron_ingot", 12, language),
            messages.gatherRoundLine(1, 3, "sand", 1, language),
            messages.gatherRoundBar(2, 3, "logs", 61, language),
            ...catalog.GATHER_MATERIALS.map((material) =>
                messages.gatherTarget(material, language)
            ),
            messages.gatherBar("wheat", 12, language),
            ...(["any", ...catalog.RARE_CATCHES] as const).map((one) =>
                messages.catchTarget(one, language)
            ),
            messages.catchBar("any", language),
            messages.catchWon("Ana", language),
            messages.catchMissed(language),
            messages.boostBar(5, 0, language),
            messages.boostOver(language)
        ]);
        for (const line of lines) expect(line).not.toMatch(/[{}]/);
        expect(messages.gatherTarget("wheat", "es")).toContain("Trigo");
        expect(messages.boostBar(5, 3, "en")).toContain("+5 a mob, +3 an ore");
    });
});

describe("a horde defense", () => {
    const point = { x: 300, y: 70, z: 0 };

    it("summons only monsters that cannot break a block, all of them tagged and kept", () => {
        for (const mix of catalog.WAVE_MIXES) {
            const lines = waves.summonWave(point, mix, 12, 0, 600);
            const summons = lines.filter((line) => line.includes(" run summon "));
            expect(summons).toHaveLength(12);
            for (const line of summons) {
                expect(line).toContain('Tags:["pe_mob","pe_wnew"]');
                expect(line).toContain("PersistenceRequired:1b");
                expect(line).toContain("CanBreakDoors:0b");
                expect(line).toContain("CanPickUpLoot:0b");
                expect(line).not.toMatch(
                    /creeper|enderman|ravager|silverfish|blaze|slime|ghast|wither /
                );
            }
            expect(lines.at(-1)).toBe("tag @e[tag=pe_wnew] remove pe_wnew");
        }
    });

    it("spreads a wave inside the ring, arms the archers and stops zombies calling for help", () => {
        const lines = waves.summonWave(point, "undead", 8, 0, 600);
        expect(lines).toContain(
            "execute in minecraft:overworld run spreadplayers 300 0 2 12 false @e[tag=pe_wnew,tag=!pe_wride]"
        );
        expect(lines).toContain(
            "item replace entity @e[tag=pe_wnew,type=minecraft:stray] weapon.mainhand with minecraft:bow"
        );
        expect(lines).toContain(
            "replaceitem entity @e[tag=pe_wnew,type=minecraft:skeleton] weapon.mainhand minecraft:bow"
        );
        expect(lines).toContain(
            "execute as @e[tag=pe_wnew,type=minecraft:husk] run attribute @s minecraft:spawn_reinforcements base set 0"
        );
        expect(lines).toContain(
            "execute as @e[tag=pe_wnew,type=minecraft:zombie] run attribute @s minecraft:zombie.spawn_reinforcements base set 0"
        );
        expect(lines).toContain("effect give @e[tag=pe_wnew] minecraft:fire_resistance 600 0 true");
    });

    it("dresses every wave better than the last: none, leather, chainmail, iron, diamond", () => {
        expect([0, 1, 2, 3, 4].map((wave) => waves.armorTier(wave, 5))).toEqual([
            "none",
            "leather",
            "chainmail",
            "iron",
            "diamond"
        ]);
        expect(waves.armorTier(0, 3)).toBe("none");
        expect(waves.armorTier(2, 3)).toBe("diamond");
        expect(waves.armorTier(9, 10)).toBe("diamond");
        const first = waves.summonWave(point, "classic", 8, 0, 600, { waves: 5, defenders: 1 });
        expect(first.some((line) => line.includes("_helmet"))).toBe(false);
        const third = waves.summonWave(point, "classic", 8, 2, 600, { waves: 5, defenders: 1 });
        expect(third).toContain(
            "item replace entity @e[tag=pe_wnew,type=minecraft:zombie] armor.chest with minecraft:chainmail_chestplate"
        );
        // Spiders wear nothing; nothing is enchanted below iron.
        expect(third.some((line) => line.includes("type=minecraft:spider] armor"))).toBe(false);
        expect(third.some((line) => line.includes("enchant"))).toBe(false);
        const last = waves.summonWave(point, "classic", 8, 4, 600, { waves: 5, defenders: 1 });
        expect(last).toContain(
            "item replace entity @e[tag=pe_wnew,type=minecraft:skeleton] armor.feet with minecraft:diamond_boots"
        );
        // The plain bow before the enchanted one, each era's spelling of it after.
        const bows = last.filter((line) =>
            line.startsWith(
                "item replace entity @e[tag=pe_wnew,type=minecraft:skeleton] weapon.mainhand"
            )
        );
        expect(bows[0]).toContain("with minecraft:bow");
        expect(bows).toContain(
            'item replace entity @e[tag=pe_wnew,type=minecraft:skeleton] weapon.mainhand with minecraft:bow[minecraft:enchantments={levels:{"minecraft:power":2}}]'
        );
        expect(bows).toContain(
            'item replace entity @e[tag=pe_wnew,type=minecraft:skeleton] weapon.mainhand with minecraft:bow[minecraft:enchantments={"minecraft:power":2}]'
        );
        expect(last).toContain(
            'replaceitem entity @e[tag=pe_wnew,type=minecraft:zombie] weapon.mainhand minecraft:iron_sword{Enchantments:[{id:"minecraft:sharpness",lvl:1s}]}'
        );
    });

    it("brings jockeys as the waves rise, only of what the mix sends, and never counts a mount", () => {
        expect(waves.jockeysFor(0, 5, "classic")).toEqual([]);
        expect(waves.jockeysFor(2, 5, "classic")).toEqual(["spider"]);
        expect(waves.jockeysFor(3, 5, "classic")).toEqual(["spider", "chicken"]);
        expect(waves.jockeysFor(4, 5, "classic")).toEqual([
            "spider",
            "chicken",
            "skeleton-horse",
            "zombie-horse"
        ]);
        // No spider in an undead mix, so no spider jockey.
        expect(waves.jockeysFor(4, 5, "undead")).not.toContain("spider");
        const lines = waves.summonWave(point, "classic", 12, 4, 600, { waves: 5, defenders: 1 });
        const jockeys = lines.filter((line) => line.includes("Passengers:["));
        expect(jockeys).toHaveLength(3);
        const summons = lines.filter((line) => line.includes(" run summon "));
        expect(summons).toHaveLength(12);
        for (const line of jockeys) {
            expect(line).toContain('"pe_mob"');
            expect(line).toContain("PersistenceRequired:1b");
        }
        const chicken = jockeys.find((line) => line.includes("summon minecraft:chicken"));
        expect(chicken).toContain('"pe_wmount"');
        expect(chicken).toContain("EggLayTime:1000000");
        expect(chicken).toContain('DeathLootTable:"minecraft:empty"');
        expect(chicken).toContain(
            '{id:"minecraft:zombie",Tags:["pe_mob","pe_wnew","pe_wride","pe_wrider"]'
        );
        expect(chicken).toContain("IsBaby:1b");
        // A spider is one of the wave, and counts; a chicken or a horse is only a mount.
        const spider = jockeys.find((line) => line.includes("summon minecraft:spider"));
        expect(spider).not.toContain("pe_wmount");
        expect(waves.WAVE_ALIVE).toBe("execute if entity @e[tag=pe_mob,tag=!pe_wmount]");
        expect(waves.MOUNTS_GONE).toBe("kill @e[tag=pe_wmount]");
        // The kill tag, glowing and the wave's strength go to the fighters, never a mount.
        expect(lines).toContain("tag @e[tag=pe_wnew,tag=!pe_wmount] add pe_wfight");
        expect(lines).toContain(
            "effect give @e[tag=pe_wnew,tag=!pe_wmount] minecraft:glowing 600 0 true"
        );
        expect(lines.at(-1)).toBe("tag @e[tag=pe_wnew] remove pe_wnew");
        // Every mount is the event's, and goes with the rest at the end.
        expect(waves.wavesCleanup("classic")[0]).toBe("kill @e[tag=pe_mob]");
    });

    it("grows with the defenders at the point: more monsters, more health, harder hits, capped", () => {
        expect(waves.waveEffects(0, 1)).toEqual([]);
        expect(waves.waveEffects(0, 2)).toEqual([{ effect: "absorption", level: 0 }]);
        expect(waves.waveEffects(0, 3)).toEqual([
            { effect: "strength", level: 0 },
            { effect: "absorption", level: 1 }
        ]);
        expect(waves.waveEffects(4, 3)).toEqual([
            { effect: "strength", level: 2 },
            { effect: "resistance", level: 0 },
            { effect: "absorption", level: 1 }
        ]);
        // Never past five defenders' worth.
        expect(waves.waveEffects(0, 40)).toEqual(waves.waveEffects(0, waves.CROWD_CAP));
        expect(waves.waveSize(4, 0, 40)).toBe(waves.waveSize(4, 0, waves.CROWD_CAP));
        const lines = waves.summonWave(point, "classic", 8, 0, 600, { waves: 5, defenders: 3 });
        expect(lines).toContain(
            "effect give @e[tag=pe_wnew,tag=!pe_wmount] minecraft:absorption 600 1 true"
        );
    });

    it("can be decided by the damage dealt at the point instead of the kills", () => {
        const lines = waves.wavesTick(point, "classic", true, true);
        expect(lines.slice(-3)).toEqual([
            "execute as @a run scoreboard players operation @s pe_wdmg = @s pe_whit",
            "execute as @a run scoreboard players operation @s pe_wdmg /= #ten pe_wten",
            "execute as @a[scores={pe_wdmg=1..}] run scoreboard players operation @s pe_score = @s pe_wdmg"
        ]);
        expect(waves.wavesSetup("classic")).toContain("scoreboard players set #ten pe_wten 10");
        const byDamage = {
            ...catalog.newPreset("waves", "w"),
            options: { ...catalog.newPreset("waves", "w").options, winner: "damage" }
        } as catalog.EventPreset;
        expect(catalog.unitOf(byDamage)).toBe("damage");
        expect(catalog.unitOf(catalog.newPreset("waves", "w"))).toBe("kills");
    });

    it("keeps a wave's archers from dropping the bow they were handed, before and after 1.21.5", () => {
        // What each era reads a mob's drop chances from; any other key is ignored.
        const chances = (line: string, modern: boolean): Record<string, string> => {
            if (modern) {
                const found = /drop_chances:\{([^}]*)\}/.exec(line);
                return Object.fromEntries(
                    (found?.[1] ?? "")
                        .split(",")
                        .filter(Boolean)
                        .map((pair) => pair.split(":"))
                );
            }
            const hands = /HandDropChances:\[([^\]]*)\]/.exec(line)?.[1]?.split(",") ?? [];
            return { mainhand: hands[0] ?? "", offhand: hands[1] ?? "" };
        };
        const summons = waves
            .summonWave(point, "undead", 8, 0, 600)
            .filter(
                (line) =>
                    line.includes(" summon minecraft:skeleton ") ||
                    line.includes(" summon minecraft:stray ")
            );
        expect(summons.length).toBeGreaterThan(0);
        for (const line of summons) {
            for (const modern of [false, true]) {
                const read = chances(line, modern);
                expect(read.mainhand).toBe("0.0f");
                expect(read.offhand).toBe("0.0f");
            }
        }
    });

    it("grows with every wave and every defender, never past the cap", () => {
        expect(waves.waveSize(4, 0, 1)).toBe(4);
        expect(waves.waveSize(4, 2, 1)).toBe(8);
        expect(waves.waveSize(4, 0, 3)).toBe(8);
        expect(waves.waveSize(12, 9, 20)).toBe(waves.WAVE_CAP);
        expect(waves.waveEffects(0)).toEqual([]);
        expect(waves.waveEffects(4).map((one) => one.effect)).toEqual(["strength", "resistance"]);
    });

    it("counts kills and hits near the point only while a wave is on", () => {
        const open = waves.wavesTick(point, "classic", true);
        expect(open).toContain(
            "execute in minecraft:overworld positioned 300.5 70 0.5 as @a[distance=..40] run scoreboard players operation @s pe_wkill += @s pe_wk0"
        );
        expect(open.at(-1)).toBe(
            "execute as @a[scores={pe_wkill=1..}] run scoreboard players operation @s pe_score = @s pe_wkill"
        );
        const closed = waves.wavesTick(point, "classic", false);
        expect(closed.some((line) => line.includes("+="))).toBe(false);
        expect(closed).toContain("scoreboard players set @a pe_wk0 0");
    });

    it("by the events data pack, counts only the monsters it summoned", () => {
        // The night's own zombie killed near the point raises the game's
        // `killed` statistic all the same; the pack's count only for `pe_mob`.
        const setup = waves.wavesSetup("classic", true);
        expect(setup).toContain("scoreboard objectives add pe_wkp dummy");
        expect(setup.some((line) => line.includes("minecraft.killed:"))).toBe(false);
        const open = waves.wavesTick(point, "classic", true, false, true);
        expect(open).toContain(
            "execute in minecraft:overworld positioned 300.5 70 0.5 as @a[distance=..40] run scoreboard players operation @s pe_wkill += @s pe_wkp"
        );
        expect(open.some((line) => line.includes("pe_wk0"))).toBe(false);
        expect(open).toContain("scoreboard players set @a pe_wkp 0");
        // Whichever way it counted, everything it made comes back out.
        const cleanup = waves.wavesCleanup("classic");
        expect(cleanup).toContain("scoreboard objectives remove pe_wkp");
        expect(cleanup).toContain("scoreboard objectives remove pe_wk0");
    });

    it("reads how many are left", () => {
        expect(waves.readAlive("Test passed, count: 7")).toBe(7);
        expect(waves.readAlive("Test failed")).toBe(0);
        expect(waves.readAlive("")).toBeNull();
    });

    it("brings strays back onto the point, and draws it without scoring anybody", () => {
        expect(waves.leash(point)).toBe(
            "execute in minecraft:overworld positioned 300.5 70 0.5 as @e[tag=pe_mob,tag=!pe_wrider,distance=24..] run tp @s 300.5 70 0.5"
        );
        const marks = waves.wavesMarks(point);
        expect(marks.some((line) => line.includes("particle minecraft:end_rod"))).toBe(true);
        expect(marks.some((line) => line.includes("scoreboard"))).toBe(false);
    });

    it("takes back every monster and every objective it made, and nothing else", () => {
        const made = waves.wavesSetup("mixed").flatMap((line) => {
            const match = /^scoreboard objectives add (\S+)/.exec(line);
            return match ? [match[1] as string] : [];
        });
        const cleanup = waves.wavesCleanup("mixed");
        expect(cleanup[0]).toBe("kill @e[tag=pe_mob]");
        for (const objective of made)
            expect(cleanup).toContain(`scoreboard objectives remove ${objective}`);
        expect(
            made.every((objective) => objective.startsWith("pe_") && objective.length <= 16)
        ).toBe(true);
    });

    it("lasts as long as its waves can", () => {
        const preset = catalog.newPreset("waves", "w");
        expect(catalog.runMinutes(preset)).toBe(Math.ceil((45 + 5 * 140 + 60) / 60));
        expect(catalog.needsHostileMobs(preset)).toBe(true);
        expect(catalog.needsOverworld(preset)).toBe(true);
    });
});

describe("chunks an event holds", () => {
    it("reads which chunks are already held", () => {
        expect(
            chunks.readForced(
                "3 force loaded chunks were found in minecraft:overworld at: [0, 0], [1, -2], [18, 0]"
            )
        ).toEqual(new Set(["0,0", "1,-2", "18,0"]));
        expect(
            chunks.readForced("No force loaded chunks were found in minecraft:overworld")
        ).toEqual(new Set());
        expect(chunks.readForced("")).toBeNull();
    });

    it("holds only the chunks nobody held before, and lets go of exactly those", () => {
        const around = chunks.chunksAround(300, 0, 32);
        expect(around).toHaveLength(25);
        const mine = chunks.notHeld(around, new Set(["18,0"]));
        expect(mine).toHaveLength(24);
        expect(mine.some((chunk) => chunk.x === 18 && chunk.z === 0)).toBe(false);
        expect(chunks.notHeld(around, null)).toEqual([]);
        expect(chunks.holdChunk({ x: 18, z: -1 })).toBe(
            "execute in minecraft:overworld run forceload add 288 -16"
        );
        expect(chunks.releaseChunk({ x: 18, z: -1 })).toBe(
            "execute in minecraft:overworld run forceload remove 288 -16"
        );
    });
});

describe("a meteor shower", () => {
    const point = { x: 120, y: 64, z: -40 };
    const always = () => 0;

    it("heaps a meteor of the size asked for, of the ores asked for", () => {
        const cells = meteors.meteorCells(point, 6, "precious", Math.random);
        expect(cells).toHaveLength(6);
        expect(cells[0]).toMatchObject({ x: 120, y: 64, z: -40 });
        for (const cell of cells) {
            expect([
                "minecraft:gold_ore",
                "minecraft:lapis_ore",
                "minecraft:diamond_ore",
                "minecraft:emerald_ore"
            ]).toContain(cell.block);
        }
        expect(
            meteors
                .meteorCells(point, 12, "diamond", always)
                .every((cell) => cell.block === "minecraft:diamond_ore")
        ).toBe(true);
        expect(
            new Set(
                meteors
                    .meteorCells(point, 12, "debris", always)
                    .map((cell) => `${cell.x} ${cell.y} ${cell.z}`)
            ).size
        ).toBe(12);
    });

    it("only ever fills air, and only takes back its own ore", () => {
        const block = { x: 121, y: 64, z: -40, block: "minecraft:diamond_ore" };
        expect(meteors.airTest(block)).toBe(
            "execute in minecraft:overworld if block 121 64 -40 minecraft:air"
        );
        expect(meteors.placeBlock(block)).toBe(
            "execute in minecraft:overworld run setblock 121 64 -40 minecraft:diamond_ore keep"
        );
        expect(meteors.removeIfOurs(block)).toBe(
            "execute in minecraft:overworld if block 121 64 -40 minecraft:diamond_ore run setblock 121 64 -40 minecraft:air"
        );
    });

    it("brings the meteors down one after another, never minutes apart", () => {
        const minutes = (count: number) => count * 60_000;
        // Ten over six minutes: one every 27 seconds, the first at once.
        expect(catalog.meteorGap(minutes(6), 10)).toBe(27_000);
        expect(meteors.dueMeteors(0, minutes(6), 10)).toBe(1);
        expect(meteors.dueMeteors(26_999, minutes(6), 10)).toBe(1);
        expect(meteors.dueMeteors(27_000, minutes(6), 10)).toBe(2);
        expect(meteors.dueMeteors(minutes(6), minutes(6), 10)).toBe(10);
        // Four over ten minutes were one every 112 seconds; now never more than 40.
        expect(catalog.meteorGap(minutes(10), 4)).toBe(catalog.METEOR_GAP_MS.most);
        expect(meteors.dueMeteors(120_000, minutes(10), 4)).toBe(4);
        // Thirty over three minutes do not pile up faster than one every 12 seconds.
        expect(catalog.meteorGap(minutes(3), 30)).toBe(catalog.METEOR_GAP_MS.least);
    });

    it("asks once whether a meteor is whole before asking block by block", () => {
        const meteor = {
            x: 1,
            y: 64,
            z: 1,
            blocks: [
                { x: 1, y: 64, z: 1, block: "minecraft:gold_ore" },
                { x: 2, y: 64, z: 1, block: "minecraft:diamond_ore" }
            ]
        };
        expect(meteors.allOurs(meteor)).toBe(
            "execute in minecraft:overworld if block 1 64 1 minecraft:gold_ore if block 2 64 1 minecraft:diamond_ore"
        );
        expect(meteors.allOurs({ ...meteor, blocks: [] })).toBeNull();
        expect(
            meteors.allOurs({
                ...meteor,
                blocks: [{ x: 1, y: 64, z: 1, block: "stone run kill @a" }]
            })
        ).toBeNull();
    });

    it("counts ore mined near a meteor and takes off ore placed near one", () => {
        const lines = meteors.meteorTick([point], "diamond");
        expect(lines.slice(0, 2)).toEqual([
            "scoreboard players add @a pe_mo0 0",
            "scoreboard players add @a pe_mu0 0"
        ]);
        expect(lines).toContain(
            "execute in minecraft:overworld positioned 120.5 64 -39.5 as @a[distance=..10] run scoreboard players operation @s pe_mtot += @s pe_mraw"
        );
        expect(lines).toContain(
            "execute in minecraft:overworld positioned 120.5 64 -39.5 as @a[distance=..20] run scoreboard players operation @s pe_mtot -= @s pe_mused"
        );
        expect(lines).toContain("scoreboard players set @a pe_mo0 0");
        expect(lines.at(-1)).toBe(
            "execute as @a[scores={pe_mtot=1..}] run scoreboard players operation @s pe_score = @s pe_mtot"
        );
        // Before any meteor is down, whatever is mined anywhere is let go.
        expect(
            meteors.meteorTick([], "diamond").some((line) => line.includes("+= @s pe_mraw"))
        ).toBe(false);
    });

    it("takes back exactly its blocks and every objective it made", () => {
        const made = meteors.meteorSetup("common").flatMap((line) => {
            const match = /^scoreboard objectives add (\S+)/.exec(line);
            return match ? [match[1] as string] : [];
        });
        const cleanup = meteors.meteorCleanup(
            [
                {
                    ...point,
                    blocks: [
                        { x: 120, y: 64, z: -40, block: "minecraft:iron_ore" },
                        { x: 121, y: 64, z: -40, block: "minecraft:iron_ore run kill @a" }
                    ]
                }
            ],
            "common"
        );
        expect(cleanup.filter((line) => line.includes("setblock"))).toEqual([
            "execute in minecraft:overworld if block 120 64 -40 minecraft:iron_ore run setblock 120 64 -40 minecraft:air"
        ]);
        for (const objective of made)
            expect(cleanup).toContain(`scoreboard objectives remove ${objective}`);
        expect(
            made.every((objective) => objective.startsWith("pe_") && objective.length <= 16)
        ).toBe(true);
    });
});

// ------------------------------------------------------------------ parkour and spleef

const inside = (box: stage.Volume, volume: stage.Volume) =>
    box.x1 >= volume.x1 &&
    box.x2 <= volume.x2 &&
    box.y1 >= volume.y1 &&
    box.y2 <= volume.y2 &&
    box.z1 >= volume.z1 &&
    box.z2 <= volume.z2;

const overlaps = (left: stage.Volume, right: stage.Volume) =>
    left.x1 <= right.x2 &&
    right.x1 <= left.x2 &&
    left.y1 <= right.y2 &&
    right.y1 <= left.y2 &&
    left.z1 <= right.z2 &&
    right.z1 <= left.z2;

/** The empty edge-to-edge distance between two platforms, level-wise. */
function gapBetween(a: parkour.Platform, b: parkour.Platform): number {
    const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.size, b.x + b.size));
    const dz = Math.max(0, Math.max(a.z, b.z) - Math.min(a.z + a.size, b.z + b.size));
    return Math.hypot(dx, dz);
}

describe("a parkour course", () => {
    const shapes = (["easy", "medium", "hard"] as const).flatMap((difficulty) =>
        [10, 23, 40].flatMap((jumps) =>
            ["a", "b", "c", "d"].map((seed) => ({ difficulty, jumps, seed }))
        )
    );

    it("has the jumps asked for, a checkpoint every few and the finish last", () => {
        for (const { difficulty, jumps, seed } of shapes) {
            const course = parkour.course(
                { place: { mode: "players" }, jumps, difficulty, height: 30 },
                seed,
                { x: 100, z: -40 },
                90
            );
            expect(course.platforms).toHaveLength(jumps + 1);
            expect(course.platforms[0]?.role).toBe("start");
            expect(course.platforms.at(-1)?.role).toBe("finish");
            expect(course.checkpoints.at(-1)).toBe(jumps);
            expect(course.checkpoints.length).toBeGreaterThanOrEqual(
                Math.floor(jumps / parkour.CHECK_EVERY)
            );
        }
    });

    it("only asks for jumps a player can make: a block up or down, or a climb of three", () => {
        const widest = { easy: 2, medium: 2, hard: 3 };
        const widestUp = { easy: 1, medium: 2, hard: 2 };
        for (const { difficulty, jumps, seed } of shapes) {
            const course = parkour.course(
                { place: { mode: "players" }, jumps, difficulty, height: 30 },
                seed,
                { x: 0, z: 0 },
                80
            );
            for (let index = 1; index < course.platforms.length; index += 1) {
                const before = course.platforms[index - 1]!;
                const next = course.platforms[index]!;
                const rise = next.y - before.y;
                // A climb is a ladder or a vine on the block between them.
                if (next.climb) {
                    expect(rise).toBe(3);
                    expect(gapBetween(before, next)).toBe(1);
                    continue;
                }
                expect(rise >= -1 && rise <= 1).toBe(true);
                const gap = gapBetween(before, next);
                expect(gap).toBeGreaterThanOrEqual(1);
                expect(gap).toBeLessThanOrEqual(
                    Math.hypot(rise === 1 ? widestUp[difficulty] : widest[difficulty], 1)
                );
            }
        }
    });

    it("leaves nothing in reach but the next platform, in rows and in a tower", () => {
        for (const shape of ["rows", "tower"] as const)
            for (const { difficulty, jumps, seed } of shapes) {
                const course = parkour.course(
                    { place: { mode: "players" }, jumps, difficulty, height: 30, shapes: [shape] },
                    seed,
                    { x: 0, z: 0 },
                    80
                );
                // A player on any platform can land on the next one, and on no
                // platform past it: nothing of the course can be skipped.
                expect(parkourLayout.skipProblems(course.platforms)).toEqual([]);
            }
    });

    it("leaves head room over every platform and keeps everything in its volume, net at the bottom", () => {
        for (const { difficulty, jumps, seed } of shapes) {
            const course = parkour.course(
                { place: { mode: "players" }, jumps, difficulty, height: 30 },
                seed,
                { x: 7, z: 7 },
                100
            );
            for (const box of course.boxes) {
                expect(inside(box, course.volume)).toBe(true);
                expect(stage.volumeOf(box)).toBeLessThanOrEqual(stage.FILL_LIMIT);
            }
            expect(course.boxes[0]?.block).toBe("minecraft:white_stained_glass");
            expect(course.boxes[0]?.y1).toBe(96);
            course.platforms.forEach((one, index) => {
                const room = {
                    x1: one.x,
                    y1: one.y + 1,
                    z1: one.z,
                    x2: one.x + one.size - 1,
                    y2: one.y + 2,
                    z2: one.z + one.size - 1
                };
                const inTheWay = course.boxes.filter(
                    (box) =>
                        overlaps(box, room) &&
                        !(
                            index === course.platforms.length - 1 &&
                            box.block.endsWith("pressure_plate")
                        )
                );
                expect(inTheWay).toEqual([]);
            });
            // Small enough to sit over a patch of ground a site can be checked for.
            expect(course.reach).toBeLessThanOrEqual(40);
        }
    });

    it("is the same course every time for the same run, centerd over its site", () => {
        const options = {
            place: { mode: "players" as const },
            jumps: 20,
            difficulty: "medium" as const,
            height: 30
        };
        const one = parkour.course(options, "run-1", { x: 500, z: 500 }, 100);
        expect(parkour.course(options, "run-1", { x: 500, z: 500 }, 100)).toEqual(one);
        expect(Math.abs((one.volume.x1 + one.volume.x2) / 2 - 500)).toBeLessThanOrEqual(1);
        expect(Math.abs((one.volume.z1 + one.volume.z2) / 2 - 500)).toBeLessThanOrEqual(1);
        expect(parkour.course(options, "run-2", { x: 500, z: 500 }, 100)).not.toEqual(one);
    });

    it("knows which platform somebody is standing on, and scores a finish above any progress", () => {
        const course = parkour.course(
            { place: { mode: "players" }, jumps: 12, difficulty: "easy", height: 30 },
            "x",
            { x: 0, z: 0 },
            100
        );
        const checkpoint = course.checkpoints[0]!;
        const one = course.platforms[checkpoint]!;
        expect(
            parkour.platformUnder(course, { x: one.x + 1.5, y: one.y + 1, z: one.z + 1.5 })
        ).toBe(checkpoint);
        expect(
            parkour.platformUnder(course, { x: one.x + 1.5, y: one.y - 3, z: one.z + 1.5 })
        ).toBeNull();
        expect(parkour.checkpointsBy(course, checkpoint)).toBe(1);
        const spot = parkour.spotOn(course, 0);
        expect(spot.y).toBe(101);
        expect(parkour.isFinish(parkour.finishScore(95))).toBe(true);
        expect(parkour.finishScore(60)).toBeGreaterThan(parkour.finishScore(95));
        expect(parkour.isFinish(40)).toBe(false);
    });
});

describe("a spleef floor", () => {
    it("is floors of snow stacked one under the other, each walled, a net under the lowest", () => {
        const floor = spleef.arena(
            { place: { mode: "players" }, size: 8, height: 30 },
            { x: 10, z: -20 },
            110
        );
        expect(floor.floors).toEqual([110, 110 - spleef.LAYER_GAP, 110 - 2 * spleef.LAYER_GAP]);
        const snows = floor.boxes.filter((box) => box.block === spleef.FLOOR);
        expect(snows).toHaveLength(spleef.LAYERS);
        const top = snows.find((box) => box.y1 === 110)!;
        expect(top).toMatchObject({ x1: 2, x2: 18, z1: -28, z2: -12, y2: 110 });
        const bottom = floor.floors.at(-1)!;
        expect(floor.boxes[0]).toMatchObject({
            y1: bottom - 4,
            block: "minecraft:white_stained_glass"
        });
        const lights = floor.boxes.filter((box) => box.block === "minecraft:sea_lantern");
        expect(lights).toHaveLength(4 * spleef.LAYERS);
        const walls = floor.boxes.filter(
            (box) =>
                box.block !== spleef.FLOOR &&
                box.block !== "minecraft:sea_lantern" &&
                box !== floor.boxes[0]
        );
        expect(walls).toHaveLength(4 * spleef.LAYERS);
        for (const wall of walls) {
            expect(floor.floors).toContain(wall.y1 - 1);
            expect(wall.y2).toBe(wall.y1 + 2);
            for (const snow of snows) expect(overlaps(wall, snow)).toBe(false);
        }
        for (const box of floor.boxes) expect(inside(box, floor.volume)).toBe(true);
        // Out only through the lowest floor: a fall to the next floor is still in.
        expect(spleef.fell(floor, 111)).toBe(false);
        expect(spleef.fell(floor, 104)).toBe(false);
        expect(spleef.fell(floor, bottom - 2)).toBe(true);
    });

    it("leaves every way on by default, and reads an event saved with one way as that way alone", () => {
        const fresh = catalog.optionsSchemas.spleef.parse({});
        expect(fresh.variants).toEqual(["shovel", "decay", "snowballs"]);
        expect(catalog.optionsSchemas.spleef.parse({ variant: "random" }).variants).toEqual([
            "shovel",
            "decay",
            "snowballs"
        ]);
        expect(catalog.optionsSchemas.spleef.parse({ variant: "decay" }).variants).toEqual([
            "decay"
        ]);
        // Kept in one order, whatever order the screen sent them in, and never none.
        expect(
            catalog.optionsSchemas.spleef.parse({ variants: ["snowballs", "shovel"] }).variants
        ).toEqual(["shovel", "snowballs"]);
        expect(catalog.optionsSchemas.spleef.safeParse({ variants: [] }).success).toBe(false);
    });

    it("draws the same way for a run saved as random before ways could be left out", () => {
        // What `variantFor(runId, "random")` drew: the first of all three shuffled.
        const before = (runId: string) =>
            trivia.shuffled(spleef.VARIANTS, trivia.seeded(`${runId}-spleef`))[0];
        for (let index = 0; index < 40; index += 1)
            expect(spleef.variantFor(`r${index}`)).toBe(before(`r${index}`));
    });

    it("plays one of three ways, the same after a restart, and the decay game only eats its own snow", () => {
        const drawn = new Set(
            Array.from({ length: 40 }, (_, index) => spleef.variantFor(`r${index}`))
        );
        expect([...drawn].sort()).toEqual([...spleef.VARIANTS].sort());
        expect(spleef.variantFor("r1")).toBe(spleef.variantFor("r1"));
        // Only the ways the event leaves on are ever drawn.
        const twoWays = new Set(
            Array.from({ length: 40 }, (_, index) =>
                spleef.variantFor(`r${index}`, ["shovel", "decay"])
            )
        );
        expect([...twoWays].sort()).toEqual(["decay", "shovel"]);
        for (let index = 0; index < 20; index += 1)
            expect(spleef.variantFor(`r${index}`, ["snowballs"])).toBe("snowballs");
        const floor = spleef.arena(
            { place: { mode: "players" }, size: 5, height: 30 },
            { x: 0, z: 0 },
            100
        );
        const lines = spleef.decayLines(floor, "pe_in");
        // Last look's red snow gone, only red snow, only on the floors.
        for (const at of floor.floors)
            expect(lines).toContain(
                `execute in minecraft:overworld run fill -5 ${at} -5 5 ${at} 5 minecraft:air replace ${spleef.WARN}`
            );
        // Only the arena's snow under somebody in it turns red.
        expect(lines.at(-1)).toContain(`as @a[tag=pe_in] at @s if block ~ ~-1 ~ ${spleef.FLOOR}`);
        expect(lines.at(-1)).toContain(`run setblock ~ ~-1 ~ ${spleef.WARN}`);
        expect(spleef.warnBoxes(floor).map((box) => box.y1)).toEqual([...floor.floors]);
        expect(stage.ARENA_BLOCKS).toContain(spleef.WARN);
    });

    it("in the snowball game, ships a data pack that breaks only the arena's snow a snowball is about to hit", () => {
        const files = snowballPack.packFiles();
        const meta = JSON.parse(files.get("pack.mcmeta")!) as { pack: Record<string, unknown> };
        // From 1.13 to the newest: the old field, the 1.20.2 range and the 1.21.9 pair agree.
        expect(meta.pack).toMatchObject({
            pack_format: 4,
            supported_formats: [4, 1000],
            min_format: 4,
            max_format: 1000
        });
        // Both spellings of the function folders, the same functions in each.
        for (const folder of ["functions", "function"]) {
            expect(JSON.parse(files.get(`data/minecraft/tags/${folder}/tick.json`)!)).toEqual({
                values: [
                    "polaris:spleef/tick",
                    "polaris:tntrun/tick",
                    "polaris:dropper/tick",
                    "polaris:boat/tick"
                ]
            });
            for (const name of ["tick", "ball", "near", "step", "probe", "hit"])
                expect(files.get(`data/polaris/${folder}/spleef/${name}.mcfunction`)).toBe(
                    files.get(`data/polaris/functions/spleef/${name}.mcfunction`)
                );
        }
        const fn = (name: string) => files.get(`data/polaris/function/spleef/${name}.mcfunction`)!;
        // Off unless switched on, and only snowballs in the overworld.
        expect(fn("tick")).toBe(
            "execute if score #on polaris_spleef matches 1 in minecraft:overworld as @e[type=minecraft:snowball,distance=0..] run function polaris:spleef/ball\n"
        );
        // Followed only close round the box; gravity is taken off before it is
        // followed, and a tick's flight is tried a quarter further than it goes.
        expect(fn("ball")).toContain(
            "if score #px polaris_spleef >= #nx1 polaris_spleef if score #px polaris_spleef <= #nx2 polaris_spleef"
        );
        expect(fn("near")).toContain("scoreboard players remove #my polaris_spleef 2\n");
        expect(fn("near")).toContain("scoreboard players set #k polaris_spleef 10\n");
        expect(fn("near")).not.toContain("#k polaris_spleef 11");
        // A point is tried only inside the box, and only the arena's snow is broken.
        expect(fn("step")).toContain(
            "if score #cy polaris_spleef >= #y1 polaris_spleef if score #cy polaris_spleef <= #y2 polaris_spleef"
        );
        expect(fn("probe")).toContain(
            `if block ~ ~ ~ ${spleef.FLOOR} run function polaris:spleef/hit`
        );
        expect(fn("hit").split("\n")).toEqual([
            "setblock ~ ~ ~ minecraft:air",
            "playsound minecraft:block.snow.break block @a ~ ~ ~ 1 1",
            "scoreboard players set #hit polaris_spleef 1",
            "kill @s",
            ""
        ]);
        // No line in any function is longer than a command may be, and none is a reload.
        for (const [path, content] of files)
            if (path.endsWith(".mcfunction"))
                for (const line of content.split("\n")) {
                    expect(line.length).toBeLessThan(32_500);
                    expect(line).not.toMatch(/^(minecraft:)?reload\b/);
                }
    });

    it("arms the snowball pack for one arena's box, and only that arena's end switches it off", () => {
        const floor = spleef.arena(
            { place: { mode: "players" }, size: 5, height: 30 },
            { x: -3, z: 40 },
            100
        );
        const lines = snowballPack.armLines(floor);
        const bottom = floor.floors.at(-1)!;
        // Every floor, edge to edge, in 64ths of a block; the switch goes on last.
        expect(lines).toContain(`scoreboard players set #x1 polaris_spleef ${(-3 - 5) * 64}`);
        expect(lines).toContain(
            `scoreboard players set #x2 polaris_spleef ${(-3 + 5 + 1) * 64 - 1}`
        );
        expect(lines).toContain(`scoreboard players set #y1 polaris_spleef ${bottom * 64}`);
        expect(lines).toContain(`scoreboard players set #y2 polaris_spleef ${101 * 64 - 1}`);
        expect(lines).toContain(`scoreboard players set #z1 polaris_spleef ${35 * 64}`);
        expect(lines).toContain(`scoreboard players set #z2 polaris_spleef ${46 * 64 - 1}`);
        expect(lines).toContain(`scoreboard players set #nx1 polaris_spleef ${(-3 - 5 - 3) * 64}`);
        expect(lines).toContain(
            `scoreboard players set #ny2 polaris_spleef ${(100 + 3 + 1) * 64 - 1}`
        );
        expect(lines).toContain("scoreboard players set #steps polaris_spleef 8");
        expect(lines.at(-1)).toBe("scoreboard players set #on polaris_spleef 1");
        expect(lines.indexOf("scoreboard players set #on polaris_spleef 0")).toBeLessThan(
            lines.findIndex((line) => line.startsWith("scoreboard players set #x1"))
        );
        expect(lines.find((line) => line.includes("summon"))).toContain(
            'summon minecraft:armor_stand -2.5 102 40.5 {Tags:["polaris_spleef_probe"]'
        );
        // Stopped only while the switch is still this arena's.
        const ours = `if score #x1 polaris_spleef matches ${-8 * 64} if score #y1 polaris_spleef matches ${bottom * 64} if score #z1 polaris_spleef matches ${35 * 64}`;
        expect(snowballPack.stopLines(floor.boxes)).toEqual([
            `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=polaris_spleef_probe]`,
            `execute ${ours} run scoreboard players set #on polaris_spleef 0`
        ]);
        // Nothing for an arena with no snow.
        expect(
            snowballPack.stopLines(floor.boxes.filter((box) => box.block !== spleef.FLOOR))
        ).toEqual([]);
        expect(
            snowballPack.packEnabled(
                "There are 2 data pack(s) enabled: [vanilla (built-in)], [file/polaris-events (world)]"
            )
        ).toBe(true);
        expect(
            snowballPack.packEnabled("There are 1 data pack(s) enabled: [vanilla (built-in)]")
        ).toBe(false);
    });
    it("spreads players over the snow, never onto a wall", () => {
        const floor = spleef.arena(
            { place: { mode: "players" }, size: 5, height: 30 },
            { x: 0, z: 0 },
            100
        );
        const spots = spleef.spots(floor, 12);
        expect(spots).toHaveLength(12);
        for (const spot of spots) {
            expect(Math.abs(spot.x - 0.5)).toBeLessThanOrEqual(5);
            expect(Math.abs(spot.z - 0.5)).toBeLessThanOrEqual(5);
            expect(spot.y).toBe(101);
        }
    });
});

describe("what an arena sends", () => {
    const box: stage.Box = {
        x1: 1,
        y1: 100,
        z1: 2,
        x2: 3,
        y2: 100,
        z2: 4,
        block: "minecraft:snow_block"
    };

    it("builds into air only, and takes down only its own block inside its own box", () => {
        expect(stage.buildLine(box)).toBe(
            "execute in minecraft:overworld run fill 1 100 2 3 100 4 minecraft:snow_block keep"
        );
        expect(stage.removeLine(box)).toBe(
            "execute in minecraft:overworld run fill 1 100 2 3 100 4 minecraft:air replace minecraft:snow_block"
        );
    });

    it("proves a volume empty with a block nobody builds with, a slab at a time", () => {
        const probes = stage.probeBoxes({ x1: 0, y1: 60, z1: 0, x2: 59, y2: 99, z2: 59 });
        expect(probes.every((one) => one.block === "minecraft:structure_void")).toBe(true);
        expect(probes.every((one) => stage.volumeOf(one) <= stage.FILL_LIMIT)).toBe(true);
        expect(probes.reduce((sum, one) => sum + stage.volumeOf(one), 0)).toBe(60 * 40 * 60);
        expect(probes[0]?.y1).toBe(60);
        expect(probes.at(-1)?.y2).toBe(99);
    });

    it("reads how many blocks a fill changed, and never mistakes a refusal for none", () => {
        expect(stage.fillCount("Successfully filled 25 block(s)")).toBe(25);
        expect(stage.fillCount("Successfully filled 1 blocks")).toBe(1);
        expect(stage.fillCount("No blocks were filled")).toBe(0);
        expect(stage.fillCount("That position is not loaded")).toBeNull();
        expect(
            stage.fillCount(
                "Too many blocks in the specified area (maximum 32768, specified 40000)"
            )
        ).toBeNull();
        expect(stage.fillCount("")).toBeNull();
    });

    it("hears join and leave in either language, and nothing else", () => {
        const log = [
            "[20:00:01] [Server thread/INFO]: <Ana> join",
            "[20:00:02] [Server thread/INFO]: <Ben> !Unirse",
            "[20:00:03] [Server thread/INFO]: [Not Secure] <Cy> Join.",
            "[20:00:04] [Server thread/INFO]: <Dee> join me later",
            "[20:00:05] [Server thread/INFO]: <Ana> salir",
            "[20:00:06] [Server thread/INFO]: Eve joined the game"
        ].join("\n");
        expect(stage.readCalls(log)).toEqual([
            { name: "Ana", call: "join" },
            { name: "Ben", call: "join" },
            { name: "Cy", call: "join" },
            { name: "Ana", call: "leave" }
        ]);
    });

    it("keeps where a player was, and leaves out anybody in creative or spectator", () => {
        const where = [
            { name: "Ana", x: 1.5, y: 64, z: -2.25 },
            { name: "Ben", x: 0, y: 70, z: 0 }
        ];
        const facing = new Map([["Ana", { yaw: 45, pitch: 10 }]]);
        const dims = new Map([["Ana", "minecraft:the_nether"]]);
        const modes = new Map([
            ["Ana", 0],
            ["Ben", 1]
        ]);
        expect(stage.savedFrom("ana", where, facing, dims, modes)).toEqual({
            name: "Ana",
            dimension: "minecraft:the_nether",
            x: 1.5,
            y: 64,
            z: -2.25,
            yaw: 45,
            pitch: 10,
            mode: "survival",
            stash: null
        });
        expect(stage.savedFrom("Ben", where, facing, dims, modes)).toBeNull();
        expect(stage.savedFrom("Cy", where, facing, dims, modes)).toBeNull();
        // A world that could not be read is no world to send anybody back to.
        expect(stage.savedFrom("Ana", where, facing, new Map(), modes)).toBeNull();
    });

    it("sends a player back exactly where they were, and takes only what the event gave", () => {
        const saved: stage.Saved = {
            name: "Ana",
            dimension: "minecraft:the_nether",
            x: 1.5,
            y: 64,
            z: -2.25,
            yaw: 45,
            pitch: 10,
            mode: "adventure"
        };
        expect(stage.returnLine(saved)).toBe(
            "execute in minecraft:the_nether run tp Ana 1.500 64.000 -2.250 45.0 10.0"
        );
        const after = stage.afterReturnLines(saved, "components", "&7Back");
        expect(after).toContain("clear Ana *[minecraft:custom_data={polaris_event:1b}]");
        expect(after).toContain("gamemode adventure Ana");
        expect(after).toContain("tag Ana remove pe_in");
        expect(after).toContain("effect give Ana minecraft:resistance 10 4 true");
        expect(stage.clearMarked("Ana", "nbt")).toEqual([
            "clear Ana minecraft:iron_shovel{polaris_event:1b}",
            "clear Ana minecraft:snowball{polaris_event:1b}",
            "clear Ana minecraft:oak_boat{polaris_event:1b}"
        ]);
        expect(stage.markedSnowballs("Ana", "components", 16)).toEqual([
            "clear Ana minecraft:snowball[minecraft:custom_data={polaris_event:1b}]",
            "give Ana minecraft:snowball[minecraft:custom_data={polaris_event:1b}] 16"
        ]);
        expect(stage.returned("Teleported Ana to 1.5, 64.0, -2.25")).toBe(true);
        expect(stage.returned("No entity was found")).toBe(false);
    });

    it("brings a player in protected, in adventure mode, and tagged", () => {
        expect(stage.admitLines("Ana", { x: 10.5, y: 101, z: -3.5, yaw: -90 })).toEqual([
            "effect give Ana minecraft:resistance 10 4 true",
            "tag Ana add pe_in",
            "execute in minecraft:overworld run tp Ana 10.500 101.000 -3.500 -90.0 0.0",
            "gamemode adventure Ana"
        ]);
    });

    it("marks the shovel it hands out, in the syntax of each era", () => {
        const modern = stage.markedShovel("Ana", "components");
        expect(modern).toContain("minecraft:custom_data={polaris_event:1b}");
        expect(modern).toContain('minecraft:can_break={blocks:"minecraft:snow_block"}');
        expect(modern).toContain("correct_for_drops:false");
        // It lasts the whole game, however much snow is dug.
        expect(modern).toContain("minecraft:unbreakable={}");
        expect(stage.markedShovel("Ana", "nbt")).toBe(
            'give Ana minecraft:iron_shovel{polaris_event:1b,CanDestroy:["minecraft:snow_block"],Unbreakable:1b} 1'
        );
    });

    it("lets anything that is not a player float down from it, never fall", () => {
        const bounds = stage.boundsOf([box, { ...box, x1: -4, y1: 96, y2: 96 }])!;
        expect(bounds).toEqual({ x1: -4, y1: 96, z1: 2, x2: 3, y2: 103, z2: 4 });
        expect(stage.floatDown(bounds, 60)).toBe(
            "execute in minecraft:overworld run effect give @e[type=!player,x=-4,y=96,z=2,dx=7,dy=7,dz=2] minecraft:slow_falling 60 0 true"
        );
        expect(stage.boundsOf([])).toBeNull();
    });

    it("keeps a run's leftovers apart, and forgets them once nothing is left", () => {
        expect(stage.leftoverOf("r", null)).toBeNull();
        expect(stage.leftoverOf("r", stage.EMPTY_STAGE)).toBeNull();
        const left = stage.leftoverOf("r", { ...stage.EMPTY_STAGE, boxes: [box] })!;
        expect(stage.withLeftover([], left)).toEqual([left]);
        expect(stage.withLeftover([left], { ...left, boxes: [] })).toEqual([
            { ...left, boxes: [] }
        ]);
        expect(stage.withLeftover([left], null)).toEqual([left]);
    });

    it("says every line players read without asking for a game variable", () => {
        const lines = (["en", "es"] as const).flatMap((language) => [
            messages.joinHint(language),
            messages.joinedYou(language),
            messages.joinedBar(3, language),
            messages.notEnoughJoined(1, 2, language),
            messages.parkourBar(1, 3, 7, 20, language),
            messages.finishedLine("Ana", "1:02", 1, language),
            messages.spleefOut("Ben", 2, language),
            messages.spleefBar(2, language),
            messages.lastStanding("Ana", language)
        ]);
        for (const line of lines) expect(line).not.toMatch(/[{}]/);
    });
});

// ------------------------------------------------------------------ arenas

type TestBox = { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number };

const insideOf = (outer: TestBox) => (box: TestBox) =>
    box.x1 >= outer.x1 &&
    box.x2 <= outer.x2 &&
    box.y1 >= outer.y1 &&
    box.y2 <= outer.y2 &&
    box.z1 >= outer.z1 &&
    box.z2 <= outer.z2;

const ANA = {
    name: "Ana",
    uuid: [1, -2, 3, 4],
    dimension: "minecraft:the_nether",
    x: 10.25,
    y: 64,
    z: -3.5,
    yaw: 90,
    pitch: 10,
    gamemode: "survival" as const,
    side: 0,
    away: true
};

describe("an arena is built only into air and taken down only where it is ours", () => {
    it("reads join in either language, and nothing else", () => {
        expect(arena.wantsToJoin("join")).toBe(true);
        expect(arena.wantsToJoin(" Unirse! ")).toBe(true);
        expect(arena.wantsToJoin("!join")).toBe(true);
        expect(arena.wantsToJoin("i will join later")).toBe(false);
        expect(
            chatLines(
                "[20:00:05] [Server thread/INFO]: <Ana> join\n[20:00:06] [Server thread/INFO]: Ben joined the game\n"
            )
        ).toEqual([{ name: "Ana", text: "join" }]);
    });

    it("counts what is not air in a box by comparing it with itself", () => {
        const box = { x1: 0, y1: 100, z1: 0, x2: 16, y2: 107, z2: 22 };
        expect(arena.solidCount(box)).toBe(
            "execute in minecraft:overworld if blocks 0 100 0 16 107 22 0 100 0 masked"
        );
        expect(arena.readCount("Test passed, count: 0")).toBe(0);
        expect(arena.readCount("Test passed, count: 12")).toBe(12);
        expect(arena.readCount("That position is not loaded")).toBe("unloaded");
        expect(arena.readCount("That position is out of this world!")).toBeNull();
    });

    it("cuts a box too big for one command into pieces that cover it exactly", () => {
        const box = { x1: 0, y1: 0, z1: 0, x2: 64, y2: 17, z2: 48 };
        const pieces = arena.slices(box);
        expect(pieces.length).toBeGreaterThan(1);
        expect(pieces.every((piece) => arena.volume(piece) <= arena.VOLUME_MAX)).toBe(true);
        expect(pieces.reduce((sum, piece) => sum + arena.volume(piece), 0)).toBe(arena.volume(box));
    });

    it("builds a duel arena with keep only, inside its own box", () => {
        const box = duel.duelBox({ x: 100, z: 200 }, 100);
        const fills = duel.duelFills(box);
        expect(fills.every((one) => insideOf(box)(one.box))).toBe(true);
        const lines = fills.map((one) => arena.fillKeep(one.box, one.block));
        expect(
            lines.every(
                (line) =>
                    line.startsWith("execute in minecraft:overworld run fill ") &&
                    line.endsWith(" keep")
            )
        ).toBe(true);
        expect(new Set(fills.map((one) => one.block))).toEqual(new Set(duel.DUEL_BLOCKS));
        // A rim round the floor and a post of light at each corner, inside the walls' own line.
        expect(fills.filter((one) => one.block === "minecraft:sea_lantern")).toHaveLength(4);
        // Everybody stands on its glass, in its air.
        for (const side of [0, 1]) {
            for (let index = 0; index < 8; index += 1) {
                const spot = duel.sideSpot(box, side, index);
                expect(spot.y).toBe(box.y1 + 2);
                expect(spot.x).toBeGreaterThan(box.x1);
                expect(spot.x).toBeLessThan(box.x2);
                expect(spot.z).toBeGreaterThan(box.z1);
                expect(spot.z).toBeLessThan(box.z2);
            }
        }
    });

    it("takes it down by replacing only its own kinds of block with air, in its own box", () => {
        const box = duel.duelBox({ x: 100, z: 200 }, 100);
        expect(arena.teardown({ box, blocks: duel.DUEL_BLOCKS })).toEqual(
            duel.DUEL_BLOCKS.map(
                (block) =>
                    `execute in minecraft:overworld run fill 92 100 189 108 107 211 minecraft:air replace ${block}`
            )
        );
        // A block name that could carry a second command is never sent.
        expect(arena.teardown({ box, blocks: ["minecraft:barrier run say hi"] })).toEqual([]);
    });

    it("lays out build plots in their own cells, the glass floor inside the walls", () => {
        const box = build.platformBox({ x: 0, z: 0 }, 100, 5, 11);
        const fills = build.platformFills(box, 5, 11);
        expect(fills.every((one) => insideOf(box)(one.box))).toBe(true);
        expect(fills.filter((one) => one.block === build.FLOOR)).toHaveLength(5);
        const spots = [0, 1, 2, 3, 4].map((index) => build.plotSpot(box, index, 11, 5));
        expect(new Set(spots.map((spot) => `${spot.x},${spot.z}`)).size).toBe(5);
        for (const spot of spots) {
            expect(spot.y).toBe(box.y1 + 2);
            expect(arena.contains(box, spot)).toBe(true);
        }
        // Twelve of the largest still fit the commands, in pieces.
        const biggest = build.platformBox({ x: 0, z: 0 }, 100, build.MAX_PLOTS, 15);
        expect(
            arena.slices(biggest).every((piece) => arena.volume(piece) <= arena.VOLUME_MAX)
        ).toBe(true);
    });
});

describe("the kit is marked, and only it is taken back", () => {
    it("marks it with item components from 1.20.5 and a tag before", () => {
        expect(arena.giveMarked("Ana", "minecraft:stone_sword", 1, "components")).toBe(
            "give Ana minecraft:stone_sword[minecraft:custom_data={polaris_event:1b}] 1"
        );
        expect(arena.giveMarked("Ana", "minecraft:stone_sword", 1, "tag")).toBe(
            "give Ana minecraft:stone_sword{polaris_event:1b} 1"
        );
        expect(arena.clearMarked("Ana", "minecraft:shield", "components")).toBe(
            "clear Ana minecraft:shield[minecraft:custom_data={polaris_event:1b}]"
        );
        expect(arena.clearMarked("Ana", "minecraft:shield", "tag")).toBe(
            "clear Ana minecraft:shield{polaris_event:1b}"
        );
    });

    it("never clears an item without the marker, and sends the player back exactly", () => {
        for (const marker of ["components", "tag"] as const) {
            const lines = arena.homeward(ANA, marker, build.KIT_IDS);
            const clears = lines.filter((line) => line.startsWith("clear "));
            expect(clears).toHaveLength(build.KIT_IDS.length);
            expect(clears.every((line) => line.includes("polaris_event:1b"))).toBe(true);
            // Fall-proof first; their game mode only once home.
            expect(lines.slice(0, 2)).toEqual([
                "effect give Ana minecraft:slow_falling 10 0 true",
                "effect give Ana minecraft:resistance 10 4 true"
            ]);
            expect(lines.some((line) => line.startsWith("gamemode "))).toBe(false);
            expect(arena.homeMode(ANA)).toBe("gamemode survival Ana");
        }
        expect(arena.sendHome(ANA)).toBe(
            "execute in minecraft:the_nether run tp Ana 10.250 64.000 -3.500 90.0 10.0"
        );
        expect(arena.wentHome("Teleported Ana to 10.25, 64.0, -3.5")).toBe(true);
        expect(arena.wentHome("No player was found")).toBe(false);
        expect(arena.commandable(ANA)).toBe(true);
        expect(arena.commandable({ ...ANA, dimension: "minecraft:x run op Bob" })).toBe(false);
    });

    it("lets the kit's glass go only on the plot and on itself, and its brush break only the glass", () => {
        for (const marker of ["components", "tag"] as const) {
            const lines = build.kitCommands("Ana", marker);
            expect(lines).toHaveLength(build.KIT_BLOCKS.length + 1);
            expect(lines.every((line) => commandBytes(line) <= COMMAND_BYTES_MAX)).toBe(true);
            // The brush first, so it lands in the hotbar; the glass after it.
            const glass = lines[1]!;
            expect(glass).toContain(
                marker === "components" ? "minecraft:can_place_on={blocks:[" : "CanPlaceOn:["
            );
            expect(glass).toContain(`"${build.FLOOR}"`);
            const brush = lines[0]!;
            expect(brush).toContain(
                marker === "components" ? "minecraft:can_break={blocks:[" : "CanDestroy:["
            );
            expect(brush).not.toContain(`"${build.FLOOR}"`);
        }
        expect(build.KIT_BLOCKS).not.toContain(build.FLOOR);
    });

    it("builds each round in one material drawn for it, the same after a restart", () => {
        const drawn = new Set(
            Array.from({ length: 60 }, (_, index) => build.paletteFor(`run-${index}`))
        );
        expect(drawn.size).toBeGreaterThan(3);
        expect(build.paletteFor("run-7")).toBe(build.paletteFor("run-7"));
        for (const palette of Object.keys(build.PALETTES) as build.Palette[]) {
            const blocks = build.PALETTES[palette].blocks;
            const lines = build.kitCommands("Ana", "components", palette);
            expect(lines).toHaveLength(blocks.length + 1);
            expect(lines.length).toBeLessThanOrEqual(36);
            expect(lines.every((line) => commandBytes(line) <= COMMAND_BYTES_MAX)).toBe(true);
            // The brush breaks this set and nothing else; all of it is taken back and cleared.
            for (const id of blocks) {
                expect(lines[0]).toContain(`"${id}"`);
                expect(build.KIT_IDS).toContain(id);
                expect(build.PLATFORM_BLOCKS).toContain(id);
            }
            expect(blocks).not.toContain(build.FLOOR);
        }
        expect(build.kitCommands("Ana", "tag", "wool")[1]).toContain("minecraft:white_wool");
    });

    it("keeps what a player drops theirs, and sends it after them", () => {
        const box = { x1: 0, y1: 100, z1: 0, x2: 16, y2: 107, z2: 22 };
        expect(arena.keepThrown(box)[0]).toBe(
            "execute in minecraft:overworld as @e[type=minecraft:item,x=0,y=100,z=0,dx=16,dy=7,dz=22] if data entity @s Thrower run data modify entity @s Owner set from entity @s Thrower"
        );
        expect(arena.sendThrown(box, ANA)).toBe(
            "execute in minecraft:overworld as @e[type=minecraft:item,x=0,y=100,z=0,dx=16,dy=7,dz=22,nbt={Thrower:[I;1,-2,3,4]}] run tp @s Ana"
        );
        expect(arena.killMarkedDrops(box, "components")).toContain(
            'nbt={Item:{components:{"minecraft:custom_data":{polaris_event:1b}}}}'
        );
        expect(arena.killMarkedDrops(box, "tag")).toContain("nbt={Item:{tag:{polaris_event:1b}}}");
        // What a broken block let fall: never the kit, never anything thrown.
        expect(arena.killBrokenDrops(box, "components")).toBe(
            'execute in minecraft:overworld as @e[type=minecraft:item,x=0,y=100,z=0,dx=16,dy=7,dz=22,nbt=!{Item:{components:{"minecraft:custom_data":{polaris_event:1b}}}}] unless data entity @s Thrower run kill @s'
        );
        expect(arena.killBrokenDrops(box, "tag")).toContain("nbt=!{Item:{tag:{polaris_event:1b}}}");
    });

    it("reads each player's game mode and id", () => {
        expect(
            arena.readGamemodes(
                "Ana has the following entity data: 0\nBen has the following entity data: 1"
            )
        ).toEqual(
            new Map([
                ["Ana", "survival"],
                ["Ben", "creative"]
            ])
        );
        expect(arena.readUuids("Ana has the following entity data: [I; 1, -2, 3, 4]")).toEqual(
            new Map([["Ana", [1, -2, 3, 4]]])
        );
    });
});

describe("a team duel and a build battle", () => {
    it("puts a player on a side's team only when they are on none", () => {
        expect(duel.joinTeam("Ana", 1)).toBe(
            "execute if entity @a[name=Ana,team=] run team join pe_blue Ana"
        );
        const setup = duel.duelSetup(["Red", "Blue"]);
        expect(setup).toContain("team modify pe_red friendlyFire false");
        expect(setup).toContain("scoreboard objectives add pe_hp health");
        expect(commands.cleanup(preset("team-duel"), null)).toEqual(
            expect.arrayContaining(duel.duelTeardown())
        );
    });

    it("credits a real kill first, then the rival who struck last", () => {
        const now = 100_000;
        expect(
            duel.creditFor(["Ben", "Cy"], new Map([["Cy", 1]]), new Map([["Ben", now]]), now)
        ).toBe("Cy");
        expect(
            duel.creditFor(
                ["Ben", "Cy"],
                new Map(),
                new Map([
                    ["Ben", now - 4_000],
                    ["Cy", now - 1_000]
                ]),
                now
            )
        ).toBe("Cy");
        expect(
            duel.creditFor(["Ben"], new Map(), new Map([["Ben", now - 20_000]]), now)
        ).toBeNull();
    });

    it("takes one vote per player, never for their own plot", () => {
        const owners = new Map([
            [1, "Ana"],
            [2, "Ben"]
        ]);
        let votes: Record<string, string> = {};
        const cast = (voter: string, plot: number) => {
            const result = build.castVote(votes, voter, plot, owners);
            votes = result.votes;
            return result.outcome;
        };
        expect(cast("Ana", 1)).toBe("own");
        expect(cast("Ana", 2)).toBe("counted");
        expect(cast("ana", 2)).toBe("again");
        expect(cast("Cy", 7)).toBe("none");
        expect(cast("Cy", 1)).toBe("counted");
        expect(build.countVotes(votes)).toEqual(
            new Map([
                ["Ben", 1],
                ["Ana", 1]
            ])
        );
        expect(build.readVote("#3")).toBe(3);
        expect(build.readVote(" 12 ")).toBe(12);
        expect(build.readVote("plot 3")).toBeNull();
    });

    it("draws the same theme for the same run, in the players' language", () => {
        const options = catalog.optionsSchemas["build-battle"].parse({});
        const english = build.themeFor(options, "run-1", "en");
        expect(build.themeFor(options, "run-1", "en")).toBe(english);
        expect(build.THEMES.find((one) => one.en === english)?.es).toBe(
            build.themeFor(options, "run-1", "es")
        );
        const mine = catalog.optionsSchemas["build-battle"].parse({
            themeMode: "mine",
            themes: ["Our town"]
        });
        expect(build.themeFor(mine, "run-1", "en")).toBe("Our town");
        expect(
            catalog.optionsSchemas["build-battle"].safeParse({ themeMode: "mine", themes: [] })
                .success
        ).toBe(false);
        expect(
            catalog.optionsSchemas["build-battle"].safeParse({ themes: ["{player}"] }).success
        ).toBe(false);
    });

    it("gives a join event time to type join, and a build battle its vote", () => {
        const settings = catalog.settingsSchema.parse({ countdownSeconds: 0 });
        expect(catalog.countdownSecondsFor(preset("team-duel"), settings)).toBe(
            catalog.JOIN_SECONDS
        );
        expect(catalog.countdownSecondsFor(preset("fishing"), settings)).toBe(0);
        expect(catalog.runMinutes({ ...preset("build-battle"), minutes: 5 })).toBe(6);
        expect(catalog.needsPvp(preset("team-duel"))).toBe(true);
        expect(catalog.needsPvp(preset("build-battle"))).toBe(false);
        for (const kind of ["team-duel", "build-battle"] as const) {
            expect(messages.rules(kind, "es")).not.toBe(messages.rules(kind, "en"));
            expect(messages.kindName(kind, "es").length).toBeGreaterThan(0);
        }
    });
});

describe("reading scores the way a real server answers", () => {
    it("takes the objective's display name in the brackets, not its id", () => {
        // What a real server answered at the end of a blood moon: the panel's title.
        const output =
            "DINNERBONE has 73 [Blood moon]PlayerOne has 47 [Blood moon]Grumm has 0 [Blood moon]";
        expect([...commands.readScores(output)]).toEqual([
            ["DINNERBONE", 73],
            ["PlayerOne", 47],
            ["Grumm", 0]
        ]);
        expect([...commands.readScores("Ana has 5 [Luna de sangre]\nBen has 2 [pe_hurt]")]).toEqual(
            [
                ["Ana", 5],
                ["Ben", 2]
            ]
        );
    });
});

describe("a chain of conditions over RCON", () => {
    it("reads silence as a chain that did not hold, and anything said as something said", () => {
        expect(commands.silent("")).toBe(true);
        expect(commands.silent("\u001b[0m \n")).toBe(true);
        expect(commands.silent("Test passed \u001b[0m")).toBe(false);
        expect(commands.silent("That position is not loaded")).toBe(false);
    });
});
describe("arming what an event summons", () => {
    it("hands a blood moon's skeletons their bows, which they never drop", () => {
        const lines = commands.wave({ intensity: "high", creepers: false }, 0);
        const summons = lines.filter((line) => line.includes(" summon minecraft:skeleton "));
        expect(summons.length).toBeGreaterThan(0);
        for (const line of summons) {
            expect(line).toContain("HandDropChances:[0.0f,0.0f]");
            expect(line).toContain("drop_chances:{mainhand:0.0f");
        }
        const armed = lines.indexOf(
            "item replace entity @e[tag=pe_new,type=minecraft:skeleton] weapon.mainhand with minecraft:bow"
        );
        expect(armed).toBeGreaterThan(-1);
        expect(lines).toContain(
            "replaceitem entity @e[tag=pe_new,type=minecraft:skeleton] weapon.mainhand minecraft:bow"
        );
        // After the spread, before the tag that finds them comes off.
        expect(armed).toBeGreaterThan(lines.findIndex((line) => line.includes("spreadplayers")));
        expect(armed).toBeLessThan(lines.indexOf("tag @e[tag=pe_new] remove pe_new"));
    });

    it("names the weapon of every mob that needs one, and nothing for the rest", () => {
        expect(commands.armLines("tag=x", ["zombie", "spider", "creeper"])).toEqual([]);
        const archers = commands.armLines("tag=x", [
            "stray",
            "bogged",
            "pillager",
            "wither_skeleton"
        ]);
        expect(archers).toContain(
            "item replace entity @e[tag=x,type=minecraft:stray] weapon.mainhand with minecraft:bow"
        );
        expect(archers).toContain(
            "item replace entity @e[tag=x,type=minecraft:bogged] weapon.mainhand with minecraft:bow"
        );
        expect(archers).toContain(
            "item replace entity @e[tag=x,type=minecraft:pillager] weapon.mainhand with minecraft:crossbow"
        );
        expect(archers).toContain(
            "replaceitem entity @e[tag=x,type=minecraft:wither_skeleton] weapon.mainhand minecraft:stone_sword"
        );
    });
});

describe("pointing the way", () => {
    it("draws the arrow from where a player looks", () => {
        // Looking south (yaw 0): south is ahead, west to the right, east to the left.
        const at = { x: 0, z: 0 };
        expect(commands.arrowTo(at, 0, { x: 0, z: 10 })).toBe("↑");
        expect(commands.arrowTo(at, 0, { x: -10, z: 0 })).toBe("→");
        expect(commands.arrowTo(at, 0, { x: 10, z: 0 })).toBe("←");
        expect(commands.arrowTo(at, 0, { x: 0, z: -10 })).toBe("↓");
        // Looking north (yaw 180): north ahead, the point to the north-east ahead and right.
        expect(commands.arrowTo(at, 180, { x: 0, z: -10 })).toBe("↑");
        expect(commands.arrowTo(at, -180, { x: 10, z: -10 })).toBe("↗");
    });
});

describe("each kind's defaults", () => {
    it("pays by how hard, long and much work each kind is", () => {
        const first = (kind: catalog.EventKind) => catalog.newPreset(kind, kind).rewards.first;
        const diamonds = (kind: catalog.EventKind) =>
            first(kind).items.find((item) => item.id === "minecraft:diamond")?.count ?? 0;
        expect(diamonds("parkour")).toBeLessThan(diamonds("mining-rush"));
        expect(diamonds("trivia")).toBeLessThan(diamonds("blood-moon"));
        expect(diamonds("mining-rush")).toBeLessThan(diamonds("waves"));
        expect(diamonds("blood-moon")).toBeLessThan(diamonds("build-battle"));
        expect(first("supply-drop").items).toEqual([
            { id: "minecraft:experience_bottle", count: 12 }
        ]);
        expect(catalog.newPreset("happy-hour", "h").rewards.first).toEqual(catalog.NO_REWARD);
        for (const kind of catalog.EVENT_KINDS)
            expect(catalog.presetSchema.safeParse(catalog.newPreset(kind, kind)).success).toBe(
                true
            );
    });

    it("lasts what fits each kind", () => {
        expect(catalog.newPreset("parkour", "p").minutes).toBe(4);
        expect(catalog.newPreset("mining-rush", "m").minutes).toBe(5);
        expect(catalog.newPreset("supply-drop", "s").minutes).toBe(5);
        expect(catalog.runMinutes(catalog.newPreset("gathering", "g"))).toBe(6);
    });

    it("brings an event saved on the old defaults up to the new ones, once", () => {
        const old = {
            ...catalog.newPreset("mining-rush", "rush"),
            minutes: 10,
            rewards: catalog.OLD_DEFAULT_REWARDS
        };
        const mine = {
            ...catalog.newPreset("fishing", "fish"),
            minutes: 7,
            rewards: { ...catalog.OLD_DEFAULT_REWARDS, everyone: catalog.NO_REWARD }
        };
        const horde = { ...catalog.newPreset("waves", "w"), name: ["Horde", "defence"].join(" ") };
        const meteor = {
            ...catalog.newPreset("meteor-shower", "m"),
            options: { ...catalog.newPreset("meteor-shower", "m").options, meteors: 4, size: 6 }
        } as catalog.EventPreset;
        const stored = { presets: [old, mine, horde, meteor], settings: {} };
        const read = catalog.readEventsConfig({ [catalog.EVENTS_KEY]: stored });
        expect(read.presets[0]!.rewards).toEqual(catalog.DEFAULT_PRIZES["mining-rush"]);
        expect(read.presets[0]!.minutes).toBe(catalog.DEFAULT_MINUTES["mining-rush"]);
        // Changed by the operator: kept.
        expect(read.presets[1]!.rewards).toEqual(mine.rewards);
        expect(read.presets[1]!.minutes).toBe(7);
        expect(read.presets[2]!.name).toBe("Horde defense");
        expect(read.presets[3]!.options).toMatchObject({ meteors: 10, size: 4 });
        expect(read.settings.defaults).toBe(catalog.DEFAULTS_VERSION);
        // Saved from the screen, then set back to ten minutes on purpose: stays ten.
        const saved = {
            ...read,
            presets: [{ ...read.presets[0]!, minutes: 10, rewards: catalog.OLD_DEFAULT_REWARDS }]
        };
        const again = catalog.readEventsConfig({ [catalog.EVENTS_KEY]: saved });
        expect(again.presets[0]!.minutes).toBe(10);
        expect(again.presets[0]!.rewards).toEqual(catalog.OLD_DEFAULT_REWARDS);
    });
});

describe("a gathering in rounds", () => {
    it("draws a different material for every round while any is left", () => {
        const used: string[] = [];
        for (let round = 0; round < catalog.GATHER_MATERIALS.length; round += 1)
            used.push(gather.drawMaterial({ material: "random" }, () => 0, used));
        expect(new Set(used).size).toBe(catalog.GATHER_MATERIALS.length);
        // Every one used: any again.
        expect(catalog.GATHER_MATERIALS).toContain(
            gather.drawMaterial({ material: "random" }, () => 0, used)
        );
        expect(gather.drawMaterial({ material: "kelp" }, () => 0, ["kelp"])).toBe("kelp");
    });

    it("scores each round by what one of its material is worth, on top of the rounds before", () => {
        const setup = gather.gatheringSetup("iron_ingot", true);
        expect(setup).toContain("scoreboard objectives add pe_gtot dummy");
        expect(setup).toContain("scoreboard players set #worth pe_gk 12");
        // A later round keeps the points so far.
        const later = gather.gatheringSetup("sand", false);
        expect(later.some((line) => line.includes("pe_gtot"))).toBe(false);
        expect(later).toContain("scoreboard players set #worth pe_gk 1");
        const tick = gather.gatheringTick("logs");
        expect(tick).toContain(
            "execute as @a run scoreboard players operation @s pe_gpts *= #worth pe_gk"
        );
        expect(tick).toContain(
            "execute as @a[scores={pe_gsum=1..}] run scoreboard players operation @s pe_score = @s pe_gsum"
        );
        expect(gather.BANK_ROUND).toContain(
            "execute as @a run scoreboard players operation @s pe_gtot += @s pe_gpts"
        );
        // A minute of any material is worth about the same.
        for (const material of catalog.GATHER_MATERIALS)
            expect(gather.WORTH[material]).toBeGreaterThan(0);
        expect(gather.WORTH.iron_ingot).toBeGreaterThan(gather.WORTH.logs);
        expect(gather.WORTH.logs).toBeGreaterThan(gather.WORTH.cobblestone);
    });

    it("lasts its rounds, whatever its minutes say", () => {
        const game = {
            ...catalog.newPreset("gathering", "g"),
            minutes: 30,
            options: { material: "random", rounds: 4, roundMinutes: 3 }
        } as catalog.EventPreset;
        expect(catalog.runMinutes(game)).toBe(12);
    });
});

describe("a place that can be walked to", () => {
    const line = (count: number, wetFrom = -1, wetTo = -1, y = 64) =>
        Array.from({ length: count }, (_, index) => ({
            x: index * commands.PATH_STEP,
            y,
            z: 0,
            wet: index >= wetFrom && index <= wetTo
        }));
    const judge = (path: ReturnType<typeof line>, to = { y: 64 }) =>
        commands.walkable(
            { x: 0, z: 0 },
            path,
            path.filter((one) => one.wet),
            to
        );

    it("crosses a river but not the sea round an island", () => {
        expect(judge(line(20))).toBe(true);
        // Two markers on water: twelve blocks, a river.
        expect(judge(line(20, 5, 6))).toBe(true);
        // Five in a row: thirty blocks of sea.
        expect(judge(line(20, 5, 9))).toBe(false);
    });

    it("is never far above or below where the walk starts", () => {
        expect(judge(line(10), { y: 64 + commands.MAX_CLIMB })).toBe(true);
        expect(judge(line(10), { y: 176 })).toBe(false);
    });

    it("puts a marker on the ground every few blocks, both ends included", () => {
        const lines = commands.pathLines({ x: 0, z: 0 }, { x: 30, z: 0 });
        expect(lines[0]).toBe("kill @e[tag=pe_path]");
        expect(lines).toHaveLength(1 + 6);
        expect(lines.at(-1)).toContain(
            "positioned 30.5 0 0.5 positioned over motion_blocking_no_leaves run summon"
        );
        expect(lines.at(-1)).toContain('"pe_path"');
    });
});

describe("a treasure hunt's clock", () => {
    it("starts with its first chest down, while the rest are still hidden", () => {
        const preset = catalog.newPreset("treasure-hunt", "t");
        const run = { preset, place: null, meteors: [], round: -1, stage: null, readyAt: null };
        expect(catalog.readyToPlay({ ...run, hidden: false, chests: [] })).toBe(false);
        expect(catalog.readyToPlay({ ...run, hidden: false, chests: [{}] })).toBe(true);
    });
});

describe("the world an event holds", () => {
    it("sets midnight and clear weather for a horde, for its length in seconds and ticks", () => {
        const needs = catalog.worldNeeds({ kind: "waves" });
        expect(commands.worldLines(needs, 600)).toEqual([
            "time set 18000",
            "weather clear 660",
            "weather clear 660s"
        ]);
        expect(commands.worldRules(needs)).toEqual([
            ["doDaylightCycle", "advance_time"],
            ["doWeatherCycle", "advance_weather"]
        ]);
    });

    it("turns phantoms off with a held day", () => {
        expect(commands.worldRules(catalog.worldNeeds({ kind: "spleef" })).flat()).toContain(
            "doInsomnia"
        );
    });

    it("puts the time back at the end, and leaves alone an event that never held it", () => {
        const spleef = catalog.newPreset("spleef", "s");
        expect(commands.cleanup(spleef, null, null, {}, 1234)).toContain("time set 1234");
        const quiz = catalog.newPreset("trivia", "q");
        expect(commands.cleanup(quiz, null, null, {}, 1234)).not.toContain("time set 1234");
    });
});

describe("the top of a footprint, for what is built in the air", () => {
    it("reads every column, the edges included, a few blocks apart", () => {
        const columns = commands.footprintColumns({ x: 100, z: -50 }, 10);
        const xs = [...new Set(columns.map((one) => one.x))].sort((a, b) => a - b);
        expect(xs[0]).toBe(90);
        expect(xs.at(-1)).toBe(110);
        expect(xs.every((x, index) => index === 0 || x - xs[index - 1]! <= commands.TOP_STEP)).toBe(
            true
        );
        expect(columns).toHaveLength(xs.length * xs.length);
    });

    it("stands each marker on whatever is highest, roofs and crowns included", () => {
        const [clear, first] = commands.topLines([{ x: 3, z: -4 }]);
        expect(clear).toBe(commands.CLEAR_SAMPLES);
        expect(first).toContain("positioned 3.5 0 -3.5 positioned over motion_blocking run summon");
        expect(first).not.toContain("no_leaves");
    });

    it("takes the highest top read", () => {
        expect(commands.highestTop([{ y: 64 }, { y: 140 }, { y: 70 }])).toBe(140);
        expect(commands.highestTop([])).toBeNull();
    });
});

describe("a parkour course's traps", () => {
    const options = (difficulty: "easy" | "medium" | "hard") => ({
        place: { mode: "players" as const },
        jumps: 30,
        difficulty,
        height: 30
    });

    it("puts slime pads and vanishing platforms on plain jumps only, never two in a row", () => {
        let traps = 0;
        for (let seed = 0; seed < 20; seed += 1) {
            const course = parkour.course(options("hard"), `run-${seed}`, { x: 0, z: 0 }, 100);
            course.platforms.forEach((one, index) => {
                if (!one.trap) return;
                traps += 1;
                expect(one.role).toBe("jump");
                expect(course.platforms[index - 1]?.trap).toBeUndefined();
            });
            const blocks = course.boxes.map((box) => box.block);
            for (const one of course.vanishing) expect(blocks).toContain(one.block);
            for (const box of course.boxes) expect(stage.ARENA_BLOCKS).toContain(box.block);
        }
        expect(traps).toBeGreaterThan(20);
        // The easy course never vanishes from under anybody.
        for (let seed = 0; seed < 20; seed += 1)
            expect(
                parkour.course(options("easy"), `run-${seed}`, { x: 0, z: 0 }, 100).vanishing
            ).toEqual([]);
    });

    it("blinks: there most of the time, gone for two seconds in six, only into air and only its own", () => {
        let course = parkour.course(options("hard"), "run-1", { x: 0, z: 0 }, 100);
        for (let seed = 2; course.vanishing.length === 0; seed += 1)
            course = parkour.course(options("hard"), `run-${seed}`, { x: 0, z: 0 }, 100);
        const orange = (lines: string[]) =>
            lines.filter((line) => line.includes("orange_concrete"));
        const there = orange(parkour.blinkLines(course, 1_000));
        expect(there.every((line) => line.endsWith(" minecraft:orange_concrete keep"))).toBe(true);
        const gone = orange(parkour.blinkLines(course, parkour.BLINK_MS - 500));
        expect(
            gone.every((line) => line.endsWith(" minecraft:air replace minecraft:orange_concrete"))
        ).toBe(true);
        expect(there).toHaveLength(course.vanishing.length);
    });
});

describe("a parkour course's climbs, moving platforms and looks", () => {
    const course = (difficulty: "easy" | "medium" | "hard", seed: string, theme = "random") =>
        parkour.course(
            { place: { mode: "players" }, jumps: 40, difficulty, height: 30, theme } as never,
            seed,
            { x: 0, z: 0 },
            100
        );

    it("never builds two things in the same block, and keeps everything inside its volume", () => {
        for (let seed = 0; seed < 60; seed += 1)
            for (const difficulty of ["easy", "medium", "hard"] as const) {
                const one = course(difficulty, `run-${seed}`);
                const cells = new Set<string>();
                for (const box of one.boxes) {
                    expect(inside(box, one.volume)).toBe(true);
                    expect(stage.ARENA_BLOCKS).toContain(box.block);
                    for (let x = box.x1; x <= box.x2; x += 1)
                        for (let y = box.y1; y <= box.y2; y += 1)
                            for (let z = box.z1; z <= box.z2; z += 1) {
                                const key = `${x},${y},${z}`;
                                expect(cells.has(key)).toBe(false);
                                cells.add(key);
                            }
                }
            }
    });

    it("climbs three up a ladder or a vine hung on a column, put up after it and taken down first", () => {
        let climbs = 0;
        for (let seed = 0; seed < 40; seed += 1) {
            const one = course("medium", `climb-${seed}`, seed % 2 ? "jungle" : "classic");
            one.platforms.forEach((platform, index) => {
                if (!platform.climb) return;
                climbs += 1;
                expect(platform.y - one.platforms[index - 1]!.y).toBe(3);
            });
            const climbAt = one.boxes.findIndex((box) => /ladder|vine/.test(box.block));
            if (climbAt < 0) continue;
            const kind = seed % 2 ? "vine" : "ladder";
            expect(one.boxes[climbAt]!.block).toContain(kind);
            // Every column is built before any climb hangs on it.
            const lastColumn = one.boxes.reduce(
                (last, box, at) =>
                    box.y2 - box.y1 === 1 && !/ladder|vine/.test(box.block) ? at : last,
                -1
            );
            expect(lastColumn).toBeLessThan(climbAt);
        }
        expect(climbs).toBeGreaterThan(10);
    });

    it("moves a platform between two places a step apart, one there while the other is gone", () => {
        let one = course("hard", "shift-0");
        for (let seed = 1; one.shifting.length === 0; seed += 1)
            one = course("hard", `shift-${seed}`);
        const { a, b } = one.shifting[0]!;
        expect(a.z1 - b.z1).toBe(parkour.SHIFT_STEP);
        const early = parkour.blinkLines(one, 0);
        const later = parkour.blinkLines(one, parkour.SHIFT_MS);
        const fillOf = (box: typeof a) =>
            `fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2}`;
        expect(early).toContain(
            `execute in minecraft:overworld run ${fillOf(a)} minecraft:magenta_concrete keep`
        );
        expect(early).toContain(
            `execute in minecraft:overworld run ${fillOf(b)} minecraft:air replace minecraft:magenta_concrete`
        );
        expect(later).toContain(
            `execute in minecraft:overworld run ${fillOf(b)} minecraft:magenta_concrete keep`
        );
        expect(later).toContain(
            `execute in minecraft:overworld run ${fillOf(a)} minecraft:air replace minecraft:magenta_concrete`
        );
    });

    it("leaves a moving platform's other place two blocks of headroom, under nobody's feet", () => {
        let checked = 0;
        for (let seed = 0; seed < 200; seed += 1)
            for (const difficulty of ["medium", "hard"] as const) {
                const one = course(difficulty, `room-${seed}`);
                const cells = new Set<string>();
                for (const box of one.boxes)
                    for (let x = box.x1; x <= box.x2; x += 1)
                        for (let y = box.y1; y <= box.y2; y += 1)
                            for (let z = box.z1; z <= box.z2; z += 1) cells.add(`${x},${y},${z}`);
                for (const { b } of one.shifting) {
                    checked += 1;
                    for (let x = b.x1; x <= b.x2; x += 1)
                        for (let z = b.z1; z <= b.z2; z += 1)
                            for (const up of [1, 2, -1, -2])
                                expect(cells.has(`${x},${b.y1 + up},${z}`)).toBe(false);
                }
            }
        expect(checked).toBeGreaterThan(50);
    });

    it("lays a course placed before climbs and looks out the way it was then", () => {
        const legacy = (seed: string) =>
            parkour.course(
                { place: { mode: "players" }, jumps: 40, difficulty: "hard", height: 30 } as never,
                seed,
                { x: 0, z: 0 },
                100,
                1
            );
        let changed = 0;
        for (let seed = 0; seed < 30; seed += 1) {
            const old = legacy(`old-${seed}`);
            expect(old.theme).toBe("classic");
            expect(old.shifting).toEqual([]);
            expect(
                old.platforms.some((platform) => platform.climb || platform.trap === "shift")
            ).toBe(false);
            expect(
                old.boxes.some((box) => /lantern|glowstone|ladder|vine|quartz/.test(box.block))
            ).toBe(false);
            const now = course("hard", `old-${seed}`);
            if (JSON.stringify(now.platforms) !== JSON.stringify(old.platforms)) changed += 1;
        }
        expect(changed).toBeGreaterThan(0);
        expect(stage.EMPTY_STAGE.design).toBe(1);
        expect(parkour.DESIGN).toBe(4);
    });

    it("draws one of four looks for a run, or the one chosen, keeping checkpoints lime", () => {
        const looks = new Set(
            Array.from({ length: 40 }, (_, seed) => course("easy", `look-${seed}`).theme)
        );
        expect([...looks].sort()).toEqual(["classic", "frost", "jungle", "nether"]);
        const frost = course("easy", "x", "frost");
        expect(frost.theme).toBe("frost");
        expect(frost.boxes.some((box) => box.block === "minecraft:packed_ice")).toBe(true);
        expect(frost.boxes.some((box) => box.block === "minecraft:lime_concrete")).toBe(true);
    });
});
