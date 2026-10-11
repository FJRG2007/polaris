/**
 * Variables in a kept console command.
 *
 * Pinned: only names Polaris knows, or that the command declares, are ever
 * replaced, so SNBT braces go out exactly as typed; `{player}` becomes one line
 * per player; a typed value is normalized and checked by one schema, and
 * nothing in it can end the command it sits in or start another.
 */

import { describe, expect, it } from "vitest";
import {
    commandLines,
    commandUses,
    consoleVariables,
    customVariablesProblem,
    fillCommand,
    hasVariables,
    needsAsking,
    normalizeCustomVariable,
    readCustomVariables,
    runTargetSchema,
    valueProblem,
    valuesSchema,
    type CustomVariable,
    type FillValues
} from "@polaris-app/game-servers/src/lib/console-vars";
import { english } from "../setup/game-english";

const HORSE =
    "execute at {player} run summon minecraft:skeleton_horse ~5 ~ ~ {SkeletonTrap:1b,TrapTime:0}";

const fill = (patch: Partial<FillValues> = {}): FillValues => ({
    edition: "java",
    custom: [],
    values: {},
    server: {},
    ...patch
});

const declared = (
    name: string,
    type: CustomVariable["type"] = "text",
    initial = ""
): CustomVariable => normalizeCustomVariable({ name, type, initial });

const someone = (name: string) => ({ name, values: {} });

describe("the skeleton horse", () => {
    it("is written once per player, with the SNBT left exactly as typed", () => {
        expect(commandLines(HORSE, fill(), [someone("Steve"), someone("Alex")])).toEqual([
            "execute at Steve run summon minecraft:skeleton_horse ~5 ~ ~ {SkeletonTrap:1b,TrapTime:0}",
            "execute at Alex run summon minecraft:skeleton_horse ~5 ~ ~ {SkeletonTrap:1b,TrapTime:0}"
        ]);
    });

    it("asks who it is for, and needs the server to fill it in", () => {
        expect(needsAsking(HORSE, "java", [])).toBe(true);
        expect(hasVariables(HORSE, "java", [])).toBe(true);
        expect(commandUses(HORSE, "java", []).perPlayer).toBe(true);
    });

    it("is sent as typed on a game that has no {player}", () => {
        expect(hasVariables(HORSE, null, [])).toBe(false);
        expect(commandLines(HORSE, fill({ edition: null }), [])).toEqual([HORSE]);
    });
});

describe("what is replaced", () => {
    it("leaves a brace that names nothing known alone", () => {
        const command = "summon minecraft:zombie ~ ~ ~ {NoAI} {mob}";
        expect(fillCommand(command, fill(), null)).toBe(command);
    });

    it("fills a declared variable, in any case, and quotes a Bedrock name with a space", () => {
        const custom = [declared("mob"), declared("who", "player")];
        const filled = fillCommand(
            "summon {MOB} ~ ~ ~ {Tags:[x]} run {who}",
            fill({ custom, values: { mob: "minecraft:creeper", who: "Big Bob" } }),
            null
        );
        expect(filled).toBe('summon minecraft:creeper ~ ~ ~ {Tags:[x]} run "Big Bob"');
    });

    it("writes the server's values and takes out anything that could break the command", () => {
        expect(
            fillCommand(
                'say {server.name} has {server.online} - "{death.message}"',
                fill({
                    server: {
                        "server.name": "Survival",
                        "server.online": "3",
                        "death.message": 'Steve "fell"\nop Eve'
                    }
                }),
                null
            )
        ).toBe('say Survival has 3 - "Steve fellop Eve"');
    });

    it("uses the fallback when the server has no value", () => {
        expect(fillCommand('say {death.player | "Nobody"}', fill(), null)).toBe("say Nobody");
    });

    it("does not offer what a command cannot carry", () => {
        const java = consoleVariables("java").map((spec) => spec.name);
        expect(java).toContain("player");
        expect(java).toContain("server.online");
        expect(java).not.toContain("player.level");
        expect(java).not.toContain("server.levels");
        expect(java).not.toContain("rank.level");
        expect(consoleVariables("bedrock").map((spec) => spec.name)).not.toContain("death.player");
        expect(consoleVariables(null)).toEqual([]);
    });

    it("leaves a name a command cannot aim at out of a per-player run", () => {
        expect(
            commandLines("kill {player}", fill(), [someone("Steve"), someone("bad;name")])
        ).toEqual(["kill Steve"]);
    });
});

describe("a typed value", () => {
    const schema = valuesSchema([
        declared("amount", "number"),
        declared("item", "item"),
        declared("msg")
    ]);

    it("is normalized before it is checked", () => {
        expect(
            schema.parse({ amount: " 5 ", item: " Minecraft:Diamond ", msg: " hi there " })
        ).toEqual({
            amount: "5",
            item: "minecraft:diamond",
            msg: "hi there"
        });
    });

    it("cannot carry a line break, an escaped one, a quote or a bracket", () => {
        for (const bad of ["a\nop Eve", "a\\nop Eve", 'a"b', "a'b", "a{b}", "a[b]", "tab\there"]) {
            expect(english(valueProblem("text", bad)), bad).toBe(
                "No quotes, backslashes, brackets or line breaks"
            );
        }
    });

    it("is bounded, and empty is required", () => {
        expect(english(valueProblem("text", "x".repeat(101)))).toBe("100 characters at most");
        expect(english(valueProblem("text", ""))).toBe("Fill this in");
    });

    it("is checked against its type", () => {
        expect(english(valueProblem("number", "five"))).toBe("A number, like 5 or 2.5");
        expect(valueProblem("number", "-2.5")).toBeNull();
        expect(english(valueProblem("item", "diamond sword"))).toBe(
            "An item id, like minecraft:diamond"
        );
        expect(valueProblem("item", "minecraft:diamond_sword")).toBeNull();
        expect(english(valueProblem("player", "a;b"))).toBe(
            "A player name: letters, numbers and _"
        );
    });

    it("takes nothing that was not declared", () => {
        expect(schema.safeParse({ amount: "1", item: "stone", msg: "x", extra: "y" }).success).toBe(
            false
        );
    });

    it("names the player a run is for by the same rule", () => {
        expect(runTargetSchema.safeParse({ every: true }).success).toBe(true);
        expect(runTargetSchema.safeParse({ player: " Steve " })).toEqual({
            success: true,
            data: { player: "Steve" }
        });
        expect(runTargetSchema.safeParse({ player: "Steve\nop Eve" }).success).toBe(false);
    });
});

describe("declaring a variable", () => {
    const amount = declared("{Amount}", "number", "8");

    it("is stored lowercase, without braces, named after itself when unlabelled", () => {
        expect(amount).toEqual({ name: "amount", label: "amount", type: "number", initial: "8" });
    });

    it("must be in the command, once, and not a Polaris name", () => {
        expect(customVariablesProblem("give {player} bread {amount}", [amount])).toBeNull();
        expect(english(customVariablesProblem("give {player} bread 8", [amount]))).toBe(
            "amount is not in the command. Use it or remove it."
        );
        expect(english(customVariablesProblem("{amount}", [amount, amount]))).toBe(
            "amount is there twice"
        );
        expect(english(customVariablesProblem("{player}", [declared("player")]))).toBe(
            "player is already a Polaris variable"
        );
        expect(english(customVariablesProblem("{2x}", [declared("2x")]))).toBe(
            "Names use lowercase letters, numbers and _, and start with a letter"
        );
    });

    it("refuses a default its type would refuse", () => {
        expect(
            english(customVariablesProblem("{amount}", [declared("amount", "number", "lots")]))
        ).toBe("A number, like 5 or 2.5");
    });

    it("reads back what was stored, and drops what it cannot read", () => {
        expect(
            readCustomVariables([amount, { name: 3 }, { name: "x", type: "colour" }, null])
        ).toEqual([amount]);
        expect(readCustomVariables("nope")).toEqual([]);
    });
});
